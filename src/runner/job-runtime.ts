import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';
import { StepResult, Step } from '../types';
import { execSync } from 'child_process';
import {
  evaluateCondition,
  ifEvaluationError,
  substituteExpressions,
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
  /** The running step's GITHUB_ACTION* variables (see stepActionEnv). */
  actionEnv: Record<string, string>;
  /** How often each GITHUB_ACTION name was handed out (`__run`, ...). */
  actionNames: Map<string, number>;
  /** The running step's limit from timeout-minutes (step or job). */
  stepTimeout?: { ms: number; message: string };
  /** Aborted when the job is cancelled; kills a running host step. */
  signal?: AbortSignal;
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
 * (`$GITHUB_EVENT_PATH`) and each job's `$RUNNER_TEMP`.
 */
export function createRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-run-'));
  fs.writeFileSync(path.join(dir, 'event.json'), '{}');
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
      // Per job, so concurrent jobs don't share $RUNNER_TEMP.
      tempDir: fs.mkdtempSync(path.join(runDir, 'tmp-')),
      toolCache: path.join(homeDir, '.secureci', 'toolcache')
    }),
    eventPath,
    env: {},
    path: [],
    postSteps: [],
    defaults,
    summary: '',
    actionEnv: {},
    actionNames: new Map(),
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
    let run: boolean;
    try {
      run = evaluateCondition(post.condition, ctx);
    } catch (error) {
      const message = ifEvaluationError(`step '${post.step.name}'`, error);
      logger.error(message);
      stepResults.push({
        step: post.step,
        success: false,
        error: message,
        duration: 0
      });
      ctx.jobFailed = true;
      continue;
    }
    if (!run) {
      logger.info(
        `Skipping step: ${post.step.name ?? 'post'} (condition not met)`
      );
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

/** The action a composite action's steps run inside, for stepActionEnv. */
export interface ParentAction {
  repository: string;
  ref: string;
  /** The action's directory, as the steps see it. */
  path: string;
}

/**
 * The runner's per-step GITHUB_ACTION variables: GITHUB_ACTION is the
 * step's id, else `__run` / `__owner_repo` (numbered `_2`, `_3`... when
 * repeated); a remote `uses:` sets GITHUB_ACTION_REPOSITORY / _REF. Inside
 * a composite action, steps also get its GITHUB_ACTION_PATH, and run steps
 * its repository and ref.
 */
export function stepActionEnv(
  runtime: JobRuntime,
  step: Step,
  parent?: ParentAction
): Record<string, string> {
  let name = step.id;
  if (!name) {
    const base = step.uses
      ? `__${step.uses
          .replace(/@.*$/, '')
          .replace(/[^A-Za-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '')}`
      : '__run';
    const count = (runtime.actionNames.get(base) ?? 0) + 1;
    runtime.actionNames.set(base, count);
    name = count === 1 ? base : `${base}_${count}`;
  }

  const remote = step.uses?.match(/^([^./][^/@]*\/[^/@]+)(?:\/[^@]*)?@(.+)$/);
  const env: Record<string, string> = {
    GITHUB_ACTION: name,
    GITHUB_ACTION_REPOSITORY: remote
      ? remote[1]
      : step.uses
        ? ''
        : (parent?.repository ?? ''),
    GITHUB_ACTION_REF: remote ? remote[2] : step.uses ? '' : (parent?.ref ?? '')
  };
  if (parent) env.GITHUB_ACTION_PATH = parent.path;
  return env;
}

/**
 * An action directory's path inside the job container: copied once into
 * the mounted exchange dir (the action cache isn't mounted).
 */
export function actionDirInContainer(
  container: JobContainerHandle,
  actionDir: string
): string {
  let containerDir = container.actionDirs.get(actionDir);
  if (!containerDir) {
    const hash = crypto
      .createHash('sha1')
      .update(actionDir)
      .digest('hex')
      .slice(0, 12);
    fs.cpSync(actionDir, path.join(container.exchangeDir, 'actions', hash), {
      recursive: true
    });
    containerDir = `${CONTAINER_EXCHANGE_DIR}/actions/${hash}`;
    container.actionDirs.set(actionDir, containerDir);
  }
  return containerDir;
}

/**
 * The time limit for the running step: its (or its job's) timeout-minutes,
 * or --container-timeout in container mode, whichever is shorter, with the
 * message to fail it with.
 */
export function effectiveTimeout(
  runtime: JobRuntime,
  containerTimeoutMs?: number,
  inContainer = !!runtime.container
): { ms?: number; message: string } {
  const own = runtime.stepTimeout;
  const flag =
    inContainer && containerTimeoutMs ? containerTimeoutMs : undefined;
  if (own && (flag === undefined || own.ms <= flag)) return own;
  if (flag !== undefined) {
    return {
      ms: flag,
      message: `Timed out after ${flag}ms (--container-timeout)`
    };
  }
  return { message: '' };
}

/**
 * The label shown for a step, like GitHub: its `name` with `${{ }}`
 * expressions resolved, else its `uses:` reference, else the first
 * non-empty line of its `run:` script, else "step".
 */
export function stepDisplayName(step: Step, ctx?: ExpressionContext): string {
  if (step.name) return ctx ? substituteExpressions(step.name, ctx) : step.name;
  if (step.uses) return step.uses;
  if (step.run) {
    const line = step.run
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean);
    if (line) return ctx ? substituteExpressions(line, ctx) : line;
  }
  return 'step';
}
