import {
  exec,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams
} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Pluggable container runtime support for isolating `run:` steps.
 *
 * Docker, Podman, and containerd (via its Docker-CLI-compatible front-end,
 * `nerdctl`) all expose (near-)identical CLI surfaces (`<bin> run --rm -v
 * ... -e ... <image> sh -c "<command>"`), so a single CLI-based
 * implementation covers all three engines without any extra npm
 * dependency — in line with this project's minimal-dependency philosophy.
 */

export type ContainerRuntimeName = 'docker' | 'podman' | 'containerd';
export type ContainerRuntimePreference =
  'auto' | 'docker' | 'podman' | 'containerd' | 'none';

/** The CLI binary invoked for each runtime. `containerd` has no Docker-CLI-
 * compatible binary of its own, so `nerdctl` is used as its front-end. */
const RUNTIME_BINARIES: Record<ContainerRuntimeName, string> = {
  docker: 'docker',
  podman: 'podman',
  containerd: 'nerdctl'
};

export interface ContainerExecOptions {
  image: string;
  /**
   * Shell command string, run via `sh -c "<command>"`. Ignored if `args` is
   * provided instead (used for Docker-type actions, which pass discrete
   * argv entries to the image's entrypoint rather than a shell string).
   */
  command?: string;
  /**
   * Discrete argv entries passed to the container's (possibly overridden)
   * entrypoint, for Docker-type actions' `runs.args`. Takes precedence over
   * `command` when set.
   */
  args?: string[];
  /** Overrides the image's default entrypoint, for `runs.entrypoint`. */
  entrypoint?: string;
  /** Host directory mounted as the container's working directory. */
  workingDir: string;
  /** Host directory mounted read-write for exchanging $GITHUB_OUTPUT etc. */
  exchangeDir: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  memoryLimit?: string;
  networkDisabled?: boolean;
}

export interface ContainerBuildResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ContainerExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Options for starting a long-lived container: a job container (idles
 * until stopped, with the workspace mounted) or, with `service`, a service
 * container running its image's own entrypoint.
 */
export interface ContainerStartOptions {
  image: string;
  /** Host directory mounted as the container's working directory. */
  workingDir?: string;
  /** Host directory mounted read-write for exchanging file commands etc. */
  exchangeDir?: string;
  env?: Record<string, string>;
  memoryLimit?: string;
  /** Disable container networking. Default: false (network on). */
  networkDisabled?: boolean;
  /** Run the image's own entrypoint/command instead of idling. */
  service?: boolean;
  /** User-defined network to join, and the hostname to have on it. */
  network?: string;
  networkAlias?: string;
  /** `-p` port specs (`5432`, `8080:80`). */
  ports?: string[];
  /** `-v` volume specs. */
  volumes?: string[];
  /** Further `run` arguments (e.g. `jobs.<id>.services.<id>.options`). */
  extraArgs?: string[];
}

export interface ContainerStartResult {
  success: boolean;
  id?: string;
  error?: string;
}

/** Options for running a command inside an already-started container. */
export interface ContainerExecInOptions {
  /** Shell command string, run via `sh -c "<command>"`. */
  command?: string;
  /**
   * Discrete argv to exec directly, without a shell. Takes precedence over
   * `command`; needed when env names aren't valid shell identifiers (e.g.
   * `INPUT_WHO-TO-GREET`), which `sh` drops before exec'ing its child.
   */
  args?: string[];
  env?: Record<string, string>;
  /** Path inside the container. Default: the mounted workspace. */
  workingDir?: string;
  timeoutMs?: number;
}

export interface ContainerRuntime {
  readonly name: ContainerRuntimeName;
  isAvailable(): Promise<boolean>;
  /** One-shot `run --rm`, used for Docker-type actions. */
  execute(options: ContainerExecOptions): Promise<ContainerExecResult>;
  /** Start a detached container that idles until stopped (one per job). */
  start(options: ContainerStartOptions): Promise<ContainerStartResult>;
  /** Run a shell command in a container started via `start`. */
  exec(
    id: string,
    options: ContainerExecInOptions
  ): Promise<ContainerExecResult>;
  /** Force-remove a container started via `start`. */
  stop(id: string): Promise<void>;
  /** Synchronous `stop`, for signal/exit handlers. */
  stopSync(id: string): void;
  /** Create a user-defined network; false if it couldn't be created. */
  createNetwork(name: string): Promise<boolean>;
  removeNetwork(name: string): Promise<void>;
  /** Synchronous `removeNetwork`, for signal/exit handlers. */
  removeNetworkSync(name: string): void;
  /** `cp` between a container and the host; false if it failed. */
  copyFrom(
    id: string,
    containerPath: string,
    hostPath: string
  ): Promise<boolean>;
  copyTo(id: string, hostPath: string, containerPath: string): Promise<boolean>;
  /** Health status: healthy, unhealthy, starting, or none (no check). */
  health(id: string): Promise<string>;
  /** Published ports: container port -> host port. */
  ports(id: string): Promise<Record<string, string>>;
  /** Build an image from a Dockerfile directory, for Docker-type actions. */
  build(
    contextDir: string,
    tag: string,
    dockerfile?: string
  ): Promise<ContainerBuildResult>;
}

export const CONTAINER_WORKDIR = '/secureci-workspace';
export const CONTAINER_EXCHANGE_DIR = '/secureci-exchange';

/**
 * How a step's env reaches the container without its values appearing in
 * the client's argv, where any local user can read them (`ps`,
 * `/proc/<pid>/cmdline`).
 */
interface EnvTransport {
  args: string[];
  /** Environment for the client process, when some values travel in it. */
  clientEnv?: NodeJS.ProcessEnv;
  /** Remove the env file; call once the client has exited. */
  cleanup(): void;
}

/**
 * Whether a variable can go in an `--env-file` verbatim. Env files are
 * line-based, and podman strips quotes from and trims values, so anything
 * multi-line, quote-leading or whitespace-padded is passed another way.
 */
function fitsEnvFile(key: string, value: string): boolean {
  return (
    !/[\s#]/.test(key) &&
    !/[\r\n]/.test(value) &&
    !/^["']/.test(value) &&
    value === value.trim()
  );
}

/**
 * Build the env arguments for `run` / `exec`. Plain values go in an env file
 * (mode 0600, in a private temp dir) passed with `--env-file`. The rest are
 * passed as `-e KEY` with the value in the client's environment; only those
 * keys are added to it, so a `PATH` or `HOME` meant for the container
 * doesn't change how the client itself runs.
 */
function envTransport(env: Record<string, string> = {}): EnvTransport {
  const fileLines: string[] = [];
  const viaClient: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (fitsEnvFile(key, value)) fileLines.push(`${key}=${value}\n`);
    else viaClient[key] = value;
  }

  const args: string[] = [];
  let dir: string | undefined;
  if (fileLines.length > 0) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-env-'));
    const file = path.join(dir, 'env');
    fs.writeFileSync(file, fileLines.join(''), { mode: 0o600 });
    args.push('--env-file', file);
  }
  const clientKeys = Object.keys(viaClient);
  for (const key of clientKeys) args.push('-e', key);

  return {
    args,
    clientEnv:
      clientKeys.length > 0 ? { ...process.env, ...viaClient } : undefined,
    cleanup: () => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Probe timeout for `<bin> version` availability checks. */
const PROBE_TIMEOUT_MS = 3000;

class CliContainerRuntime implements ContainerRuntime {
  private availableCache: boolean | undefined;
  private readonly binary: string;

  constructor(public readonly name: ContainerRuntimeName) {
    this.binary = RUNTIME_BINARIES[name];
  }

  async isAvailable(): Promise<boolean> {
    if (this.availableCache !== undefined) return this.availableCache;

    try {
      // Plain `version` (no --format) to stay compatible across engines
      // (nerdctl's version output format differs from docker/podman's);
      // we only care whether the daemon responds, not the output.
      await execAsync(`${this.binary} version`, {
        timeout: PROBE_TIMEOUT_MS
      });
      this.availableCache = true;
    } catch {
      this.availableCache = false;
    }

    return this.availableCache;
  }

  execute(options: ContainerExecOptions): Promise<ContainerExecResult> {
    const args = [
      'run',
      '--rm',
      '-w',
      CONTAINER_WORKDIR,
      '-v',
      `${options.workingDir}:${CONTAINER_WORKDIR}`,
      '-v',
      `${options.exchangeDir}:${CONTAINER_EXCHANGE_DIR}`
    ];

    if (options.networkDisabled === true) {
      args.push('--network', 'none');
    }

    if (options.memoryLimit) {
      args.push('--memory', options.memoryLimit);
    }

    if (options.entrypoint) {
      args.push('--entrypoint', options.entrypoint);
    }

    const env = envTransport(options.env);
    args.push(...env.args);

    args.push(options.image);
    if (options.args) {
      args.push(...options.args);
    } else {
      args.push('sh', '-c', options.command || '');
    }

    return this.runCli(args, options.timeoutMs, env);
  }

  start(options: ContainerStartOptions): Promise<ContainerStartResult> {
    const args = ['run', '-d'];
    if (options.workingDir) {
      args.push(
        '-w',
        CONTAINER_WORKDIR,
        '-v',
        `${options.workingDir}:${CONTAINER_WORKDIR}`
      );
    }
    if (options.exchangeDir) {
      args.push('-v', `${options.exchangeDir}:${CONTAINER_EXCHANGE_DIR}`);
    }
    if (options.networkDisabled === true) {
      args.push('--network', 'none');
    } else if (options.network) {
      args.push('--network', options.network);
      if (options.networkAlias) {
        args.push('--network-alias', options.networkAlias);
      }
    }
    if (options.memoryLimit) {
      args.push('--memory', options.memoryLimit);
    }
    for (const port of options.ports ?? []) args.push('-p', port);
    for (const volume of options.volumes ?? []) args.push('-v', volume);
    args.push(...(options.extraArgs ?? []));
    const env = envTransport(options.env);
    args.push(...env.args);
    if (options.service) {
      args.push(options.image);
    } else {
      // Idle forever; steps are run in it via `exec` and it's removed at
      // job end. `tail` exists in practically every image (busybox too).
      args.push('--entrypoint', 'tail', options.image, '-f', '/dev/null');
    }

    return this.runCli(args, undefined, env).then((result) =>
      result.success
        ? { success: true, id: result.stdout.trim() }
        : {
            success: false,
            error: result.stderr.trim() || `exit code ${result.exitCode}`
          }
    );
  }

  exec(
    id: string,
    options: ContainerExecInOptions
  ): Promise<ContainerExecResult> {
    const env = envTransport(options.env);
    const args = [
      'exec',
      '-w',
      options.workingDir || CONTAINER_WORKDIR,
      ...env.args
    ];
    if (options.args) {
      args.push(id, ...options.args);
    } else {
      args.push(id, 'sh', '-c', options.command || '');
    }
    return this.runCli(args, options.timeoutMs, env);
  }

  async createNetwork(name: string): Promise<boolean> {
    return (await this.runCli(['network', 'create', name])).success;
  }

  async removeNetwork(name: string): Promise<void> {
    await this.runCli(['network', 'rm', name]);
  }

  removeNetworkSync(name: string): void {
    try {
      execFileSync(this.binary, ['network', 'rm', name], { stdio: 'ignore' });
    } catch {
      // Best effort: the network may already be gone
    }
  }

  async copyFrom(
    id: string,
    containerPath: string,
    hostPath: string
  ): Promise<boolean> {
    return (await this.runCli(['cp', `${id}:${containerPath}`, hostPath]))
      .success;
  }

  async copyTo(
    id: string,
    hostPath: string,
    containerPath: string
  ): Promise<boolean> {
    return (await this.runCli(['cp', hostPath, `${id}:${containerPath}`]))
      .success;
  }

  async health(id: string): Promise<string> {
    const result = await this.runCli([
      'inspect',
      '--format',
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}',
      id
    ]);
    return result.success ? result.stdout.trim() : 'unknown';
  }

  async ports(id: string): Promise<Record<string, string>> {
    const result = await this.runCli(['port', id]);
    const ports: Record<string, string> = {};
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^(\d+)\/\w+\s*->\s*.*:(\d+)\s*$/);
      if (match && !(match[1] in ports)) ports[match[1]] = match[2];
    }
    return ports;
  }

  async stop(id: string): Promise<void> {
    await this.runCli(['rm', '-f', id]);
  }

  stopSync(id: string): void {
    try {
      execFileSync(this.binary, ['rm', '-f', id], { stdio: 'ignore' });
    } catch {
      // Best effort: the container may already be gone
    }
  }

  private runCli(
    args: string[],
    timeoutMs?: number,
    env?: EnvTransport
  ): Promise<ContainerExecResult> {
    const startTime = Date.now();
    return new Promise<ContainerExecResult>((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.binary, args, { env: env?.clientEnv });
      } catch (err) {
        env?.cleanup();
        throw err;
      }
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : undefined;

      child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

      child.on('error', (err) => {
        if (timeout) clearTimeout(timeout);
        env?.cleanup();
        resolve({
          success: false,
          stdout,
          stderr: stderr || err.message,
          exitCode: null,
          timedOut,
          durationMs: Date.now() - startTime
        });
      });

      child.on('close', (exitCode) => {
        if (timeout) clearTimeout(timeout);
        env?.cleanup();
        resolve({
          success: !timedOut && exitCode === 0,
          stdout,
          stderr,
          exitCode,
          timedOut,
          durationMs: Date.now() - startTime
        });
      });
    });
  }

  async build(
    contextDir: string,
    tag: string,
    dockerfile?: string
  ): Promise<ContainerBuildResult> {
    const quote = (value: string): string =>
      `'${value.replace(/'/g, "'\\''")}'`;
    const dockerfileArg =
      dockerfile && dockerfile !== 'Dockerfile'
        ? `-f ${quote(dockerfile)} `
        : '';
    try {
      const { stdout, stderr } = await execAsync(
        `${this.binary} build -t ${quote(tag)} ${dockerfileArg}${quote(contextDir)}`
      );
      return { success: true, stdout, stderr };
    } catch (error: unknown) {
      const err = error as {
        message: string;
        stdout?: string;
        stderr?: string;
      };
      return {
        success: false,
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        error: err.message
      };
    }
  }
}

const runtimeInstances: Record<ContainerRuntimeName, ContainerRuntime> = {
  docker: new CliContainerRuntime('docker'),
  podman: new CliContainerRuntime('podman'),
  containerd: new CliContainerRuntime('containerd')
};

const AUTO_DETECT_ORDER: ContainerRuntimeName[] = [
  'docker',
  'podman',
  'containerd'
];

/**
 * Resolve a usable container runtime according to preference:
 * - 'none' → no isolation (caller should fall back to host execution).
 * - 'docker' | 'podman' | 'containerd' → that engine specifically, or null
 *   if unavailable.
 * - 'auto' → first available of docker, podman, then containerd; null if
 *   none is installed/running (caller falls back to host execution).
 */
export async function resolveContainerRuntime(
  preference: ContainerRuntimePreference = 'auto'
): Promise<ContainerRuntime | null> {
  if (preference === 'none') return null;

  if (preference !== 'auto') {
    const runtime = runtimeInstances[preference];
    return (await runtime.isAvailable()) ? runtime : null;
  }

  for (const name of AUTO_DETECT_ORDER) {
    const runtime = runtimeInstances[name];
    if (await runtime.isAvailable()) return runtime;
  }

  return null;
}

/** Test-only: reset cached availability probes between test cases. */
export function _resetRuntimeCacheForTests(): void {
  for (const runtime of Object.values(runtimeInstances)) {
    (runtime as CliContainerRuntime)['availableCache'] = undefined;
  }
}
