import * as fs from 'fs';
import * as path from 'path';

/**
 * What the CLI lets workflow and action content pass to the container
 * engine. Container isolation is the boundary between third-party code
 * (remote actions, remote reusable workflows) and this machine, so anything
 * that would let a container reach the host is refused.
 */

// A Docker image reference: never an option, never whitespace.
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

/** Why `image` can't be passed to the container engine, if it can't. */
export function invalidImageReason(image: string): string | undefined {
  return IMAGE.test(image)
    ? undefined
    : `Invalid image reference ${JSON.stringify(image)}: an image name can't be empty, start with "-" or contain whitespace`;
}

/**
 * `docker run` options that give a container the host's privileges,
 * namespaces, devices or filesystem.
 */
const UNSAFE_LONG_OPTIONS = new Set([
  '--privileged',
  '--cap-add',
  '--security-opt',
  '--pid',
  '--network',
  '--net',
  '--ipc',
  '--userns',
  '--uts',
  '--cgroupns',
  '--device',
  '--device-cgroup-rule',
  '--volume',
  '--mount',
  '--volumes-from',
  '--runtime',
  '--cgroup-parent'
]);
const UNSAFE_SHORT_OPTIONS = new Set(['-v']);

/** Long options that take a value as the next argument (when no `=`). */
const VALUE_OPTIONS = new Set([
  ...[...UNSAFE_LONG_OPTIONS].filter((o) => o !== '--privileged'),
  '--health-cmd',
  '--health-interval',
  '--health-timeout',
  '--health-retries',
  '--health-start-period',
  '--entrypoint',
  '--env',
  '--shm-size',
  '--tmpfs',
  '--user',
  '--hostname',
  '--workdir',
  '--name',
  '--memory',
  '--cpus',
  '--label',
  '--add-host',
  '--ulimit'
]);
const SHORT_VALUE_OPTIONS = new Set(['-v', '-e', '-u', '-w', '-h', '-l', '-m']);

/**
 * The unsafe options in `args` (`services.<id>.options`), by flag name, in
 * order. Values of options are skipped, so `--health-cmd --privileged` is
 * fine.
 */
export function unsafeServiceOptions(args: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [name, value] = arg.split(/=(.*)/s);
      if (UNSAFE_LONG_OPTIONS.has(name)) found.push(name);
      if (value === undefined && VALUE_OPTIONS.has(name)) i++;
    } else if (arg.startsWith('-') && arg.length > 1) {
      const name = arg.slice(0, 2);
      if (UNSAFE_SHORT_OPTIONS.has(name)) found.push(name);
      if (arg.length === 2 && SHORT_VALUE_OPTIONS.has(name)) i++;
    }
  }
  return found;
}

/**
 * Split `args` into the options to pass on and the `reserved` ones (by
 * flag name, in order), dropping a reserved option's value too. Values of
 * other options are kept as they are, so `--health-cmd --entrypoint` stays.
 */
export function splitReservedOptions(
  args: string[],
  reserved: ReadonlySet<string>
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let name: string | undefined;
    let takesNext = false;
    if (arg.startsWith('--')) {
      const [flag, value] = arg.split(/=(.*)/s);
      name = flag;
      takesNext = value === undefined && VALUE_OPTIONS.has(flag);
    } else if (arg.startsWith('-') && arg.length > 1) {
      name = arg.slice(0, 2);
      takesNext = arg.length === 2 && SHORT_VALUE_OPTIONS.has(name);
    }
    const span = takesNext ? args.slice(i, i + 2) : [arg];
    if (name !== undefined && reserved.has(name)) dropped.push(name);
    else kept.push(...span);
    if (takesNext) i++;
  }
  return { kept, dropped };
}

const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Why a `services.<id>.volumes` entry is refused, if it is. Named and
 * anonymous volumes are fine; a host bind mount must stay inside the
 * workspace (after following symlinks) and away from its `.git`.
 */
export function unsafeServiceVolumeReason(
  spec: string,
  workspace: string
): string | undefined {
  const parts = spec.split(':');
  if (parts.length < 2) return undefined; // anonymous volume: `/data`
  const source = parts[0];
  if (VOLUME_NAME.test(source)) return undefined; // named volume
  if (!path.isAbsolute(source)) {
    return `Volume ${JSON.stringify(spec)} uses a relative or unsupported host path; use an absolute path inside the workspace or a named volume`;
  }
  const root = realpathOrSelf(workspace);
  const real = realpathOrSelf(source);
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return `Volume ${JSON.stringify(spec)} mounts a host path outside the workspace`;
  }
  const git = path.join(root, '.git');
  if (
    real === git ||
    real.startsWith(git + path.sep) ||
    (rel === '' && fs.existsSync(git))
  ) {
    return `Volume ${JSON.stringify(spec)} would expose the repository's .git to the container`;
  }
  return undefined;
}
