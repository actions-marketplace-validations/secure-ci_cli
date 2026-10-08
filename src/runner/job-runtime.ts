import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';
import { StepResult, Step } from '../types';
import { execSync } from 'child_process';
import {
  evaluateCondition,
  ExpressionContext,
  GithubContext
} from './expression';
import {
  ContainerRuntime,
  CONTAINER_EXCHANGE_DIR,
  CONTAINER_WORKDIR
} from './container-runtime';
import {
  buildRunnerEnv,
  createStepFiles,
  processWorkflowCommands,
  readStepFiles,
  StepFiles
} from './runner-env';

/** A JavaScript action's `post:` script, queued to run at job end. */
export interface PostStep {
  step: Step;
  condition: string;
  run: () => Promise<StepResult>;
}

/**
 * Mutable per-job runner state: the default `GITHUB_*` / `RUNNER_*` env
 * vars, what steps have added via `$GITHUB_ENV` / `$GITHUB_PATH`, and the
 * `post:` steps queued by JavaScript actions.
 */
export interface JobRuntime {
  runnerEnv: Record<string, string>;
  eventPath: string;
  env: Record<string, string>;
  /** `$GITHUB_PATH` additions, most recent first. */
  path: string[];
  postSteps: PostStep[];
  /** Set when the job's steps run in a container (see startJobContainer). */
  container?: JobContainerHandle;
  /** The job's service containers and network (see startJobServices). */
  services?: { runtime: ContainerRuntime; ids: string[]; network?: string };
  /** `defaults.run` (job-level, else workflow-level) for `run:` steps. */
  defaults: { shell?: string; workingDirectory?: string };
  /** What steps wrote to `$GITHUB_STEP_SUMMARY`, in order. */
  summary: string;
  /** Saved state of JavaScript actions whose `pre` ran at job start. */
  preState: Map<Step, Record<string, string>>;
  /** Remote action -> its fetched action.yml (or null), per job. */
  actionPaths: Map<string, string | null>;
}

/** A per-job container that `run:` steps and JS actions are exec'd into. */
export interface JobContainerHandle {
  runtime: ContainerRuntime;
  id: string;
  image: string;
  /** Host directory mounted at CONTAINER_EXCHANGE_DIR. */
  exchangeDir: string;
  /** Whether the image has bash (decides the default shell). */
  bash: boolean;
  /** $HOME inside the container, probed once. */
  home?: string;
  /** The image's `node` and base PATH, probed once; null if no node. */
  node?: { path: string; basePath: string } | null;
  /** Host action directory -> its copy's path inside the container. */
  actionDirs: Map<string, string>;
}

/** Step files inside the job container's exchange dir, writable from it. */
export function createContainerStepFiles(container: JobContainerHandle): {
  files: StepFiles;
  containerDir: string;
} {
  const dir = fs.mkdtempSync(path.join(container.exchangeDir, 'step-'));
  const files = createStepFiles(dir);
  fs.chmodSync(dir, 0o777);
  for (const file of [
    files.output,
    files.env,
    files.path,
    files.state,
    files.summary
  ]) {
    fs.chmodSync(file, 0o666);
  }
  return {
    files,
    containerDir: `${CONTAINER_EXCHANGE_DIR}/${path.basename(dir)}`
  };
}

/**
 * Kill what a timed-out step left running in the job container: every
 * process whose environment carries the step's SECURECI_STEP marker
 * (children inherit it). Killing the container client alone leaves the
 * command running until the container is removed.
 */
export async function killStepProcesses(
  container: JobContainerHandle,
  marker: string
): Promise<void> {
  await container.runtime.exec(container.id, {
    command: `for p in /proc/[0-9]*; do tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx 'SECURECI_STEP=${marker}' && kill -9 "\${p#/proc/}" 2>/dev/null; done; true`
  });
}

/** `export PATH=...` prefix applying `$GITHUB_PATH` additions in a shell. */
export function containerPathPrefix(runtime: JobRuntime): string {
  return runtime.path.length
    ? `export PATH="${runtime.path.join(':')}:$PATH"\n`
    : '';
}

/**
 * Create the per-run scratch directory holding the event payload
 * (`$GITHUB_EVENT_PATH`) and `$RUNNER_TEMP`.
 */
export function createRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-run-'));
  fs.writeFileSync(path.join(dir, 'event.json'), '{}');
  fs.mkdirSync(path.join(dir, 'tmp'));
  return dir;
}

/** The `runner` context, derived from the runner env. */
export function runnerContext(runtime: JobRuntime): Record<string, unknown> {
  return {
    name: 'secureci',
    os: runtime.runnerEnv.RUNNER_OS,
    arch: process.arch === 'arm64' ? 'ARM64' : 'X64',
    temp: runtime.runnerEnv.RUNNER_TEMP,
    tool_cache: runtime.runnerEnv.RUNNER_TOOL_CACHE
  };
}

let hostBash: boolean | undefined;

/** Whether bash is available on the host (decides the default shell). */
export function hostHasBash(): boolean {
  if (hostBash === undefined) {
    try {
      execSync('command -v bash', { stdio: 'ignore' });
      hostBash = true;
    } catch {
      hostBash = false;
    }
  }
  return hostBash;
}

export function createJobRuntime(
  github: GithubContext,
  runDir: string,
  defaults: JobRuntime['defaults'] = {}
): JobRuntime {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  const eventPath = path.join(runDir, 'event.json');
  return {
    runnerEnv: buildRunnerEnv(github, {
      workspace: process.cwd(),
      eventPath,
      tempDir: path.join(runDir, 'tmp'),
      toolCache: path.join(homeDir, '.secureci', 'toolcache')
    }),
    eventPath,
    env: {},
    path: [],
    postSteps: [],
    defaults,
    summary: '',
    preState: new Map(),
    actionPaths: new Map()
  };
}

/**
 * Run the job's queued `post:` steps in reverse registration order, each
 * gated on its `post-if` condition (default `always()`).
 */
export async function runPostSteps(
  runtime: JobRuntime,
  ctx: ExpressionContext,
  stepResults: StepResult[]
): Promise<void> {
  for (const post of [...runtime.postSteps].reverse()) {
    if (!evaluateCondition(post.condition, ctx)) {
      logger.info(`Skipping step: ${post.step.name} (condition not met)`);
      continue;
    }
    logger.info(`Running: ${post.step.name}`);
    const result = await post.run();
    stepResults.push(result);
    if (!result.success) {
      ctx.jobFailed = true;
    }
  }
  runtime.postSteps = [];
}

/** `GITHUB_OUTPUT` / `GITHUB_ENV` / ... pointing at a step's files. */
export function fileCommandEnv(
  files: StepFiles,
  containerDir?: string
): Record<string, string> {
  const at = (file: string) =>
    containerDir ? `${containerDir}/${path.basename(file)}` : file;
  return {
    GITHUB_OUTPUT: at(files.output),
    GITHUB_ENV: at(files.env),
    GITHUB_PATH: at(files.path),
    GITHUB_STATE: at(files.state),
    GITHUB_STEP_SUMMARY: at(files.summary)
  };
}

/**
 * The runner env as seen from inside a container: workspace and event
 * payload at their mounted paths (the event payload is copied into the
 * exchange dir's root).
 */
export function containerRunnerEnv(
  runtime: JobRuntime
): Record<string, string> {
  return {
    ...runtime.runnerEnv,
    GITHUB_WORKSPACE: CONTAINER_WORKDIR,
    GITHUB_EVENT_PATH: `${CONTAINER_EXCHANGE_DIR}/event.json`,
    RUNNER_TEMP: '/tmp',
    RUNNER_TOOL_CACHE: '/opt/hostedtoolcache'
  };
}

/**
 * Handle a finished step's stdout and file commands: register
 * `::add-mask::` values before anything is logged, log the remaining
 * output, and fold `$GITHUB_ENV` / `$GITHUB_PATH` changes into the job
 * runtime. Returns the step's outputs and saved state.
 */
export function finishStepOutput(
  stdout: string | undefined,
  files: StepFiles,
  runtime: JobRuntime
): { outputs: Record<string, string>; state: Record<string, string> } {
  const commands = processWorkflowCommands(stdout || '');
  commands.masks.forEach((mask, i) =>
    logger.registerSecrets({ [`mask-${i}`]: mask })
  );

  for (const annotation of commands.annotations) {
    if (annotation.level === 'warning') logger.warn(annotation.message);
    else if (annotation.level === 'error') logger.error(annotation.message);
    else if (annotation.level === 'debug') logger.debug(annotation.message);
    else if (annotation.level === 'group')
      logger.info(`▸ ${annotation.message}`);
    else logger.info(annotation.message);
  }

  const text = commands.text.trim();
  if (text) {
    logger.info(text);
  }

  const fileResults = readStepFiles(files);
  runtime.summary += fileResults.summary;
  Object.assign(runtime.env, fileResults.env);
  runtime.path.unshift(...[...fileResults.path].reverse());

  return {
    outputs: { ...fileResults.outputs, ...commands.outputs },
    state: { ...fileResults.state, ...commands.state }
  };
}
