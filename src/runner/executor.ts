import { parseFile } from '../parser/workflow-parser';
import { logger } from '../utils/logger';
import {
  RunOptions,
  WorkflowResult,
  JobResult,
  StepResult,
  Step,
  ActionFile
} from '../types';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { fetchAction } from './action-fetcher';
import {
  createContext,
  evaluateCondition,
  resolveExpressionValue,
  substituteExpressions,
  substituteRecord,
  ExpressionContext,
  GithubContext
} from './expression';
import { execSync } from 'child_process';
import {
  resolveContainerRuntime,
  ContainerRuntime,
  CONTAINER_EXCHANGE_DIR,
  CONTAINER_WORKDIR
} from './container-runtime';
import {
  buildRunnerEnv,
  cleanupStepFiles,
  createStepFiles,
  prependPath,
  processWorkflowCommands,
  readStepFiles,
  StepFiles
} from './runner-env';

const DEFAULT_CONTAINER_IMAGE = 'ubuntu:22.04';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Best-effort local git lookup, used to populate `github.sha` / `github.ref`.
 * Returns undefined if git isn't available or the directory isn't a repo.
 */
function tryGit(command: string, cwd: string): string | undefined {
  try {
    return execSync(command, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/**
 * Build a (best-effort, local-only) `github.*` context object. Real GitHub
 * Actions populates this from the live Actions run; locally we fall back to
 * `GITHUB_*` environment variables (if the user has set them) and local git
 * state, matching act's approach of approximating the context for local runs.
 */
function buildGithubContext(
  workflowName: string,
  jobId: string,
  cwd: string
): GithubContext {
  const env = process.env;
  const sha = env.GITHUB_SHA || tryGit('git rev-parse HEAD', cwd) || '';
  const ref =
    env.GITHUB_REF ||
    (() => {
      const branch = tryGit('git rev-parse --abbrev-ref HEAD', cwd);
      return branch ? `refs/heads/${branch}` : '';
    })();
  const refName =
    env.GITHUB_REF_NAME || ref.replace(/^refs\/(heads|tags)\//, '');

  return {
    workflow: workflowName,
    job: jobId,
    sha,
    ref,
    ref_name: refName,
    event_name: env.GITHUB_EVENT_NAME || 'workflow_dispatch',
    actor: env.GITHUB_ACTOR || os.userInfo().username,
    repository: env.GITHUB_REPOSITORY || path.basename(cwd),
    repository_owner: env.GITHUB_REPOSITORY_OWNER || '',
    run_id: env.GITHUB_RUN_ID || String(Date.now()),
    run_number: env.GITHUB_RUN_NUMBER || '1',
    run_attempt: env.GITHUB_RUN_ATTEMPT || '1',
    workspace: env.GITHUB_WORKSPACE || cwd,
    server_url: env.GITHUB_SERVER_URL || 'https://github.com',
    api_url: env.GITHUB_API_URL || 'https://api.github.com'
  };
}

/**
 * Expand a job's `strategy.matrix` into the list of concrete variable
 * combinations to run the job with, via a cartesian product of each axis'
 * values. `include`/`exclude` entries are not yet supported.
 */
function expandMatrix(
  matrix: Record<string, unknown> | undefined
): Array<Record<string, unknown>> {
  if (!matrix) return [{}];

  const axes = Object.entries(matrix).filter(
    ([key]) => key !== 'include' && key !== 'exclude'
  );
  if (axes.length === 0) return [{}];

  let combinations: Array<Record<string, unknown>> = [{}];
  for (const [key, rawValues] of axes) {
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const next: Array<Record<string, unknown>> = [];
    for (const combo of combinations) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combinations = next;
  }
  return combinations;
}

/**
 * Order job IDs so dependencies (via `needs`) run before dependents, using
 * Kahn's algorithm. Falls back to declaration order (with a warning) if a
 * cycle is detected, since that indicates an invalid workflow.
 */
export function topologicalJobOrder(
  jobs: Record<string, { needs?: string | string[] }>
): string[] {
  const jobIds = Object.keys(jobs);
  const needsOf = (id: string): string[] => {
    const needs = jobs[id].needs;
    if (!needs) return [];
    return Array.isArray(needs) ? needs : [needs];
  };

  const inDegree = new Map<string, number>();
  for (const id of jobIds) {
    inDegree.set(id, needsOf(id).filter((dep) => jobIds.includes(dep)).length);
  }

  const queue = jobIds.filter((id) => inDegree.get(id) === 0);
  const ordered: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    ordered.push(id);

    for (const other of jobIds) {
      if (needsOf(other).includes(id)) {
        const remaining = (inDegree.get(other) || 0) - 1;
        inDegree.set(other, remaining);
        if (remaining === 0) {
          queue.push(other);
        }
      }
    }
  }

  if (ordered.length !== jobIds.length) {
    logger.warn(
      'Detected a cycle in job "needs" dependencies; falling back to declaration order.'
    );
    return jobIds;
  }

  return ordered;
}

/**
 * Execute a reusable workflow called via `jobs.<id>.uses:`. Only local
 * workflow paths (e.g. `./.github/workflows/reusable.yml`) are supported;
 * remote references (`owner/repo/.github/workflows/x.yml@ref`) are warned
 * and skipped, matching the previous behavior for that case.
 */
async function executeReusableWorkflowJob(
  jobId: string,
  job: {
    uses?: string;
    with?: Record<string, string | number | boolean>;
    secrets?: Record<string, string> | 'inherit';
  },
  workflowDir: string,
  options: RunOptions
): Promise<JobResult> {
  const startTime = Date.now();
  const uses = job.uses as string;

  if (!uses.startsWith('.')) {
    logger.warn(
      `Skipping reusable workflow call: ${uses} (only local workflow paths are supported)`
    );
    return {
      job: jobId,
      success: true,
      steps: [],
      duration: Date.now() - startTime
    };
  }

  const resolvedPath = path.resolve(workflowDir, uses);
  if (!fs.existsSync(resolvedPath)) {
    logger.error(`Reusable workflow not found: ${resolvedPath}`);
    return {
      job: jobId,
      success: false,
      steps: [],
      duration: Date.now() - startTime
    };
  }

  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(job.with || {})) {
    inputs[key] = String(value);
  }

  let secrets: Record<string, string> = {};
  if (job.secrets === 'inherit') {
    secrets = { ...(options.secrets || {}) };
  } else if (job.secrets) {
    const callerCtx = createContext({}, options.inputs, options.secrets);
    for (const [key, value] of Object.entries(job.secrets)) {
      const resolved = resolveExpressionValue(value, callerCtx);
      secrets[key] = resolved === undefined ? value : String(resolved);
    }
  }

  logger.step(`Executing reusable workflow: ${uses} (job: ${jobId})`);

  const subResult = await executeWorkflow(resolvedPath, {
    ...options,
    inputs,
    secrets,
    job: undefined
  });

  const steps = subResult.jobs.flatMap((j) => j.steps);

  return {
    job: jobId,
    success: subResult.success,
    steps,
    duration: Date.now() - startTime
  };
}

/**
 * Execute a workflow or action file
 */
export async function executeWorkflow(
  filePath: string,
  options: RunOptions = {}
): Promise<WorkflowResult> {
  const startTime = Date.now();

  logger.registerSecrets(options.secrets);
  const runDir = createRunDir();

  try {
    const parsed = parseFile(filePath);

    if (parsed.type === 'workflow') {
      logger.info(`Executing workflow: ${parsed.file.name}`);

      const jobs: JobResult[] = [];
      const jobSucceeded = new Map<string, boolean>();
      const jobOrder = topologicalJobOrder(parsed.file.jobs);

      for (const jobId of jobOrder) {
        const job = parsed.file.jobs[jobId];

        // Skip if specific job requested and this isn't it
        if (options.job && jobId !== options.job) {
          continue;
        }

        // Skip jobs whose dependencies failed (or were themselves skipped)
        if (!options.job) {
          const needs = job.needs
            ? Array.isArray(job.needs)
              ? job.needs
              : [job.needs]
            : [];
          const unmetDependency = needs.find(
            (dep) => jobSucceeded.get(dep) === false
          );
          if (unmetDependency) {
            logger.info(
              `Skipping job: ${jobId} (dependency "${unmetDependency}" did not succeed)`
            );
            continue;
          }
        }

        const workflowDir = path.dirname(filePath);
        const github = buildGithubContext(
          parsed.file.name,
          jobId,
          process.cwd()
        );

        // Handle reusable workflow calls
        if (job.uses) {
          const reusableResult = await executeReusableWorkflowJob(
            jobId,
            job,
            workflowDir,
            options
          );
          jobs.push(reusableResult);
          jobSucceeded.set(jobId, reusableResult.success);
          if (reusableResult.success) {
            logger.success(`Job ${jobId} completed successfully`);
          }
          continue;
        }

        const matrixCombinations = expandMatrix(job.strategy?.matrix);
        const failFast = job.strategy?.['fail-fast'] !== false;
        let matrixFailed = false;

        for (const matrixValues of matrixCombinations) {
          if (matrixFailed && failFast) {
            logger.info(
              `Skipping remaining matrix jobs for ${jobId} (fail-fast)`
            );
            break;
          }

          const matrixSuffix =
            matrixCombinations.length > 1
              ? ` (${Object.entries(matrixValues)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(', ')})`
              : '';
          const jobLabel = `${jobId}${matrixSuffix}`;

          // Workflow-level env can't reference `env` itself; job-level env
          // sees the workflow env plus matrix (matching GitHub's contexts).
          const workflowEnv = substituteRecord(
            parsed.file.env,
            createContext({}, options.inputs, options.secrets, github)
          );
          const jobEnv = substituteRecord(
            job.env,
            createContext(
              workflowEnv,
              options.inputs,
              options.secrets,
              github,
              matrixValues
            )
          );
          const jobCtx = createContext(
            { ...workflowEnv, ...jobEnv },
            options.inputs,
            options.secrets,
            github,
            matrixValues
          );

          if (!evaluateCondition(job.if, jobCtx)) {
            logger.info(`Skipping job: ${jobLabel} (condition not met)`);
            continue;
          }

          logger.step(`Executing job: ${jobLabel}`);
          const jobStartTime = Date.now();
          const stepResults: StepResult[] = [];
          const runtime = createJobRuntime(github, runDir);

          // Execute each step
          for (const step of job.steps || []) {
            // `$GITHUB_ENV` additions from earlier steps sit between the
            // job env and this step's own `env:`.
            const envCtx: ExpressionContext = {
              ...jobCtx,
              env: { ...jobCtx.env, ...runtime.env }
            };
            const stepCtx: ExpressionContext = {
              ...envCtx,
              env: { ...envCtx.env, ...substituteRecord(step.env, envCtx) }
            };

            if (!evaluateCondition(step.if, stepCtx)) {
              logger.info(
                `Skipping step: ${step.name || step.id || 'unnamed'} (condition not met)`
              );
              const skippedResult: StepResult = {
                step,
                success: true,
                outcome: 'skipped',
                output: 'Skipped: condition not met',
                duration: 0
              };
              stepResults.push(skippedResult);
              if (step.id) {
                jobCtx.steps[step.id] = { outcome: 'skipped', outputs: {} };
              }
              continue;
            }

            const stepResult = await executeStep(
              step,
              options,
              runtime,
              stepCtx
            );
            stepResults.push(stepResult);

            if (step.id) {
              jobCtx.steps[step.id] = {
                outcome: stepResult.success ? 'success' : 'failure',
                outputs: stepResult.outputs || {}
              };
            }

            if (!stepResult.success) {
              jobCtx.jobFailed = true;
            }

            if (!stepResult.success && !step['continue-on-error']) {
              logger.error(`Step failed: ${step.name || 'unnamed'}`);
              break;
            }
          }

          await runPostSteps(runtime, jobCtx, stepResults);

          const jobSuccess = stepResults.every(
            (s) => s.success || s.step['continue-on-error']
          );

          jobs.push({
            job: jobLabel,
            success: jobSuccess,
            steps: stepResults,
            duration: Date.now() - jobStartTime
          });

          if (!jobSuccess) {
            matrixFailed = true;
          }
        }

        const jobSuccess = !matrixFailed;
        jobSucceeded.set(jobId, jobSuccess);

        if (jobSuccess) {
          logger.success(`Job ${jobId} completed successfully`);
        }
      }

      return {
        success: jobs.every((j) => j.success),
        jobs,
        duration: Date.now() - startTime
      };
    } else {
      // Handle action execution
      logger.info(`Executing action: ${parsed.file.name}`);

      if (parsed.file.runs.using === 'composite' && parsed.file.runs.steps) {
        const stepResults: StepResult[] = [];
        const runtime = createJobRuntime(
          buildGithubContext(parsed.file.name, 'action', process.cwd()),
          runDir
        );

        for (const step of parsed.file.runs.steps) {
          const stepResult = await executeStep(step, options, runtime);
          stepResults.push(stepResult);

          if (!stepResult.success) {
            return {
              success: false,
              jobs: [
                {
                  job: 'action',
                  success: false,
                  steps: stepResults,
                  duration: Date.now() - startTime
                }
              ],
              duration: Date.now() - startTime
            };
          }
        }

        return {
          success: true,
          jobs: [
            {
              job: 'action',
              success: true,
              steps: stepResults,
              duration: Date.now() - startTime
            }
          ],
          duration: Date.now() - startTime
        };
      } else {
        logger.warn(`Action type ${parsed.file.runs.using} not yet supported`);
        return {
          success: false,
          jobs: [],
          duration: Date.now() - startTime
        };
      }
    }
  } catch (error) {
    logger.error(
      `Execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return {
      success: false,
      jobs: [],
      duration: Date.now() - startTime
    };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

/** A JavaScript action's `post:` script, queued to run at job end. */
interface PostStep {
  step: Step;
  condition: string;
  run: () => Promise<StepResult>;
}

/**
 * Mutable per-job runner state: the default `GITHUB_*` / `RUNNER_*` env
 * vars, what steps have added via `$GITHUB_ENV` / `$GITHUB_PATH`, and the
 * `post:` steps queued by JavaScript actions.
 */
interface JobRuntime {
  runnerEnv: Record<string, string>;
  eventPath: string;
  env: Record<string, string>;
  /** `$GITHUB_PATH` additions, most recent first. */
  path: string[];
  postSteps: PostStep[];
}

/**
 * Create the per-run scratch directory holding the event payload
 * (`$GITHUB_EVENT_PATH`) and `$RUNNER_TEMP`.
 */
function createRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-run-'));
  fs.writeFileSync(path.join(dir, 'event.json'), '{}');
  fs.mkdirSync(path.join(dir, 'tmp'));
  return dir;
}

function createJobRuntime(github: GithubContext, runDir: string): JobRuntime {
  const homeDir = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  const eventPath = path.join(runDir, 'event.json');
  return {
    runnerEnv: buildRunnerEnv(github, {
      workspace: process.cwd(),
      eventPath,
      tempDir: path.join(runDir, 'tmp'),
      toolCache: path.join(homeDir, '.ghact', 'toolcache')
    }),
    eventPath,
    env: {},
    path: [],
    postSteps: []
  };
}

/**
 * Run the job's queued `post:` steps in reverse registration order, each
 * gated on its `post-if` condition (default `always()`).
 */
async function runPostSteps(
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
function fileCommandEnv(
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
 * payload at their mounted paths.
 */
function containerRunnerEnv(
  runtime: JobRuntime,
  exchangeDir: string
): Record<string, string> {
  fs.copyFileSync(runtime.eventPath, path.join(exchangeDir, 'event.json'));
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
function finishStepOutput(
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
  Object.assign(runtime.env, fileResults.env);
  runtime.path.unshift(...[...fileResults.path].reverse());

  return {
    outputs: { ...fileResults.outputs, ...commands.outputs },
    state: { ...fileResults.state, ...commands.state }
  };
}

/**
 * Execute a single step
 */
async function executeStep(
  step: Step,
  options: RunOptions,
  runtime: JobRuntime,
  ctx?: ExpressionContext
): Promise<StepResult> {
  const startTime = Date.now();

  try {
    if (step.name) {
      logger.info(`Running: ${step.name}`);
    }

    // Handle 'uses' actions - fetch and execute remote actions
    if (step.uses) {
      return await executeAction(step, options, startTime, runtime, ctx);
    }

    // Handle 'run' commands
    if (step.run) {
      let command = step.run;

      if (ctx) {
        // Resolve all ${{ }} expressions (env/inputs/secrets/steps/
        // github/matrix) against the full step context.
        command = substituteExpressions(command, ctx);
      } else {
        // No context available (e.g. action steps run outside a job) -
        // fall back to direct inputs/secrets substitution.
        if (options.inputs) {
          for (const [key, value] of Object.entries(options.inputs)) {
            command = command.replace(
              new RegExp(`\\$\\{\\{\\s*inputs\\.${key}\\s*\\}\\}`, 'g'),
              value
            );
          }
        }

        if (options.secrets) {
          for (const [key, value] of Object.entries(options.secrets)) {
            command = command.replace(
              new RegExp(`\\$\\{\\{\\s*secrets\\.${key}\\s*\\}\\}`, 'g'),
              value
            );
          }
        }
      }

      logger.debug(`Executing: ${command}`);

      // ctx.env already combines workflow, job and step `env:` plus
      // `$GITHUB_ENV` additions (see executeWorkflow). Fall back to
      // step.env alone when no context is available.
      const mergedEnv: Record<string, string> = ctx
        ? ctx.env
        : { ...runtime.env, ...substituteRecord(step.env, createContext()) };

      const containerPreference = options.containerRuntime ?? 'none';
      if (containerPreference !== 'none') {
        const containerRuntime =
          await resolveContainerRuntime(containerPreference);
        if (containerRuntime) {
          return await executeInContainer(
            containerRuntime,
            runtime,
            step,
            options,
            command,
            startTime,
            mergedEnv
          );
        }
        logger.warn(
          `No "${containerPreference}" container runtime available; falling back to host execution.`
        );
      }

      const files = createStepFiles();

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: step['working-directory'] || process.cwd(),
          shell: step.shell || 'bash',
          env: {
            ...process.env,
            ...runtime.runnerEnv,
            ...mergedEnv,
            PATH: prependPath(runtime.path, mergedEnv.PATH ?? process.env.PATH),
            ...fileCommandEnv(files)
          }
        });

        const { outputs } = finishStepOutput(stdout, files, runtime);
        if (stderr) {
          logger.warn(stderr.trim());
        }

        logger.success(`Step completed: ${step.name || 'unnamed'}`);

        return {
          step,
          success: true,
          output: stdout,
          outputs,
          duration: Date.now() - startTime
        };
      } catch (execError: unknown) {
        const error = execError as {
          message: string;
          stdout?: string;
          stderr?: string;
        };
        logger.error(`Step failed: ${error.message}`);

        const { outputs } = finishStepOutput(error.stdout, files, runtime);
        if (error.stderr) {
          logger.error(error.stderr.trim());
        }

        return {
          step,
          success: false,
          error: error.message,
          output: error.stdout,
          outputs,
          duration: Date.now() - startTime
        };
      } finally {
        cleanupStepFiles(files);
      }
    }

    // No action to take
    return {
      step,
      success: true,
      output: 'No operation',
      duration: Date.now() - startTime
    };
  } catch (error) {
    return {
      step,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime
    };
  }
}

/**
 * Execute a `run:` step's command inside a container via the given runtime,
 * for process/filesystem isolation from the host. Mounts the host's current
 * working directory and a scratch "exchange" directory (carrying the step's
 * file commands and event payload in and out of the container) as volumes.
 */
async function executeInContainer(
  containerRuntime: ContainerRuntime,
  runtime: JobRuntime,
  step: Step,
  options: RunOptions,
  command: string,
  startTime: number,
  mergedEnv: Record<string, string>
): Promise<StepResult> {
  const exchangeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-exchange-'));
  const files = createStepFiles(exchangeDir);

  try {
    const pathPrefix = runtime.path.length
      ? `export PATH="${runtime.path.join(':')}:$PATH"\n`
      : '';
    const workingDir = step['working-directory']
      ? `cd '${step['working-directory'].replace(/'/g, "'\\''")}' && ${command}`
      : command;

    const result = await containerRuntime.execute({
      image: options.containerImage || DEFAULT_CONTAINER_IMAGE,
      command: pathPrefix + workingDir,
      workingDir: process.cwd(),
      exchangeDir,
      env: {
        ...containerRunnerEnv(runtime, exchangeDir),
        ...mergedEnv,
        ...fileCommandEnv(files, CONTAINER_EXCHANGE_DIR)
      },
      timeoutMs: options.containerTimeoutMs,
      memoryLimit: options.containerMemoryLimit,
      networkDisabled: options.networkDisabled !== false
    });

    const { outputs } = finishStepOutput(result.stdout, files, runtime);
    if (result.stderr) {
      logger[result.success ? 'warn' : 'error'](result.stderr.trim());
    }

    if (result.timedOut) {
      logger.error(
        `Step timed out after ${options.containerTimeoutMs}ms (container: ${containerRuntime.name})`
      );
      return {
        step,
        success: false,
        error: `Timed out after ${options.containerTimeoutMs}ms`,
        output: result.stdout,
        outputs,
        duration: Date.now() - startTime
      };
    }

    if (!result.success) {
      logger.error(
        `Step failed (container: ${containerRuntime.name}, exit code: ${result.exitCode})`
      );
      return {
        step,
        success: false,
        error: `Command exited with code ${result.exitCode}`,
        output: result.stdout,
        outputs,
        duration: Date.now() - startTime
      };
    }

    logger.success(
      `Step completed: ${step.name || 'unnamed'} (container: ${containerRuntime.name})`
    );

    return {
      step,
      success: true,
      output: result.stdout,
      outputs,
      duration: Date.now() - startTime
    };
  } finally {
    fs.rmSync(exchangeDir, { recursive: true, force: true });
  }
}

/**
 * Execute a Docker-type action (`runs.using: docker`). Unlike `run:` steps,
 * container isolation is mandatory here (the image *is* the action) - there
 * is no safe host-execution fallback, so this fails the step (rather than
 * skip-as-success) if no container runtime is available.
 */
async function executeDockerAction(
  action: ActionFile,
  actionPath: string,
  step: Step,
  actionInputs: Record<string, string>,
  callerEnv: Record<string, string>,
  options: RunOptions,
  runtime: JobRuntime,
  startTime: number
): Promise<StepResult> {
  const containerRuntime = await resolveContainerRuntime(
    options.containerRuntime ?? 'auto'
  );
  if (!containerRuntime) {
    logger.error(
      `Docker action "${step.uses}" requires a container runtime (docker/podman), but none is available.`
    );
    return {
      step,
      success: false,
      error: 'No container runtime (docker/podman) available for Docker action',
      duration: Date.now() - startTime
    };
  }

  const actionDir = path.dirname(actionPath);
  const rawImage = action.runs.image;
  if (!rawImage) {
    return {
      step,
      success: false,
      error: 'No image specified for Docker action',
      duration: Date.now() - startTime
    };
  }

  let image: string;
  if (rawImage.startsWith('docker://')) {
    image = rawImage.slice('docker://'.length);
  } else {
    const dockerfileRelative =
      rawImage === 'Dockerfile' ? 'Dockerfile' : rawImage;
    const dockerfilePath = path.join(actionDir, dockerfileRelative);
    if (!fs.existsSync(dockerfilePath)) {
      return {
        step,
        success: false,
        error: `Dockerfile not found for action: ${dockerfilePath}`,
        duration: Date.now() - startTime
      };
    }

    const tag = `ghact-action-${crypto.createHash('sha1').update(actionDir).digest('hex').slice(0, 12)}`;
    logger.info(`Building Docker action image: ${action.name} (${tag})`);
    const buildResult = await containerRuntime.build(
      actionDir,
      tag,
      dockerfileRelative
    );
    if (!buildResult.success) {
      logger.error(`Docker action image build failed: ${buildResult.error}`);
      if (buildResult.stderr) logger.error(buildResult.stderr.trim());
      return {
        step,
        success: false,
        error: `Docker action image build failed: ${buildResult.error}`,
        duration: Date.now() - startTime
      };
    }
    image = tag;
  }

  // Inputs are passed as INPUT_<NAME> env vars, matching GitHub's own
  // convention (same one ghact already uses for JS actions).
  const inputEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(actionInputs)) {
    inputEnv[inputEnvName(key)] = value;
  }

  // `runs.args` may reference ${{ inputs.* }} / ${{ secrets.* }}.
  const actionCtx = createContext({}, actionInputs, options.secrets);
  const args = (action.runs.args || []).map((arg) =>
    substituteExpressions(arg, actionCtx)
  );

  logger.info(`Executing Docker action: ${action.name}`);

  const exchangeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-exchange-'));
  const files = createStepFiles(exchangeDir);

  try {
    const result = await containerRuntime.execute({
      image,
      args,
      entrypoint: action.runs.entrypoint,
      workingDir: process.cwd(),
      exchangeDir,
      env: {
        ...containerRunnerEnv(runtime, exchangeDir),
        ...callerEnv,
        ...inputEnv,
        ...fileCommandEnv(files, CONTAINER_EXCHANGE_DIR)
      },
      timeoutMs: options.containerTimeoutMs,
      memoryLimit: options.containerMemoryLimit,
      networkDisabled: options.networkDisabled !== false
    });

    const { outputs } = finishStepOutput(result.stdout, files, runtime);
    if (result.stderr) {
      logger[result.success ? 'warn' : 'error'](result.stderr.trim());
    }

    if (result.timedOut) {
      logger.error(
        `Docker action timed out after ${options.containerTimeoutMs}ms (${containerRuntime.name})`
      );
      return {
        step,
        success: false,
        error: `Timed out after ${options.containerTimeoutMs}ms`,
        output: result.stdout,
        outputs,
        duration: Date.now() - startTime
      };
    }

    if (!result.success) {
      logger.error(
        `Docker action failed (${containerRuntime.name}, exit code: ${result.exitCode})`
      );
      return {
        step,
        success: false,
        error: `Command exited with code ${result.exitCode}`,
        output: result.stdout,
        outputs,
        duration: Date.now() - startTime
      };
    }

    logger.success(`Docker action completed: ${action.name}`);

    return {
      step,
      success: true,
      output: result.stdout,
      outputs,
      duration: Date.now() - startTime
    };
  } finally {
    fs.rmSync(exchangeDir, { recursive: true, force: true });
  }
}

/**
 * Execute a JavaScript action (`runs.using: node*`): `pre` (if any) and
 * `main` now, with `post` queued on the job runtime to run at job end.
 * Scripts run with ghact's own Node binary, in the workspace, with the
 * runner's default env, the caller's env, `INPUT_*`, `STATE_*` and the
 * file-command variables. Note: GitHub runs every `pre` at job start;
 * here it runs immediately before its own `main`.
 */
async function executeNodeAction(
  action: ActionFile,
  actionPath: string,
  step: Step,
  actionInputs: Record<string, string>,
  callerCtx: ExpressionContext,
  runtime: JobRuntime,
  startTime: number
): Promise<StepResult> {
  logger.info(
    `Executing JavaScript action: ${action.name} (${action.runs.using})`
  );

  const { main, pre, post } = action.runs;
  if (!main) {
    return {
      step,
      success: false,
      error: 'No main script specified for JavaScript action',
      duration: Date.now() - startTime
    };
  }

  const actionDir = path.dirname(actionPath);
  const inputEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(actionInputs)) {
    inputEnv[inputEnvName(key)] = value;
  }

  let state: Record<string, string> = {};
  let output = '';

  const runScript = async (
    script: string
  ): Promise<{
    success: boolean;
    outputs: Record<string, string>;
    error?: string;
  }> => {
    const files = createStepFiles();
    const stateEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(state)) {
      stateEnv[`STATE_${key}`] = value;
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [path.join(actionDir, script)],
        {
          cwd: process.cwd(),
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            ...runtime.runnerEnv,
            ...callerCtx.env,
            ...inputEnv,
            ...stateEnv,
            GITHUB_ACTION_PATH: actionDir,
            PATH: prependPath(
              runtime.path,
              callerCtx.env.PATH ?? process.env.PATH
            ),
            ...fileCommandEnv(files)
          }
        }
      );
      output += stdout;
      const result = finishStepOutput(stdout, files, runtime);
      state = { ...state, ...result.state };
      if (stderr) {
        logger.warn(stderr.trim());
      }
      return { success: true, outputs: result.outputs };
    } catch (execError: unknown) {
      const error = execError as {
        message: string;
        stdout?: string;
        stderr?: string;
      };
      output += error.stdout || '';
      const result = finishStepOutput(error.stdout, files, runtime);
      state = { ...state, ...result.state };
      logger.error(`JavaScript action failed: ${error.message}`);
      if (error.stderr) {
        logger.error(error.stderr.trim());
      }
      return { success: false, outputs: result.outputs, error: error.message };
    } finally {
      cleanupStepFiles(files);
    }
  };

  if (
    pre &&
    evaluateCondition(action.runs['pre-if'] ?? 'always()', callerCtx)
  ) {
    const preResult = await runScript(pre);
    if (!preResult.success) {
      return {
        step,
        success: false,
        error: preResult.error,
        output,
        duration: Date.now() - startTime
      };
    }
  }

  if (post) {
    const postStep: Step = {
      name: `Post ${step.name || step.uses}`,
      uses: step.uses
    };
    runtime.postSteps.push({
      step: postStep,
      condition: action.runs['post-if'] ?? 'always()',
      run: async () => {
        const postStartTime = Date.now();
        output = '';
        const postResult = await runScript(post);
        return {
          step: postStep,
          success: postResult.success,
          error: postResult.error,
          output,
          outputs: postResult.outputs,
          duration: Date.now() - postStartTime
        };
      }
    });
  }

  const mainResult = await runScript(main);
  return {
    step,
    success: mainResult.success,
    error: mainResult.error,
    output,
    outputs: mainResult.outputs,
    duration: Date.now() - startTime
  };
}

/**
 * The env var an action input is exposed as. Matches the runner and
 * `@actions/core`'s getInput(): spaces become `_`, hyphens are kept
 * (`who-to-greet` -> `INPUT_WHO-TO-GREET`).
 */
function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

/**
 * Build an action's `inputs.*`: the step's `with:` values (resolved against
 * the calling step's context), falling back to each declared input's
 * `default` (which may itself contain expressions, e.g. `${{ github.token }}`).
 */
function resolveActionInputs(
  action: ActionFile,
  withValues: Record<string, unknown> | undefined,
  callerCtx: ExpressionContext
): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const [name, def] of Object.entries(action.inputs || {})) {
    if (def?.default !== undefined) {
      inputs[name] = substituteExpressions(String(def.default), callerCtx);
    }
  }
  return { ...inputs, ...substituteRecord(withValues, callerCtx) };
}

/**
 * Execute a remote action
 */
async function executeAction(
  step: Step,
  options: RunOptions,
  startTime: number,
  runtime: JobRuntime,
  ctx?: ExpressionContext
): Promise<StepResult> {
  if (!step.uses) {
    return {
      step,
      success: false,
      error: 'No action specified',
      duration: Date.now() - startTime
    };
  }

  try {
    // Fetch the action
    const actionPath = await fetchAction(step.uses);

    if (!actionPath) {
      logger.warn(`Failed to fetch action: ${step.uses} - skipping`);
      return {
        step,
        success: true,
        output: 'Skipped - could not fetch action',
        duration: Date.now() - startTime
      };
    }

    // Parse the action file
    const parsed = parseFile(actionPath);

    if (parsed.type !== 'action') {
      logger.error(`Invalid action file: ${actionPath}`);
      return {
        step,
        success: false,
        error: 'Invalid action file',
        duration: Date.now() - startTime
      };
    }

    const action = parsed.file;

    // Resolve `with:` values against the calling step's context before they
    // become the action's inputs (INPUT_* env vars / `inputs.*`).
    const callerCtx = ctx ?? createContext({}, {}, options.secrets);
    const actionInputs = resolveActionInputs(action, step.with, callerCtx);

    // Handle different action types
    if (action.runs.using === 'composite') {
      // Execute composite action steps
      logger.info(`Executing composite action: ${action.name}`);

      const compositeSteps = action.runs.steps || [];
      const outputs: Record<string, string> = {};
      // Composite steps see only the action's own inputs, plus the
      // caller's env and github context - never the workflow's inputs.
      const actionCtx: ExpressionContext = createContext(
        { ...callerCtx.env },
        actionInputs,
        options.secrets,
        callerCtx.github
      );

      for (const compositeStep of compositeSteps) {
        const envCtx: ExpressionContext = {
          ...actionCtx,
          env: { ...actionCtx.env, ...runtime.env }
        };
        const stepCtx: ExpressionContext = {
          ...envCtx,
          env: {
            ...envCtx.env,
            ...substituteRecord(compositeStep.env, envCtx)
          }
        };

        if (!evaluateCondition(compositeStep.if, stepCtx)) {
          logger.info(
            `Skipping composite step: ${compositeStep.name || compositeStep.id || 'unnamed'} (condition not met)`
          );
          if (compositeStep.id) {
            actionCtx.steps[compositeStep.id] = {
              outcome: 'skipped',
              outputs: {}
            };
          }
          continue;
        }

        const stepOptions: RunOptions = {
          ...options,
          inputs: actionInputs
        };

        const stepResult = await executeStep(
          compositeStep,
          stepOptions,
          runtime,
          stepCtx
        );

        if (compositeStep.id) {
          actionCtx.steps[compositeStep.id] = {
            outcome: stepResult.success ? 'success' : 'failure',
            outputs: stepResult.outputs || {}
          };
        }

        if (!stepResult.success) {
          actionCtx.jobFailed = true;
          return {
            step,
            success: false,
            error: `Composite action step failed: ${compositeStep.name || 'unnamed'}`,
            duration: Date.now() - startTime
          };
        }
      }

      // Resolve the action's declared outputs (e.g.
      // `outputs.greeting.value: ${{ steps.greet.outputs.greeting }}`)
      // against the accumulated step outcomes/outputs.
      for (const [outputName, outputDef] of Object.entries(
        action.outputs || {}
      )) {
        const resolved = resolveExpressionValue(outputDef.value, actionCtx);
        if (resolved !== undefined) {
          outputs[outputName] = String(resolved);
        }
      }

      return {
        step,
        success: true,
        output: JSON.stringify(outputs),
        outputs,
        duration: Date.now() - startTime
      };
    } else if (action.runs.using.startsWith('node')) {
      return await executeNodeAction(
        action,
        actionPath,
        step,
        actionInputs,
        callerCtx,
        runtime,
        startTime
      );
    } else if (action.runs.using === 'docker') {
      return await executeDockerAction(
        action,
        actionPath,
        step,
        actionInputs,
        callerCtx.env,
        options,
        runtime,
        startTime
      );
    } else {
      logger.warn(`Unknown action type: ${action.runs.using}`);
      return {
        step,
        success: true,
        output: `Skipped - Unknown action type: ${action.runs.using}`,
        duration: Date.now() - startTime
      };
    }
  } catch (error) {
    logger.error(
      `Action execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return {
      step,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration: Date.now() - startTime
    };
  }
}
