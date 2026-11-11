import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { RunOptions, Job, JobContainer } from '../types';
import {
  substituteExpressions,
  substituteRecord,
  ExpressionContext
} from './expression';
import {
  resolveContainerRuntime,
  ContainerRuntime,
  ContainerStartOptions,
  CONTAINER_WORKDIR,
  registryOf
} from './container-runtime';
import { JobRuntime } from './job-runtime';
import { splitArgs } from './shell';
import {
  splitReservedOptions,
  unsafeServiceOptions,
  unsafeServiceVolumeReason
} from './container-policy';

/**
 * `jobs.<id>.container.options` the CLI sets on the job container itself:
 * it idles with its own entrypoint and steps run in the mounted workspace.
 */
const JOB_CONTAINER_RESERVED = new Set(['--entrypoint', '--workdir', '-w']);
/** Also reserved when `--container-memory-limit` caps the job container. */
const MEMORY_OPTIONS = ['--memory', '-m', '--memory-swap'];

/**
 * Image for jobs whose `runs-on` has no image mapping. Runner-like (Node.js,
 * git, curl and common tools), as used by nektos/act.
 */
export const DEFAULT_CONTAINER_IMAGE = 'catthehacker/ubuntu:act-22.04';

/** Built-in `runs-on` label -> image mapping, extended by `runner-images`. */
export const DEFAULT_RUNNER_IMAGES: Record<string, string> = {
  'ubuntu-latest': 'catthehacker/ubuntu:act-latest',
  'ubuntu-24.04': 'catthehacker/ubuntu:act-24.04',
  'ubuntu-22.04': 'catthehacker/ubuntu:act-22.04',
  'ubuntu-20.04': 'catthehacker/ubuntu:act-20.04'
};

const activeContainers = new Set<{ runtime: ContainerRuntime; id: string }>();

const activeNetworks = new Set<{ runtime: ContainerRuntime; name: string }>();

let containerCleanupInstalled = false;

/**
 * Make sure job containers are removed if the CLI exits early (Ctrl-C,
 * SIGTERM, or an exit that skips the normal per-job cleanup).
 */
export function installContainerCleanup(): void {
  if (containerCleanupInstalled) return;
  containerCleanupInstalled = true;

  const cleanup = (): void => {
    for (const container of activeContainers) {
      container.runtime.stopSync(container.id);
    }
    activeContainers.clear();
    for (const network of activeNetworks) {
      network.runtime.removeNetworkSync(network.name);
    }
    activeNetworks.clear();
  };

  process.once('exit', cleanup);
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  }
}

/** Why a run can't start without its container runtime, and what to do. */
export function noRuntimeMessage(preference: string): string {
  const which =
    preference === 'auto'
      ? 'docker, podman or containerd (nerdctl)'
      : `"${preference}"`;
  return `No container runtime available: ${which} is not installed or not running. Start it, pick another with --container-runtime, or run steps directly on this machine, with your user's privileges, with --container-runtime host.`;
}

/**
 * Start the job's container when container isolation is on, using
 * `jobs.<id>.container` if set, else the image for its `runs-on`. Returns
 * false (the job then fails) when the runtime is unavailable or the
 * container can't be started; steps never fall back to the host.
 */
export async function startJobContainer(
  job: Job | undefined,
  ctx: ExpressionContext,
  options: RunOptions,
  runtime: JobRuntime,
  runDir: string
): Promise<boolean> {
  const preference = options.containerRuntime ?? 'host';
  const spec =
    typeof job?.container === 'string'
      ? { image: job.container }
      : job?.container;

  if (preference === 'host') {
    if (spec) {
      logger.warn(
        `Ignoring jobs.<id>.container (${spec.image}): container runtime is "host", running on the host.`
      );
    }
    return true;
  }

  const containerRuntime = await resolveContainerRuntime(preference);
  if (!containerRuntime) {
    logger.error(noRuntimeMessage(preference));
    return false;
  }

  // `container: ${{ inputs.image || null }}` that comes out empty means no
  // container image, as on GitHub: use the image for runs-on.
  const specImage = spec?.image
    ? substituteExpressions(spec.image, ctx).trim()
    : '';
  const image =
    specImage ||
    options.containerImage ||
    runnerImage(job?.['runs-on'], ctx, options);
  const containerEnv = substituteRecord(
    specImage && spec && 'env' in spec ? spec.env : undefined,
    ctx
  );
  const extras =
    specImage && spec
      ? jobContainerExtras(spec, ctx, options, runtime.workspace)
      : {};
  if (!extras) return false;
  if (
    specImage &&
    spec &&
    !(await pullWithCredentials(
      `jobs.${ctx.github.job ?? '<id>'}.container`,
      image,
      spec.credentials,
      ctx,
      options,
      containerRuntime
    ))
  ) {
    return false;
  }
  const exchangeDir = fs.mkdtempSync(path.join(runDir, 'container-'));
  fs.chmodSync(exchangeDir, 0o777);
  fs.copyFileSync(runtime.eventPath, path.join(exchangeDir, 'event.json'));

  logger.info(`Starting job container: ${image} (${containerRuntime.name})`);
  const started = await containerRuntime.start({
    image,
    workingDir: runtime.workspace,
    readOnlyPaths: protectedWorkspacePaths(options),
    exchangeDir,
    env: containerEnv,
    memoryLimit: options.containerMemoryLimit,
    networkDisabled: options.networkDisabled === true,
    network: runtime.services?.network,
    ...extras
  });

  if (!started.success || !started.id) {
    logger.error(`Failed to start job container (${image}): ${started.error}`);
    return false;
  }

  const bashProbe = await containerRuntime.exec(started.id, {
    command: 'command -v bash'
  });

  runtime.container = {
    runtime: containerRuntime,
    id: started.id,
    image,
    exchangeDir,
    bash: bashProbe.success,
    actionDirs: new Map()
  };
  installContainerCleanup();
  activeContainers.add(runtime.container);
  return true;
}

/**
 * The `options`, `ports` and `volumes` of `jobs.<id>.container`, checked
 * with the same policy as service containers: options and host mounts that
 * would reach this machine are refused (undefined: the job fails), options
 * the CLI sets itself are dropped with a warning.
 */
function jobContainerExtras(
  spec: JobContainer,
  ctx: ExpressionContext,
  options: RunOptions,
  workspace: string
): Pick<ContainerStartOptions, 'extraArgs' | 'ports' | 'volumes'> | undefined {
  const label = `jobs.${ctx.github.job ?? '<id>'}.container`;
  const args = spec.options
    ? splitArgs(substituteExpressions(spec.options, ctx))
    : [];
  const unsafe = unsafeServiceOptions(args);
  if (unsafe.length > 0) {
    logger.error(
      `${label}: refusing unsafe options ${[...new Set(unsafe)].join(', ')}: they would give the container access to this machine.`
    );
    return undefined;
  }
  const reserved = new Set([
    ...JOB_CONTAINER_RESERVED,
    ...(options.containerMemoryLimit ? MEMORY_OPTIONS : [])
  ]);
  const { kept, dropped } = splitReservedOptions(args, reserved);
  if (dropped.length > 0) {
    logger.warn(
      `${label}: ignoring options the CLI sets itself: ${[...new Set(dropped)].join(', ')}.`
    );
  }
  const volumes = (spec.volumes ?? []).map((v) =>
    substituteExpressions(v, ctx)
  );
  for (const volume of volumes) {
    const reason = unsafeServiceVolumeReason(volume, workspace);
    if (reason) {
      logger.error(`${label}: ${reason}.`);
      return undefined;
    }
  }
  return {
    extraArgs: kept,
    ports: (spec.ports ?? []).map((port) =>
      substituteExpressions(String(port), ctx)
    ),
    volumes
  };
}

/**
 * `credentials:` of a job or service container. Without --registry-login
 * they're only warned about. With it, the image is pulled with them first
 * (a private, temporary login: see ContainerRuntime.pull), and the
 * password is masked in the logs. False (the job fails) when they're
 * incomplete or the pull fails.
 */
async function pullWithCredentials(
  label: string,
  image: string,
  credentials: Record<string, string> | undefined,
  ctx: ExpressionContext,
  options: RunOptions,
  runtime: ContainerRuntime
): Promise<boolean> {
  if (!credentials) return true;
  if (!options.registryLogin) {
    logger.warn(
      `${label}: credentials are ignored; pass --registry-login to log in for this run, or log in with \`docker login\`.`
    );
    return true;
  }
  const username = substituteExpressions(
    String(credentials.username ?? ''),
    ctx
  ).trim();
  const password = substituteExpressions(
    String(credentials.password ?? ''),
    ctx
  );
  logger.registerSecrets({ password });
  if (!username || !password) {
    logger.error(`${label}: credentials need a username and a password.`);
    return false;
  }
  const registry = registryOf(image);
  logger.info(`${label}: pulling ${image} with credentials for ${registry}`);
  const pulled = await runtime.pull(image, { registry, username, password });
  if (!pulled.success) {
    logger.error(`${label}: couldn't pull ${image}: ${pulled.error}`);
    return false;
  }
  return true;
}

/**
 * The image for a job's `runs-on`: the first label with a mapping in
 * `runner-images` (or the built-in one), else the default image, with a
 * warning for labels that have no mapping.
 */
export function runnerImage(
  runsOn: Job['runs-on'],
  ctx: ExpressionContext,
  options: RunOptions
): string {
  const fallback = options.defaultContainerImage || DEFAULT_CONTAINER_IMAGE;
  const raw: unknown = runsOn;
  const labels = (
    Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object'
        ? [(raw as { labels?: unknown }).labels ?? []].flat()
        : [raw]
  )
    .filter((label): label is string => typeof label === 'string')
    .map((label) => substituteExpressions(label, ctx));
  if (labels.length === 0) return fallback;

  const mapping = { ...DEFAULT_RUNNER_IMAGES, ...options.runnerImages };
  for (const label of labels) {
    if (mapping[label]) return mapping[label];
  }

  const shown = labels.join(', ');
  if (labels.some((label) => /windows|macos/i.test(label))) {
    logger.warn(
      `runs-on "${shown}": only Linux containers are supported; running in ${fallback}.`
    );
  } else {
    logger.warn(
      `runs-on "${shown}" has no image mapping; using ${fallback} (map it with runner-images in ~/.secureci/config.yml).`
    );
  }
  return fallback;
}

/**
 * Empty a job's --isolate-workspace copy from inside its container, as
 * root, before the container is stopped: files a step created as root
 * (rootful engines) can't always be removed by the host user afterwards.
 * Removing them from inside works with rootful and rootless engines alike
 * (a chown back would map to a subordinate uid when rootless). `.git` is
 * mounted read-only, so it's left for the host to remove. Only ever call
 * this for an isolated copy, never for the user's working copy.
 */
export async function clearIsolatedWorkspace(
  runtime: JobRuntime
): Promise<void> {
  const container = runtime.container;
  if (!container) return;
  const result = await container.runtime.exec(container.id, {
    args: [
      'find',
      CONTAINER_WORKDIR,
      '-mindepth',
      '1',
      '-maxdepth',
      '1',
      '!',
      '-name',
      '.git',
      '-exec',
      'rm',
      '-rf',
      '--',
      '{}',
      '+'
    ],
    user: '0',
    workingDir: '/'
  });
  if (!result.success) {
    logger.debug(
      `Couldn't empty the workspace copy in the job container: ${result.stderr.trim()}`
    );
  }
}

/**
 * Remove `containerPath` from inside the job's container, as root, so a
 * copy holding files a step created as root can then be removed on the
 * host. No-op without a container.
 */
export async function removeInContainer(
  runtime: JobRuntime,
  containerPath: string
): Promise<void> {
  const container = runtime.container;
  if (!container) return;
  await container.runtime.exec(container.id, {
    args: ['rm', '-rf', '--', containerPath],
    user: '0',
    workingDir: '/'
  });
}

export async function stopJobContainer(runtime: JobRuntime): Promise<void> {
  const container = runtime.container;
  if (container) {
    activeContainers.delete(container);
    runtime.container = undefined;
    await container.runtime.stop(container.id);
  }
  await stopJobServices(runtime);
}

/** How long services may take to report healthy. */
const SERVICE_HEALTH_TIMEOUT_MS = 5 * 60 * 1000;

const SERVICE_HEALTH_POLL_MS = 1000;

/**
 * Start `jobs.<id>.services`, before the job container. In container
 * mode, services join a per-job network under their service id (so steps
 * reach `postgres:5432`), and the job container joins it too; on the host,
 * they're reached through their published `ports` on localhost. Waits
 * for health checks, and exposes `job.services.<id>.{id,network,ports}`.
 * Returns false (after cleaning up) if a service can't be started.
 */
export async function startJobServices(
  job: Job,
  ctx: ExpressionContext,
  options: RunOptions,
  runtime: JobRuntime
): Promise<boolean> {
  const specs = Object.entries(job.services ?? {});
  if (specs.length === 0) return true;

  const preference = options.containerRuntime ?? 'host';
  const jobRuntime =
    preference === 'host' ? null : await resolveContainerRuntime(preference);
  const containerRuntime =
    jobRuntime ?? (await resolveContainerRuntime('auto'));
  if (!containerRuntime) {
    logger.error(
      'jobs.<id>.services need a container runtime (docker, podman or containerd), but none is available.'
    );
    return false;
  }
  if (jobRuntime && options.networkDisabled) {
    logger.error(
      'jobs.<id>.services need networking, but container networking is disabled (--no-network).'
    );
    return false;
  }

  const services: NonNullable<JobRuntime['services']> = {
    runtime: containerRuntime,
    ids: []
  };
  runtime.services = services;
  installContainerCleanup();
  if (jobRuntime) {
    const network = `secureci-${crypto.randomBytes(6).toString('hex')}`;
    if (!(await containerRuntime.createNetwork(network))) {
      logger.error(`Failed to create the job network ${network}`);
      return false;
    }
    services.network = network;
    activeNetworks.add({ runtime: containerRuntime, name: network });
  }

  const contexts: Record<string, unknown> = {};
  for (const [serviceId, spec] of specs) {
    const service = typeof spec === 'string' ? { image: spec } : spec;
    const extraArgs = service.options
      ? splitArgs(substituteExpressions(service.options, ctx))
      : [];
    const volumes = (service.volumes ?? []).map((v) =>
      substituteExpressions(v, ctx)
    );
    const unsafe = unsafeServiceOptions(extraArgs);
    if (unsafe.length > 0) {
      logger.error(
        `services.${serviceId}: refusing unsafe options ${[...new Set(unsafe)].join(', ')}: they would give the container access to this machine.`
      );
      return false;
    }
    for (const volume of volumes) {
      const reason = unsafeServiceVolumeReason(volume, runtime.workspace);
      if (reason) {
        logger.error(`services.${serviceId}: ${reason}.`);
        return false;
      }
    }
    const image = substituteExpressions(service.image, ctx);
    if (
      !(await pullWithCredentials(
        `services.${serviceId}`,
        image,
        service.credentials,
        ctx,
        options,
        containerRuntime
      ))
    ) {
      return false;
    }
    logger.info(`Starting service ${serviceId}: ${image}`);
    const started = await containerRuntime.start({
      image,
      service: true,
      ...(services.network
        ? { network: services.network, networkAlias: serviceId }
        : {}),
      ports: (service.ports ?? []).map((port) =>
        substituteExpressions(String(port), ctx)
      ),
      volumes,
      extraArgs,
      env: substituteRecord(service.env, ctx)
    });
    if (!started.success || !started.id) {
      logger.error(
        `Failed to start service ${serviceId} (${image}): ${started.error}`
      );
      return false;
    }
    services.ids.push(started.id);
    activeContainers.add({ runtime: containerRuntime, id: started.id });

    const deadline = Date.now() + SERVICE_HEALTH_TIMEOUT_MS;
    for (;;) {
      const health = await containerRuntime.health(started.id);
      if (health === 'healthy' || health === 'none') break;
      if (health === 'unhealthy' || Date.now() > deadline) {
        logger.error(`Service ${serviceId} is not healthy (${health}).`);
        return false;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, SERVICE_HEALTH_POLL_MS)
      );
    }

    contexts[serviceId] = {
      id: started.id,
      network: services.network ?? '',
      ports: await containerRuntime.ports(started.id)
    };
  }
  ctx.job = { ...ctx.job, services: contexts };
  return true;
}

/** Remove the job's service containers and network. */
export async function stopJobServices(runtime: JobRuntime): Promise<void> {
  const services = runtime.services;
  if (!services) return;
  runtime.services = undefined;
  for (const id of services.ids) {
    for (const entry of activeContainers) {
      if (entry.id === id) activeContainers.delete(entry);
    }
    await services.runtime.stop(id);
  }
  if (services.network) {
    for (const entry of activeNetworks) {
      if (entry.name === services.network) activeNetworks.delete(entry);
    }
    await services.runtime.removeNetwork(services.network);
  }
}

/**
 * Workspace paths mounted read-only into containers: the working copy's
 * `.git`, so a step can't plant hooks or config that run on the host. Not
 * with --no-local-checkout, where the real actions/checkout manages it.
 */
export function protectedWorkspacePaths(options: RunOptions): string[] {
  return options.localCheckout === false ? [] : ['.git'];
}
