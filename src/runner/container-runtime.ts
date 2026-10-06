import { exec, execFileSync, spawn } from 'child_process';
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

/** Options for starting a long-lived per-job container. */
export interface ContainerStartOptions {
  image: string;
  /** Host directory mounted as the container's working directory. */
  workingDir: string;
  /** Host directory mounted read-write for exchanging file commands etc. */
  exchangeDir: string;
  env?: Record<string, string>;
  memoryLimit?: string;
  /** Disable container networking. Default: false (network on). */
  networkDisabled?: boolean;
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
  /** Build an image from a Dockerfile directory, for Docker-type actions. */
  build(
    contextDir: string,
    tag: string,
    dockerfile?: string
  ): Promise<ContainerBuildResult>;
}

export const CONTAINER_WORKDIR = '/secureci-workspace';
export const CONTAINER_EXCHANGE_DIR = '/secureci-exchange';

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

    for (const [key, value] of Object.entries(options.env || {})) {
      args.push('-e', `${key}=${value}`);
    }

    args.push(options.image);
    if (options.args) {
      args.push(...options.args);
    } else {
      args.push('sh', '-c', options.command || '');
    }

    return this.runCli(args, options.timeoutMs);
  }

  start(options: ContainerStartOptions): Promise<ContainerStartResult> {
    const args = [
      'run',
      '-d',
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
    for (const [key, value] of Object.entries(options.env || {})) {
      args.push('-e', `${key}=${value}`);
    }
    // Idle forever; steps are run in it via `exec` and it's removed at job
    // end. `tail` exists in practically every image (busybox included).
    args.push('--entrypoint', 'tail', options.image, '-f', '/dev/null');

    return this.runCli(args).then((result) =>
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
    const args = ['exec', '-w', options.workingDir || CONTAINER_WORKDIR];
    for (const [key, value] of Object.entries(options.env || {})) {
      args.push('-e', `${key}=${value}`);
    }
    if (options.args) {
      args.push(id, ...options.args);
    } else {
      args.push(id, 'sh', '-c', options.command || '');
    }
    return this.runCli(args, options.timeoutMs);
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
    timeoutMs?: number
  ): Promise<ContainerExecResult> {
    const startTime = Date.now();
    return new Promise<ContainerExecResult>((resolve) => {
      const child = spawn(this.binary, args);
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
