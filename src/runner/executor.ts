import { parseFile } from '../parser/workflow-parser';
import { logger } from '../utils/logger';
import {
  RunOptions,
  WorkflowResult,
  JobResult,
  StepResult,
  Step,
  ActionFile,
  Job
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
  GithubContext,
  NeedsInfo,
  withImplicitSuccess
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
import { resolveShell, shellCommandLine } from './shell';

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

/** The triggering event: `github.event_name` and `github.event`. */
interface EventInfo {
  name: string;
  payload: Record<string, unknown>;
}

/**
 * `owner/repo` from a git remote URL (`git@host:o/r.git`,
 * `https://host/o/r`, `ssh://git@host/o/r.git`); undefined for local paths.
 */
export function parseRepositoryFromRemote(url: string): string | undefined {
  const match = url
    .trim()
    .match(
      /^(?:[\w.-]+@[\w.-]+:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function payloadString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  let value: unknown = payload;
  for (const key of keys) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Build a (best-effort, local-only) `github.*` context object. Real GitHub
 * Actions populates this from the live Actions run; locally we fall back to
 * `GITHUB_*` environment variables (if the user has set them), the event
 * payload, and local git state (HEAD, branch, `origin` remote), matching
 * act's approach of approximating the context for local runs.
 */
function buildGithubContext(
  workflowName: string,
  jobId: string,
  cwd: string,
  event: EventInfo = { name: 'workflow_dispatch', payload: {} },
  token = ''
): GithubContext {
  const env = process.env;
  const sha = env.GITHUB_SHA || tryGit('git rev-parse HEAD', cwd) || '';
  const ref =
    env.GITHUB_REF ||
    payloadString(event.payload, 'ref') ||
    (() => {
      const branch = tryGit('git rev-parse --abbrev-ref HEAD', cwd);
      return branch ? `refs/heads/${branch}` : '';
    })();
  const refName =
    env.GITHUB_REF_NAME || ref.replace(/^refs\/(heads|tags)\//, '');
  const remote = tryGit('git config --get remote.origin.url', cwd);
  const repository =
    env.GITHUB_REPOSITORY ||
    payloadString(event.payload, 'repository', 'full_name') ||
    (remote && parseRepositoryFromRemote(remote)) ||
    path.basename(cwd);

  return {
    workflow: workflowName,
    job: jobId,
    sha,
    ref,
    ref_name: refName,
    event_name: event.name,
    event: event.payload,
    actor: env.GITHUB_ACTOR || os.userInfo().username,
    repository,
    repository_owner:
      env.GITHUB_REPOSITORY_OWNER ||
      payloadString(event.payload, 'repository', 'owner', 'login') ||
      (repository.includes('/') ? repository.split('/')[0] : ''),
    run_id: env.GITHUB_RUN_ID || String(Date.now()),
    run_number: env.GITHUB_RUN_NUMBER || '1',
    run_attempt: env.GITHUB_RUN_ATTEMPT || '1',
    workspace: env.GITHUB_WORKSPACE || cwd,
    server_url: env.GITHUB_SERVER_URL || 'https://github.com',
    api_url: env.GITHUB_API_URL || 'https://api.github.com',
    // Only what the user passed as secrets.GITHUB_TOKEN: a local token is
    // never picked up implicitly, since every action in the run could read it.
    token
  };
}

/**
 * Defaults declared for `on.workflow_dispatch.inputs` / `on.workflow_call.
 * inputs`, which populate the `inputs` context when not passed explicitly.
 */
function declaredInputDefaults(on: unknown): Record<string, string> {
  const defaults: Record<string, string> = {};
  if (!on || typeof on !== 'object' || Array.isArray(on)) return defaults;
  for (const trigger of ['workflow_dispatch', 'workflow_call']) {
    const inputs = (on as Record<string, { inputs?: unknown }>)[trigger]
      ?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const [name, def] of Object.entries(
      inputs as Record<string, { default?: unknown }>
    )) {
      if (def && def.default !== undefined && !(name in defaults)) {
        defaults[name] = String(def.default);
      }
    }
  }
  return defaults;
}

/** The workflow's own triggers, in declaration order. */
function workflowTriggers(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
}

/**
 * The event for this run: `--event-name`, else $GITHUB_EVENT_NAME, else
 * workflow_dispatch if the workflow declares it, else its first trigger.
 * The payload comes from `--event-path`; without one, workflow_dispatch
 * gets `{ inputs }` like on GitHub, other events `{}`.
 */
function loadEvent(
  options: RunOptions,
  inputs: Record<string, string>,
  on: unknown
): EventInfo {
  const triggers = workflowTriggers(on);
  const name =
    options.eventName ||
    process.env.GITHUB_EVENT_NAME ||
    (triggers.includes('workflow_dispatch') || triggers.length === 0
      ? 'workflow_dispatch'
      : triggers[0]);
  if (!options.eventPath) {
    return { name, payload: name === 'workflow_dispatch' ? { inputs } : {} };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(options.eventPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Invalid event payload ${options.eventPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `Invalid event payload ${options.eventPath}: expected a JSON object`
    );
  }
  return { name, payload: payload as Record<string, unknown> };
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

      options = {
        ...options,
        inputs: {
          ...declaredInputDefaults(parsed.file.on),
          ...(options.inputs ?? {})
        }
      };
      const event = loadEvent(options, options.inputs ?? {}, parsed.file.on);
      fs.writeFileSync(
        path.join(runDir, 'event.json'),
        JSON.stringify(event.payload)
      );

      const jobs: JobResult[] = [];
      const jobResults = new Map<string, NeedsInfo>();
      const jobOrder = topologicalJobOrder(parsed.file.jobs);

      for (const jobId of jobOrder) {
        const job = parsed.file.jobs[jobId];

        // Skip if specific job requested and this isn't it
        if (options.job && jobId !== options.job) {
          continue;
        }

        const workflowDir = path.dirname(filePath);
        const github = buildGithubContext(
          parsed.file.name,
          jobId,
          process.cwd(),
          event,
          options.secrets?.GITHUB_TOKEN
        );

        // `needs` results feed the job's `if:` (implicitly `success()`,
        // which requires every dependency to have succeeded). With --job,
        // dependencies aren't run and count as successful.
        const needsIds = job.needs
          ? Array.isArray(job.needs)
            ? job.needs
            : [job.needs]
          : [];
        const needs: Record<string, NeedsInfo> = {};
        for (const dep of needsIds) {
          needs[dep] = jobResults.get(dep) ?? {
            result: 'success',
            outputs: {}
          };
        }
        const vars = options.vars ?? {};
        const jobIfCtx: ExpressionContext = {
          ...createContext({}, options.inputs, options.secrets, github),
          needs,
          vars,
          dependencies: {
            allSucceeded: Object.values(needs).every(
              (n) => n.result === 'success'
            ),
            anyFailed: Object.values(needs).some((n) => n.result === 'failure')
          }
        };
        if (!evaluateCondition(withImplicitSuccess(job.if), jobIfCtx)) {
          const notOk = needsIds.find((dep) => needs[dep].result !== 'success');
          logger.info(
            notOk
              ? `Skipping job: ${jobId} (dependency "${notOk}" ${needs[notOk].result === 'skipped' ? 'was skipped' : 'did not succeed'})`
              : `Skipping job: ${jobId} (condition not met)`
          );
          jobResults.set(jobId, { result: 'skipped', outputs: {} });
          continue;
        }

        // Handle reusable workflow calls
        if (job.uses) {
          const reusableResult = await executeReusableWorkflowJob(
            jobId,
            job,
            workflowDir,
            options
          );
          jobs.push(reusableResult);
          jobResults.set(jobId, {
            result: reusableResult.success ? 'success' : 'failure',
            outputs: reusableResult.outputs ?? {}
          });
          if (reusableResult.success) {
            logger.success(`Job ${jobId} completed successfully`);
          }
          continue;
        }

        const matrixCombinations = expandMatrix(job.strategy?.matrix);
        const failFast = job.strategy?.['fail-fast'] !== false;
        let matrixFailed = false;
        const jobOutputs: Record<string, string> = {};

        for (const [jobIndex, matrixValues] of matrixCombinations.entries()) {
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

          const runtime = createJobRuntime(github, runDir, {
            shell: job.defaults?.run?.shell ?? parsed.file.defaults?.run?.shell,
            workingDirectory:
              job.defaults?.run?.['working-directory'] ??
              parsed.file.defaults?.run?.['working-directory']
          });

          // Workflow-level env can't reference `env` itself; job-level env
          // sees the workflow env plus matrix (matching GitHub's contexts).
          const workflowEnv = substituteRecord(parsed.file.env, {
            ...createContext({}, options.inputs, options.secrets, github),
            vars
          });
          const jobEnv = substituteRecord(job.env, {
            ...createContext(
              workflowEnv,
              options.inputs,
              options.secrets,
              github,
              matrixValues
            ),
            needs,
            vars
          });
          const jobCtx: ExpressionContext = {
            ...createContext(
              { ...workflowEnv, ...jobEnv },
              options.inputs,
              options.secrets,
              github,
              matrixValues
            ),
            needs,
            vars,
            job: { status: 'success' },
            runner: runnerContext(runtime),
            strategy: {
              'fail-fast': failFast,
              'job-index': jobIndex,
              'job-total': matrixCombinations.length,
              'max-parallel':
                job.strategy?.['max-parallel'] ?? matrixCombinations.length
            }
          };

          logger.step(`Executing job: ${jobLabel}`);
          const jobStartTime = Date.now();
          const stepResults: StepResult[] = [];

          if (
            !(await startJobContainer(job, jobCtx, options, runtime, runDir))
          ) {
            jobs.push({
              job: jobLabel,
              success: false,
              steps: [],
              duration: Date.now() - jobStartTime
            });
            matrixFailed = true;
            continue;
          }

          try {
            // Execute each step
            for (const step of job.steps || []) {
              jobCtx.job = {
                ...jobCtx.job,
                status: jobCtx.jobFailed ? 'failure' : 'success'
              };
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

              // After a failure, only steps whose `if:` uses a status
              // function (always(), failure(), ...) still run.
              if (!evaluateCondition(withImplicitSuccess(step.if), stepCtx)) {
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
                  jobCtx.steps[step.id] = {
                    outcome: 'skipped',
                    conclusion: 'skipped',
                    outputs: {}
                  };
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

              const outcome = stepResult.success ? 'success' : 'failure';
              if (step.id) {
                jobCtx.steps[step.id] = {
                  outcome,
                  // continue-on-error turns a failure into a successful
                  // conclusion, which is what success()/failure() see.
                  conclusion: step['continue-on-error'] ? 'success' : outcome,
                  outputs: stepResult.outputs || {}
                };
              }

              if (!stepResult.success && !step['continue-on-error']) {
                jobCtx.jobFailed = true;
                logger.error(`Step failed: ${step.name || 'unnamed'}`);
              }
            }

            await runPostSteps(runtime, jobCtx, stepResults);

            jobCtx.job = {
              ...jobCtx.job,
              status: jobCtx.jobFailed ? 'failure' : 'success'
            };
            Object.assign(
              jobOutputs,
              substituteRecord(job.outputs, {
                ...jobCtx,
                env: { ...jobCtx.env, ...runtime.env }
              })
            );
          } finally {
            await stopJobContainer(runtime);
          }

          const jobSuccess = stepResults.every(
            (s) => s.success || s.step['continue-on-error']
          );

          jobs.push({
            job: jobLabel,
            success: jobSuccess,
            steps: stepResults,
            outputs: { ...jobOutputs },
            duration: Date.now() - jobStartTime
          });

          if (!jobSuccess) {
            matrixFailed = true;
          }
        }

        const jobSuccess = !matrixFailed;
        jobResults.set(jobId, {
          result: jobSuccess ? 'success' : 'failure',
          outputs: jobOutputs
        });

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
        const github = buildGithubContext(
          parsed.file.name,
          'action',
          process.cwd(),
          undefined,
          options.secrets?.GITHUB_TOKEN
        );
        const runtime = createJobRuntime(github, runDir);
        const actionCtx = createContext(
          {},
          options.inputs,
          options.secrets,
          github
        );
        if (
          !(await startJobContainer(
            undefined,
            actionCtx,
            options,
            runtime,
            runDir
          ))
        ) {
          return { success: false, jobs: [], duration: Date.now() - startTime };
        }

        try {
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
        } finally {
          await stopJobContainer(runtime);
        }
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
  /** Set when the job's steps run in a container (see startJobContainer). */
  container?: JobContainerHandle;
  /** `defaults.run` (job-level, else workflow-level) for `run:` steps. */
  defaults: { shell?: string; workingDirectory?: string };
}

/** A per-job container that `run:` steps and JS actions are exec'd into. */
interface JobContainerHandle {
  runtime: ContainerRuntime;
  id: string;
  image: string;
  /** Host directory mounted at CONTAINER_EXCHANGE_DIR. */
  exchangeDir: string;
  /** Whether the image has bash (decides the default shell). */
  bash: boolean;
  /** The image's `node` and base PATH, probed once; null if no node. */
  node?: { path: string; basePath: string } | null;
  /** Host action directory -> its copy's path inside the container. */
  actionDirs: Map<string, string>;
}

const activeContainers = new Set<JobContainerHandle>();
let containerCleanupInstalled = false;

/**
 * Make sure job containers are removed if the CLI exits early (Ctrl-C,
 * SIGTERM, or an exit that skips the normal per-job cleanup).
 */
function installContainerCleanup(): void {
  if (containerCleanupInstalled) return;
  containerCleanupInstalled = true;

  const cleanup = (): void => {
    for (const container of activeContainers) {
      container.runtime.stopSync(container.id);
    }
    activeContainers.clear();
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

/**
 * Start the job's container when container isolation is on, using
 * `jobs.<id>.container` if set, else `--container-image`. Returns false
 * only when a runtime is available but the container can't be started (the
 * job then fails); with no runtime available, steps run on the host.
 */
async function startJobContainer(
  job: Job | undefined,
  ctx: ExpressionContext,
  options: RunOptions,
  runtime: JobRuntime,
  runDir: string
): Promise<boolean> {
  const preference = options.containerRuntime ?? 'none';
  const spec =
    typeof job?.container === 'string'
      ? { image: job.container }
      : job?.container;

  if (preference === 'none') {
    if (spec) {
      logger.warn(
        `Ignoring jobs.<id>.container (${spec.image}): container runtime is "none", running on the host.`
      );
    }
    return true;
  }

  const containerRuntime = await resolveContainerRuntime(preference);
  if (!containerRuntime) {
    logger.warn(
      `No "${preference}" container runtime available; falling back to host execution.`
    );
    return true;
  }

  if (
    spec &&
    'image' in spec &&
    (('options' in spec && spec.options) ||
      ('volumes' in spec && spec.volumes) ||
      ('ports' in spec && spec.ports) ||
      ('credentials' in spec && spec.credentials))
  ) {
    logger.warn(
      'jobs.<id>.container: only image and env are supported; ignoring options/volumes/ports/credentials.'
    );
  }

  const image = spec?.image
    ? substituteExpressions(spec.image, ctx)
    : options.containerImage || DEFAULT_CONTAINER_IMAGE;
  const containerEnv = substituteRecord(
    spec && 'env' in spec ? spec.env : undefined,
    ctx
  );

  const exchangeDir = fs.mkdtempSync(path.join(runDir, 'container-'));
  fs.chmodSync(exchangeDir, 0o777);
  fs.copyFileSync(runtime.eventPath, path.join(exchangeDir, 'event.json'));

  logger.info(`Starting job container: ${image} (${containerRuntime.name})`);
  const started = await containerRuntime.start({
    image,
    workingDir: process.cwd(),
    exchangeDir,
    env: containerEnv,
    memoryLimit: options.containerMemoryLimit,
    networkDisabled: options.networkDisabled === true
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

async function stopJobContainer(runtime: JobRuntime): Promise<void> {
  const container = runtime.container;
  if (!container) return;
  activeContainers.delete(container);
  runtime.container = undefined;
  await container.runtime.stop(container.id);
}

/** Step files inside the job container's exchange dir, writable from it. */
function createContainerStepFiles(container: JobContainerHandle): {
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

/** `export PATH=...` prefix applying `$GITHUB_PATH` additions in a shell. */
function containerPathPrefix(runtime: JobRuntime): string {
  return runtime.path.length
    ? `export PATH="${runtime.path.join(':')}:$PATH"\n`
    : '';
}

/**
 * Create the per-run scratch directory holding the event payload
 * (`$GITHUB_EVENT_PATH`) and `$RUNNER_TEMP`.
 */
function createRunDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-run-'));
  fs.writeFileSync(path.join(dir, 'event.json'), '{}');
  fs.mkdirSync(path.join(dir, 'tmp'));
  return dir;
}

/** The `runner` context, derived from the runner env. */
function runnerContext(runtime: JobRuntime): Record<string, unknown> {
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
function hostHasBash(): boolean {
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

function createJobRuntime(
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
    defaults
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
 * payload at their mounted paths (the event payload is copied into the
 * exchange dir's root).
 */
function containerRunnerEnv(runtime: JobRuntime): Record<string, string> {
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

      if (runtime.container) {
        return await executeInJobContainer(
          runtime.container,
          runtime,
          step,
          options,
          command,
          startTime,
          mergedEnv
        );
      }

      const files = createStepFiles();
      const shell = resolveShell(step.shell ?? runtime.defaults.shell, {
        bashAvailable: hostHasBash()
      });
      const scriptPath = path.join(files.dir, `script${shell.extension}`);
      fs.writeFileSync(scriptPath, command);
      const workingDirectory =
        step['working-directory'] ?? runtime.defaults.workingDirectory;

      try {
        const { stdout, stderr } = await execAsync(
          shellCommandLine(shell.template, scriptPath),
          {
            cwd: workingDirectory
              ? path.resolve(process.cwd(), workingDirectory)
              : process.cwd(),
            env: {
              ...process.env,
              ...runtime.runnerEnv,
              ...mergedEnv,
              PATH: prependPath(
                runtime.path,
                mergedEnv.PATH ?? process.env.PATH
              ),
              ...fileCommandEnv(files)
            }
          }
        );

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
 * Execute a `run:` step's command inside the job's container, so files and
 * tools from earlier steps in the job are still there. File commands are
 * exchanged through a per-step directory in the mounted exchange dir.
 */
async function executeInJobContainer(
  container: JobContainerHandle,
  runtime: JobRuntime,
  step: Step,
  options: RunOptions,
  command: string,
  startTime: number,
  mergedEnv: Record<string, string>
): Promise<StepResult> {
  const { files, containerDir } = createContainerStepFiles(container);

  try {
    const workingDirectory =
      step['working-directory'] ?? runtime.defaults.workingDirectory;
    const workingDir = workingDirectory
      ? path.posix.resolve(CONTAINER_WORKDIR, workingDirectory)
      : CONTAINER_WORKDIR;

    const shell = resolveShell(step.shell ?? runtime.defaults.shell, {
      bashAvailable: container.bash
    });
    const scriptName = `script${shell.extension}`;
    fs.writeFileSync(path.join(files.dir, scriptName), command, {
      mode: 0o644
    });

    const result = await container.runtime.exec(container.id, {
      command:
        containerPathPrefix(runtime) +
        shellCommandLine(shell.template, `${containerDir}/${scriptName}`),
      workingDir,
      env: {
        ...containerRunnerEnv(runtime),
        ...mergedEnv,
        ...fileCommandEnv(files, containerDir)
      },
      timeoutMs: options.containerTimeoutMs
    });

    const { outputs } = finishStepOutput(result.stdout, files, runtime);
    if (result.stderr) {
      logger[result.success ? 'warn' : 'error'](result.stderr.trim());
    }

    if (result.timedOut) {
      logger.error(
        `Step timed out after ${options.containerTimeoutMs}ms (container: ${container.runtime.name})`
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
        `Step failed (container: ${container.runtime.name}, exit code: ${result.exitCode})`
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
      `Step completed: ${step.name || 'unnamed'} (container: ${container.runtime.name})`
    );

    return {
      step,
      success: true,
      output: result.stdout,
      outputs,
      duration: Date.now() - startTime
    };
  } finally {
    cleanupStepFiles(files);
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

    const tag = `secureci-action-${crypto.createHash('sha1').update(actionDir).digest('hex').slice(0, 12)}`;
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
  // convention (the same one used for JS actions).
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

  const exchangeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'secureci-exchange-')
  );
  const files = createStepFiles(exchangeDir);
  fs.copyFileSync(runtime.eventPath, path.join(exchangeDir, 'event.json'));

  try {
    const result = await containerRuntime.execute({
      image,
      args,
      entrypoint: action.runs.entrypoint,
      workingDir: process.cwd(),
      exchangeDir,
      env: {
        ...containerRunnerEnv(runtime),
        ...callerEnv,
        ...inputEnv,
        ...fileCommandEnv(files, CONTAINER_EXCHANGE_DIR)
      },
      timeoutMs: options.containerTimeoutMs,
      memoryLimit: options.containerMemoryLimit,
      networkDisabled: options.networkDisabled === true
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
 * Scripts run with the CLI's own Node binary, in the workspace, with the
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
  options: RunOptions,
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

  // In a job container, run the action there with the image's own `node`,
  // from a copy of the action in the mounted exchange dir.
  const container = runtime.container;
  let containerActionDir: string | undefined;
  if (container) {
    if (container.node === undefined) {
      const probe = await container.runtime.exec(container.id, {
        command: `command -v node && printf '%s\\n' "$PATH"`
      });
      const [nodePath, basePath] = probe.stdout.trim().split('\n');
      container.node =
        probe.success && nodePath
          ? { path: nodePath.trim(), basePath: (basePath || '').trim() }
          : null;
    }
    if (!container.node) {
      const error = `JavaScript action "${step.uses}" needs \`node\` in the job container image (${container.image}). Use an image that includes Node.js (e.g. --container-image node:20, or catthehacker/ubuntu:act-22.04), or run on the host with --container-runtime none.`;
      logger.error(error);
      return { step, success: false, error, duration: Date.now() - startTime };
    }

    containerActionDir = container.actionDirs.get(actionDir);
    if (!containerActionDir) {
      const hash = crypto
        .createHash('sha1')
        .update(actionDir)
        .digest('hex')
        .slice(0, 12);
      fs.cpSync(actionDir, path.join(container.exchangeDir, 'actions', hash), {
        recursive: true
      });
      containerActionDir = `${CONTAINER_EXCHANGE_DIR}/actions/${hash}`;
      container.actionDirs.set(actionDir, containerActionDir);
    }
  }

  let state: Record<string, string> = {};
  let output = '';

  /** Run one script (pre/main/post) on the host or in the job container. */
  const invokeScript = async (
    script: string,
    files: StepFiles,
    containerDir: string | undefined,
    stateEnv: Record<string, string>
  ): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    error?: string;
  }> => {
    if (container?.node && containerActionDir && containerDir) {
      // Exec node directly (no shell), so hyphenated INPUT_* names survive.
      const scriptPath = path.posix.join(containerActionDir, script);
      const result = await container.runtime.exec(container.id, {
        args: [container.node.path, scriptPath],
        workingDir: CONTAINER_WORKDIR,
        env: {
          ...containerRunnerEnv(runtime),
          ...callerCtx.env,
          ...inputEnv,
          ...stateEnv,
          GITHUB_ACTION_PATH: containerActionDir,
          PATH: [...runtime.path, container.node.basePath]
            .filter(Boolean)
            .join(':'),
          ...fileCommandEnv(files, containerDir)
        },
        timeoutMs: options.containerTimeoutMs
      });
      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.success
          ? undefined
          : result.timedOut
            ? `Timed out after ${options.containerTimeoutMs}ms`
            : `node exited with code ${result.exitCode}`
      };
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
      return { success: true, stdout, stderr };
    } catch (execError: unknown) {
      const error = execError as {
        message: string;
        stdout?: string;
        stderr?: string;
      };
      return {
        success: false,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        error: error.message
      };
    }
  };

  const runScript = async (
    script: string
  ): Promise<{
    success: boolean;
    outputs: Record<string, string>;
    error?: string;
  }> => {
    const { files, containerDir } = container
      ? createContainerStepFiles(container)
      : { files: createStepFiles(), containerDir: undefined };
    const stateEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(state)) {
      stateEnv[`STATE_${key}`] = value;
    }

    try {
      const result = await invokeScript(script, files, containerDir, stateEnv);
      output += result.stdout;
      const { outputs, state: savedState } = finishStepOutput(
        result.stdout,
        files,
        runtime
      );
      state = { ...state, ...savedState };

      if (result.success) {
        if (result.stderr) {
          logger.warn(result.stderr.trim());
        }
        return { success: true, outputs };
      }

      logger.error(`JavaScript action failed: ${result.error}`);
      if (result.stderr) {
        logger.error(result.stderr.trim());
      }
      return { success: false, outputs, error: result.error };
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

/** Marks a `path:` copy made by localCheckout, so it may be replaced. */
const CHECKOUT_MARKER = '.secureci-checkout';

/**
 * Copy `srcDir` into `dstDir`, skipping `exclude` (the copy's own location,
 * which may lie inside `srcDir`) and earlier local checkout copies.
 */
function copyWorkingCopy(
  srcDir: string,
  dstDir: string,
  exclude: string
): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (src === exclude) continue;
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(src, CHECKOUT_MARKER))) continue;
      if (exclude.startsWith(src + path.sep)) {
        copyWorkingCopy(src, dst, exclude);
        continue;
      }
    }
    fs.cpSync(src, dst, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => !fs.existsSync(path.join(file, CHECKOUT_MARKER))
    });
  }
}

/**
 * Whether a step is `actions/checkout` of the repository being run (no
 * `repository:` input, or the current one in any case), which is served
 * from the local working copy rather than cloned.
 */
function isLocalCheckout(
  uses: string,
  withValues: Step['with'],
  ctx: ExpressionContext
): boolean {
  if (!/^actions\/checkout@/i.test(uses)) return false;
  const repository = substituteRecord(withValues, ctx).repository ?? '';
  return (
    repository === '' ||
    repository.toLowerCase() === String(ctx.github.repository).toLowerCase()
  );
}

/**
 * `actions/checkout` of the current repository: the workspace already is
 * the user's working copy (uncommitted changes included), so nothing is
 * cloned and `.git` is never touched. With `path:`, the working copy is
 * copied into that subdirectory and the copy is removed at job end.
 */
function localCheckout(
  step: Step,
  ctx: ExpressionContext,
  runtime: JobRuntime,
  startTime: number
): StepResult {
  const withValues = substituteRecord(step.with, ctx);
  const outputs = {
    ref: String(ctx.github.ref ?? ''),
    commit: String(ctx.github.sha ?? '')
  };
  const fail = (error: string): StepResult => {
    logger.error(error);
    return { step, success: false, error, duration: Date.now() - startTime };
  };

  const ref = withValues.ref;
  if (
    ref &&
    ![ctx.github.ref, ctx.github.ref_name, ctx.github.sha].includes(ref)
  ) {
    logger.warn(
      `actions/checkout: ignoring ref "${ref}"; using the local working copy (pass --no-local-checkout to run the real action)`
    );
  }

  const workspace = process.cwd();
  const dest = path.resolve(workspace, withValues.path || '.');
  const relative = path.relative(workspace, dest);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return fail(
      `actions/checkout: path "${withValues.path}" is outside the workspace`
    );
  }

  let output = 'Using local working copy';
  if (relative !== '') {
    if (fs.existsSync(dest)) {
      if (fs.existsSync(path.join(dest, CHECKOUT_MARKER))) {
        fs.rmSync(dest, { recursive: true, force: true });
      } else if (fs.readdirSync(dest).length > 0) {
        return fail(
          `actions/checkout: path "${withValues.path}" already exists in the working copy; remove it or pass --no-local-checkout`
        );
      }
    }
    copyWorkingCopy(workspace, dest, dest);
    fs.writeFileSync(path.join(dest, CHECKOUT_MARKER), '');
    output = `Using local working copy (copied to ${relative})`;

    const postStep: Step = { name: `Post ${step.name || step.uses}` };
    runtime.postSteps.push({
      step: postStep,
      condition: 'always()',
      run: async () => {
        fs.rmSync(dest, { recursive: true, force: true });
        return { step: postStep, success: true, duration: 0 };
      }
    });
  }

  logger.info(output);
  return {
    step,
    success: true,
    output,
    outputs,
    duration: Date.now() - startTime
  };
}

function isLocalActionRef(uses: string): boolean {
  return uses.startsWith('./') || uses.startsWith('../');
}

/**
 * Resolve a local action (`uses: ./path/to/action`) relative to the
 * workspace, like the runner does, to its action.yml / action.yaml.
 */
function resolveLocalAction(uses: string): string | null {
  const dir = path.resolve(process.cwd(), uses);
  for (const name of ['action.yml', 'action.yaml']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Split a `with.args` string into argv, honouring simple quoting. */
function splitArgs(args: string): string[] {
  return (args.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((arg) =>
    /^(["']).*\1$/.test(arg) ? arg.slice(1, -1) : arg
  );
}

/**
 * Execute an action step: local (`./`), remote (`owner/repo@ref`) or
 * `docker://image`.
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
    const callerCtx = ctx ?? createContext({}, {}, options.secrets);

    // `uses: docker://image` runs the image directly, with `with.args` /
    // `with.entrypoint` as its argv and entrypoint.
    if (step.uses.startsWith('docker://')) {
      const withValues = substituteRecord(step.with, callerCtx);
      const dockerAction: ActionFile = {
        name: step.uses,
        description: '',
        runs: {
          using: 'docker',
          image: step.uses,
          entrypoint: withValues.entrypoint,
          args: withValues.args ? splitArgs(withValues.args) : []
        }
      };
      return await executeDockerAction(
        dockerAction,
        path.join(process.cwd(), 'action.yml'),
        step,
        {},
        callerCtx.env,
        options,
        runtime,
        startTime
      );
    }

    if (
      options.localCheckout !== false &&
      isLocalCheckout(step.uses, step.with, callerCtx)
    ) {
      return localCheckout(step, callerCtx, runtime, startTime);
    }

    const actionPath = isLocalActionRef(step.uses)
      ? resolveLocalAction(step.uses)
      : await fetchAction(step.uses);

    if (!actionPath) {
      const error = `Could not resolve action "${step.uses}"${
        isLocalActionRef(step.uses)
          ? ` (no action.yml or action.yaml in ${path.resolve(process.cwd(), step.uses)})`
          : ''
      }`;
      logger.error(error);
      return {
        step,
        success: false,
        error,
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
    const actionInputs = resolveActionInputs(action, step.with, callerCtx);

    // Handle different action types
    if (action.runs.using === 'composite') {
      // Execute composite action steps
      logger.info(`Executing composite action: ${action.name}`);

      const compositeSteps = action.runs.steps || [];
      const outputs: Record<string, string> = {};
      // Composite steps see only the action's own inputs, plus the
      // caller's env and github context - never the workflow's inputs.
      const actionCtx: ExpressionContext = {
        ...createContext(
          { ...callerCtx.env },
          actionInputs,
          options.secrets,
          callerCtx.github
        ),
        vars: callerCtx.vars,
        job: callerCtx.job,
        runner: callerCtx.runner,
        strategy: callerCtx.strategy
      };

      // `defaults.run` doesn't apply inside composite actions.
      const callerDefaults = runtime.defaults;
      runtime.defaults = {};
      try {
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
      } finally {
        runtime.defaults = callerDefaults;
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
    } else if (/^node\d+$/.test(action.runs.using)) {
      return await executeNodeAction(
        action,
        actionPath,
        step,
        actionInputs,
        callerCtx,
        options,
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
      const error = `Unsupported action type "${action.runs.using}" in ${step.uses}`;
      logger.error(error);
      return {
        step,
        success: false,
        error,
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
