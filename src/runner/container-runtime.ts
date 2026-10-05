import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Pluggable container runtime support for isolating `run:` steps.
 *
 * Docker and Podman both expose (near-)identical CLI surfaces (`<bin> run
 * --rm -v ... -e ... <image> sh -c "<command>"`), so a single CLI-based
 * implementation covers both engines without any extra npm dependency —
 * in line with this project's minimal-dependency philosophy. Other
 * Docker-CLI-compatible tools (e.g. `nerdctl`) can be added the same way.
 */

export type ContainerRuntimeName = 'docker' | 'podman';
export type ContainerRuntimePreference = 'auto' | 'docker' | 'podman' | 'none';

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

export interface ContainerRuntime {
  readonly name: ContainerRuntimeName;
  isAvailable(): Promise<boolean>;
  execute(options: ContainerExecOptions): Promise<ContainerExecResult>;
  /** Build an image from a Dockerfile directory, for Docker-type actions. */
  build(
    contextDir: string,
    tag: string,
    dockerfile?: string
  ): Promise<ContainerBuildResult>;
}

const CONTAINER_WORKDIR = '/actly-workspace';
export const CONTAINER_EXCHANGE_DIR = '/actly-exchange';

/** Probe timeout for `<bin> version` availability checks. */
const PROBE_TIMEOUT_MS = 3000;

class CliContainerRuntime implements ContainerRuntime {
  private availableCache: boolean | undefined;

  constructor(public readonly name: ContainerRuntimeName) {}

  async isAvailable(): Promise<boolean> {
    if (this.availableCache !== undefined) return this.availableCache;

    try {
      await execAsync(`${this.name} version --format '{{.Server.Version}}'`, {
        timeout: PROBE_TIMEOUT_MS
      });
      this.availableCache = true;
    } catch {
      this.availableCache = false;
    }

    return this.availableCache;
  }

  execute(options: ContainerExecOptions): Promise<ContainerExecResult> {
    const startTime = Date.now();
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

    if (options.networkDisabled !== false) {
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

    return new Promise<ContainerExecResult>((resolve) => {
      const child = spawn(this.name, args);
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeout = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs)
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
        `${this.name} build -t ${quote(tag)} ${dockerfileArg}${quote(contextDir)}`
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
  podman: new CliContainerRuntime('podman')
};

/**
 * Resolve a usable container runtime according to preference:
 * - 'none' → no isolation (caller should fall back to host execution).
 * - 'docker' | 'podman' → that engine specifically, or null if unavailable.
 * - 'auto' (default) → first available of docker, then podman; null if
 *   neither is installed/running (caller falls back to host execution).
 */
export async function resolveContainerRuntime(
  preference: ContainerRuntimePreference = 'auto'
): Promise<ContainerRuntime | null> {
  if (preference === 'none') return null;

  if (preference === 'docker' || preference === 'podman') {
    const runtime = runtimeInstances[preference];
    return (await runtime.isAvailable()) ? runtime : null;
  }

  for (const name of ['docker', 'podman'] as ContainerRuntimeName[]) {
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
