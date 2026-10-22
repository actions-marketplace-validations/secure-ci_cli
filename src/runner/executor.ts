import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from '../parser/workflow-parser';
import { workflowExpressionErrors } from '../parser/validator';
import { logger } from '../utils/logger';
import {
  RunOptions,
  WorkflowResult,
  JobResult,
  StepResult,
  Job
} from '../types';
import { fetchRepoFile } from './action-fetcher';
import { repositoryRoot } from '../utils/repository';
import {
  createContext,
  evaluateCondition,
  ifEvaluationError,
  substituteRecord,
  ExpressionContext,
  NeedsInfo,
  withImplicitSuccess
} from './expression';
import { resolveContainerRuntime } from './container-runtime';
import {
  buildGithubContext,
  declaredInputDefaults,
  workflowCallOutputs,
  loadEvent,
  typedInputs
} from './github-context';
import {
  matrixLabel,
  isTruthySetting,
  expandMatrix,
  filterMatrix,
  noMatrixMatchMessage,
  numberSetting,
  topologicalJobOrder,
  unknownMatrixKeys
} from './job-plan';
import {
  createRunDir,
  runnerContext,
  createJobRuntime,
  stepActionEnv,
  stepDisplayName,
  runPostSteps
} from './job-runtime';
import {
  noRuntimeMessage,
  startJobContainer,
  stopJobContainer,
  startJobServices
} from './job-container';
import { executeStep } from './steps';
import {
  warnUnsandboxedActions,
  runPreSteps,
  isLocalActionRef
} from './actions';
import { Slots, UnitOutcome, runJobGraph, runMatrix } from './scheduler';

// Public API, kept here so `executor` stays the entry point.
export { parseRepositoryFromRemote } from './github-context';
export { expandMatrix, topologicalJobOrder } from './job-plan';
export {
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_RUNNER_IMAGES
} from './job-container';

/** The error of a step killed because its job was cancelled (GitHub's). */
const CANCELLED_MESSAGE = 'The operation was canceled.';

/** State a called workflow shares with the run that called it. */
export interface RunInternals {
  /** The run's `--parallel` slots, shared by called workflows' jobs. */
  slots?: Slots;
  /** Aborted when the calling job is cancelled. */
  signal?: AbortSignal;
}

/**
 * Execute a reusable workflow called via `jobs.<id>.uses:`: a local path
 * (`./.github/workflows/x.yml`, relative to the repository root) or a
 * remote `owner/repo/path.yml@ref`. `with:` and `secrets:` are resolved in
 * the calling job's context; the called workflow sees only those secrets
 * (all of them with `secrets: inherit`), and its `on.workflow_call.outputs`
 * become the calling job's outputs.
 */
async function executeReusableWorkflowJob(
  jobId: string,
  job: Job,
  callerPath: string,
  options: RunOptions,
  ctx: ExpressionContext,
  internal: RunInternals
): Promise<JobResult> {
  const startTime = Date.now();
  const uses = job.uses as string;
  const failed = (error: string): JobResult => {
    logger.error(error);
    return {
      job: jobId,
      success: false,
      steps: [],
      duration: Date.now() - startTime
    };
  };

  let resolvedPath: string | null;
  if (isLocalActionRef(uses)) {
    const candidates = [
      path.resolve(repositoryRoot(callerPath), uses),
      path.resolve(path.dirname(callerPath), uses)
    ];
    resolvedPath = candidates.find((file) => fs.existsSync(file)) ?? null;
    if (!resolvedPath) {
      return failed(`Reusable workflow not found: ${candidates[0]}`);
    }
  } else {
    resolvedPath = await fetchRepoFile(uses, { offline: options.offline });
    if (!resolvedPath) {
      return failed(`Could not fetch reusable workflow ${uses}`);
    }
  }

  const inputs = substituteRecord(job.with, ctx);
  const secrets: Record<string, string> =
    job.secrets === 'inherit'
      ? { ...(options.secrets || {}) }
      : {
          // GITHUB_TOKEN is always available to called workflows.
          ...(options.secrets?.GITHUB_TOKEN !== undefined
            ? { GITHUB_TOKEN: options.secrets.GITHUB_TOKEN }
            : {}),
          ...substituteRecord(job.secrets, ctx)
        };

  logger.step(`Executing reusable workflow: ${uses} (job: ${jobId})`);

  const subResult = await executeWorkflow(
    resolvedPath,
    {
      ...options,
      inputs,
      secrets,
      // --job and --matrix select the caller's jobs, not the called ones.
      job: undefined,
      matrix: undefined
    },
    internal
  );

  return {
    job: jobId,
    success: subResult.success,
    steps: subResult.jobs.flatMap((j) => j.steps),
    outputs: subResult.outputs ?? {},
    duration: Date.now() - startTime
  };
}

/**
 * Execute a workflow or action file. Jobs whose `needs:` are done, and
 * matrix combinations, run concurrently up to `options.parallel` (default
 * 1: one after another).
 */
export async function executeWorkflow(
  filePath: string,
  options: RunOptions = {},
  internal: RunInternals = {}
): Promise<WorkflowResult> {
  const startTime = Date.now();

  logger.registerSecrets(options.secrets);
  // One run id for every job and called workflow of this run.
  options = {
    ...options,
    runId: options.runId || process.env.GITHUB_RUN_ID || String(Date.now())
  };
  // Steps never fall back to running on the host: without the requested
  // container runtime, stop before anything runs. The host is opt-in
  // (--container-runtime host).
  const preference = options.containerRuntime ?? 'host';
  if (preference !== 'host' && !(await resolveContainerRuntime(preference))) {
    logger.error(noRuntimeMessage(preference));
    return { success: false, jobs: [], duration: Date.now() - startTime };
  }

  const runDir = createRunDir();

  try {
    const parsed = parseFile(filePath);

    if (parsed.type === 'workflow') {
      // Like GitHub, refuse a workflow with an invalid if: before any job.
      const invalid = workflowExpressionErrors(parsed.file);
      if (invalid.length > 0) {
        logger.error(`Invalid workflow file: ${filePath}`);
        for (const error of invalid) {
          logger.error(`  ${error.path}: ${error.message}`);
        }
        return { success: false, jobs: [], duration: Date.now() - startTime };
      }

      logger.info(`Executing workflow: ${parsed.file.name}`);

      options = {
        ...options,
        inputs: {
          ...declaredInputDefaults(parsed.file.on),
          ...(options.inputs ?? {})
        }
      };
      const event = loadEvent(options, options.inputs ?? {}, parsed.file.on);
      const inputs = typedInputs(parsed.file.on, options.inputs ?? {});
      fs.writeFileSync(
        path.join(runDir, 'event.json'),
        JSON.stringify(event.payload)
      );

      const vars = options.vars ?? {};
      const parallel = Math.max(1, Math.floor(options.parallel ?? 1));
      const concurrent = parallel > 1;
      const slots = internal.slots ?? new Slots(parallel);
      const matrixFilter = options.matrix ?? {};
      const definedMatrixKeys = new Set<string>();
      let matrixUnmatched = false;
      const order = topologicalJobOrder(parsed.file.jobs).filter(
        // With --job, only that job runs; its dependencies count as done.
        (jobId) => !options.job || jobId === options.job
      );
      // Label log lines with their job only when jobs can interleave.
      const prefixJobs =
        concurrent &&
        (order.length > 1 ||
          order.some((jobId) => parsed.file.jobs[jobId].strategy?.matrix));
      const tagged = <T>(
        label: string,
        fn: () => Promise<T>,
        replace = false
      ): Promise<T> => (prefixJobs ? logger.withJob(label, fn, replace) : fn());
      const needsOf = (jobId: string): string[] => {
        const needs = parsed.file.jobs[jobId].needs;
        return needs ? (Array.isArray(needs) ? needs : [needs]) : [];
      };
      const selectCombinations = (
        jobId: string,
        combinations: Array<Record<string, unknown>>
      ): Array<{ index: number; values: Record<string, unknown> }> => {
        for (const combo of combinations) {
          Object.keys(combo).forEach((key) => definedMatrixKeys.add(key));
        }
        const { keys, matches } = filterMatrix(combinations, matrixFilter);
        if (keys.length > 0 && matches.length === 0) {
          logger.warn(noMatrixMatchMessage(jobId, matrixFilter, combinations));
          matrixUnmatched = true;
        }
        return matches;
      };
      // Each job's results, in matrix order; collected in `order` at the end
      // so the report doesn't depend on which job finished first.
      const resultsByJob = new Map<string, JobResult[]>();

      const runJob = (
        jobId: string,
        depResults: Record<string, NeedsInfo>
      ): Promise<NeedsInfo> =>
        tagged(jobId, async (): Promise<NeedsInfo> => {
          const job = parsed.file.jobs[jobId];
          const jobs: JobResult[] = [];
          resultsByJob.set(jobId, jobs);

          const github = buildGithubContext(
            parsed.file.name,
            jobId,
            process.cwd(),
            event,
            options.secrets?.GITHUB_TOKEN,
            options.runId
          );

          // `needs` results feed the job's `if:` (implicitly `success()`,
          // which requires every dependency to have succeeded). With --job,
          // dependencies aren't run and count as successful.
          const needsIds = needsOf(jobId);
          const needs: Record<string, NeedsInfo> = {};
          for (const dep of needsIds) {
            needs[dep] = depResults[dep] ?? {
              result: 'success',
              outputs: {}
            };
          }
          const jobIfCtx: ExpressionContext = {
            ...createContext({}, inputs, options.secrets, github),
            needs,
            vars,
            dependencies: {
              allSucceeded: Object.values(needs).every(
                (n) => n.result === 'success'
              ),
              anyFailed: Object.values(needs).some(
                (n) => n.result === 'failure'
              )
            }
          };
          let runThisJob: boolean;
          try {
            runThisJob = evaluateCondition(
              withImplicitSuccess(job.if),
              jobIfCtx
            );
          } catch (error) {
            // An if: that can't be evaluated fails the job, as on GitHub.
            logger.error(ifEvaluationError(`job '${jobId}'`, error));
            jobs.push({ job: jobId, success: false, steps: [], duration: 0 });
            return { result: 'failure', outputs: {} };
          }
          if (!runThisJob) {
            const notOk = needsIds.find(
              (dep) => needs[dep].result !== 'success'
            );
            logger.info(
              notOk
                ? `Skipping job: ${jobId} (dependency "${notOk}" ${needs[notOk].result === 'skipped' ? 'was skipped' : 'did not succeed'})`
                : `Skipping job: ${jobId} (condition not met)`
            );
            return { result: 'skipped', outputs: {} };
          }

          const matrixCombinations = expandMatrix(
            job.strategy?.matrix,
            jobIfCtx
          );
          const selected = selectCombinations(jobId, matrixCombinations);
          if (selected.length === 0) return { result: 'skipped', outputs: {} };
          const failFast = job.strategy?.['fail-fast'] !== false;
          const maxParallel = numberSetting(
            job.strategy?.['max-parallel'],
            jobIfCtx
          );
          const labelOf = (matrixValues: Record<string, unknown>): string =>
            matrixCombinations.length > 1
              ? `${jobId} (${matrixLabel(matrixValues)})`
              : jobId;
          // Each combination's result and outputs, by combination index.
          const unitResults: Array<JobResult | undefined> = [];
          const unitOutputs: Array<Record<string, string>> = [];

          let outcomes: Array<UnitOutcome | undefined>;
          if (job.uses) {
            // A reusable workflow call (once per matrix combination). The
            // call itself holds no slot: the called workflow's jobs do.
            outcomes = await runMatrix(
              selected.length,
              (index, signal) => {
                const { index: combinationIndex, values: matrixValues } =
                  selected[index];
                const label = labelOf(matrixValues);
                return tagged(
                  label,
                  async (): Promise<UnitOutcome> => {
                    const reusableResult = await executeReusableWorkflowJob(
                      label,
                      job,
                      filePath,
                      options,
                      { ...jobIfCtx, matrix: matrixValues },
                      { slots, signal }
                    );
                    const cancelled = !reusableResult.success && signal.aborted;
                    unitResults[combinationIndex] = cancelled
                      ? { ...reusableResult, cancelled: true }
                      : reusableResult;
                    unitOutputs[combinationIndex] =
                      reusableResult.outputs ?? {};
                    return {
                      result: reusableResult.success
                        ? 'success'
                        : cancelled
                          ? 'cancelled'
                          : 'failure'
                    };
                  },
                  true
                );
              },
              { failFast, maxParallel, signal: internal.signal }
            );
          } else {
            // Outputs so far, as each combination's result reports them.
            const jobOutputs: Record<string, string> = {};
            // One matrix combination (or the job itself): its container,
            // services and steps. A cancelled combination (fail-fast) has
            // its running step killed and its containers removed.
            const runCombination = async (
              jobIndex: number,
              matrixValues: Record<string, unknown>,
              signal: AbortSignal
            ): Promise<UnitOutcome> => {
              const jobLabel = labelOf(matrixValues);

              const runtime = createJobRuntime(github, runDir, {
                shell:
                  job.defaults?.run?.shell ?? parsed.file.defaults?.run?.shell,
                workingDirectory:
                  job.defaults?.run?.['working-directory'] ??
                  parsed.file.defaults?.run?.['working-directory']
              });
              runtime.signal = signal;

              // Workflow-level env can't reference `env` itself; job-level
              // env sees the workflow env plus matrix (matching GitHub's
              // contexts).
              const workflowEnv = {
                ...options.env,
                ...substituteRecord(parsed.file.env, {
                  ...createContext(
                    { ...options.env },
                    inputs,
                    options.secrets,
                    github
                  ),
                  vars
                })
              };
              const jobEnv = substituteRecord(job.env, {
                ...createContext(
                  workflowEnv,
                  inputs,
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
                  inputs,
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
              const jobTimeoutMinutes = numberSetting(
                job['timeout-minutes'],
                jobCtx
              );
              const jobDeadline = jobTimeoutMinutes
                ? jobStartTime + jobTimeoutMinutes * 60_000
                : undefined;
              const jobTimeoutMessage = `The job running on runner secureci has exceeded the maximum execution time of ${jobTimeoutMinutes} minutes.`;
              const stepResults: StepResult[] = [];
              const cancelledResult = (): UnitOutcome => {
                logger.warn(`Cancelled job: ${jobLabel}`);
                unitResults[jobIndex] = {
                  job: jobLabel,
                  success: false,
                  cancelled: true,
                  steps: stepResults,
                  duration: Date.now() - jobStartTime
                };
                return { result: 'cancelled' };
              };

              // Once the containers are up, cancelling removes them, which
              // ends the step running in them.
              let stopping: Promise<void> | undefined;
              const onAbort = (): void => {
                stopping = stopJobContainer(runtime);
              };
              try {
                if (
                  !(await startJobServices(job, jobCtx, options, runtime)) ||
                  !(await startJobContainer(
                    job,
                    jobCtx,
                    options,
                    runtime,
                    runDir
                  ))
                ) {
                  await stopJobContainer(runtime);
                  if (signal.aborted) return cancelledResult();
                  unitResults[jobIndex] = {
                    job: jobLabel,
                    success: false,
                    steps: [],
                    duration: Date.now() - jobStartTime
                  };
                  return { result: 'failure' };
                }
                if (signal.aborted) {
                  await stopJobContainer(runtime);
                  return cancelledResult();
                }
                signal.addEventListener('abort', onAbort, { once: true });

                if (!runtime.container) {
                  warnUnsandboxedActions(job.steps ?? [], jobCtx, options);
                }

                try {
                  await runPreSteps(
                    job.steps ?? [],
                    options,
                    runtime,
                    jobCtx,
                    stepResults
                  );

                  // Execute each step
                  for (const step of job.steps || []) {
                    if (signal.aborted) break;
                    jobCtx.job = {
                      ...jobCtx.job,
                      status: jobCtx.jobFailed ? 'failure' : 'success'
                    };
                    // `$GITHUB_ENV` additions from earlier steps sit between
                    // the job env and this step's own `env:`.
                    const envCtx: ExpressionContext = {
                      ...jobCtx,
                      env: { ...jobCtx.env, ...runtime.env }
                    };
                    runtime.actionEnv = stepActionEnv(runtime, step);
                    const stepCtx: ExpressionContext = {
                      ...envCtx,
                      github: {
                        ...envCtx.github,
                        action: runtime.actionEnv.GITHUB_ACTION
                      },
                      env: {
                        ...envCtx.env,
                        ...substituteRecord(step.env, envCtx)
                      }
                    };

                    // After a failure, only steps whose `if:` uses a status
                    // function (always(), failure(), ...) still run.
                    let runStep: boolean;
                    try {
                      runStep = evaluateCondition(
                        withImplicitSuccess(step.if),
                        stepCtx
                      );
                    } catch (error) {
                      // An if: that can't be evaluated fails the step.
                      const message = ifEvaluationError(
                        `step '${stepDisplayName(step, stepCtx)}'`,
                        error
                      );
                      logger.error(message);
                      stepResults.push({
                        step,
                        success: false,
                        error: message,
                        duration: 0
                      });
                      if (step.id) {
                        jobCtx.steps[step.id] = {
                          outcome: 'failure',
                          conclusion: 'failure',
                          outputs: {}
                        };
                      }
                      jobCtx.jobFailed = true;
                      continue;
                    }
                    if (!runStep) {
                      logger.info(
                        `Skipping step: ${stepDisplayName(step, stepCtx)} (condition not met)`
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

                    // timeout-minutes: the step's own, or what's left of the
                    // job's.
                    const stepMinutes = numberSetting(
                      step['timeout-minutes'],
                      stepCtx
                    );
                    const jobLeft =
                      jobDeadline !== undefined
                        ? Math.max(jobDeadline - Date.now(), 1)
                        : undefined;
                    const stepMs = stepMinutes
                      ? stepMinutes * 60_000
                      : undefined;
                    runtime.stepTimeout =
                      jobLeft !== undefined &&
                      (stepMs === undefined || jobLeft < stepMs)
                        ? { ms: jobLeft, message: jobTimeoutMessage }
                        : stepMs !== undefined
                          ? {
                              ms: stepMs,
                              message: `The action '${stepDisplayName(step, stepCtx)}' has timed out after ${stepMinutes} minutes.`
                            }
                          : undefined;
                    const stepResult = await executeStep(
                      step,
                      options,
                      runtime,
                      stepCtx
                    );
                    runtime.stepTimeout = undefined;
                    stepResults.push(stepResult);
                    if (signal.aborted) {
                      // Cancelled: the step was killed; nothing else runs.
                      if (!stepResult.success) {
                        stepResult.error = CANCELLED_MESSAGE;
                      }
                      break;
                    }
                    if (
                      jobDeadline !== undefined &&
                      Date.now() >= jobDeadline
                    ) {
                      // The job is cancelled: no further steps run.
                      if (stepResult.success) {
                        stepResult.success = false;
                        stepResult.error = jobTimeoutMessage;
                      }
                      logger.error(jobTimeoutMessage);
                      jobCtx.jobFailed = true;
                      break;
                    }

                    const outcome = stepResult.success ? 'success' : 'failure';
                    if (step.id) {
                      jobCtx.steps[step.id] = {
                        outcome,
                        // continue-on-error turns a failure into a successful
                        // conclusion, which is what success()/failure() see.
                        conclusion: step['continue-on-error']
                          ? 'success'
                          : outcome,
                        outputs: stepResult.outputs || {}
                      };
                    }

                    if (!stepResult.success && !step['continue-on-error']) {
                      jobCtx.jobFailed = true;
                      logger.error(
                        `Step failed: ${stepDisplayName(step, stepCtx)}`
                      );
                    }
                  }

                  if (signal.aborted) return cancelledResult();

                  await runPostSteps(runtime, jobCtx, stepResults);
                  if (runtime.summary.trim()) {
                    logger.info(
                      `Job summary (${jobLabel}):\n${runtime.summary.trim()}`
                    );
                  }

                  jobCtx.job = {
                    ...jobCtx.job,
                    status: jobCtx.jobFailed ? 'failure' : 'success'
                  };
                  unitOutputs[jobIndex] = substituteRecord(job.outputs, {
                    ...jobCtx,
                    env: { ...jobCtx.env, ...runtime.env }
                  });
                  Object.assign(jobOutputs, unitOutputs[jobIndex]);
                } finally {
                  signal.removeEventListener('abort', onAbort);
                  await stopping;
                  await stopJobContainer(runtime);
                }
              } finally {
                await stopping;
              }

              const jobSuccess = stepResults.every(
                (s) => s.success || s.step['continue-on-error']
              );
              // Job-level continue-on-error (often
              // `${{ matrix.experimental }}`) lets this combination fail
              // without failing the job or run.
              const allowedFailure =
                !jobSuccess &&
                isTruthySetting(job['continue-on-error'], jobCtx);

              unitResults[jobIndex] = {
                job: jobLabel,
                success: jobSuccess,
                ...(allowedFailure ? { continueOnError: true } : {}),
                ...(runtime.summary ? { summary: runtime.summary } : {}),
                steps: stepResults,
                outputs: { ...jobOutputs },
                duration: Date.now() - jobStartTime
              };
              return {
                result: jobSuccess ? 'success' : 'failure',
                allowedFailure
              };
            };

            outcomes = await runMatrix(
              selected.length,
              (index, signal) => {
                const { index: jobIndex, values: matrixValues } =
                  selected[index];
                return tagged(
                  labelOf(matrixValues),
                  () => runCombination(jobIndex, matrixValues, signal),
                  true
                );
              },
              {
                failFast,
                maxParallel,
                slots,
                signal: internal.signal,
                onFailFast: () =>
                  logger.info(
                    concurrent
                      ? `Cancelling remaining matrix jobs for ${jobId} (fail-fast)`
                      : `Skipping remaining matrix jobs for ${jobId} (fail-fast)`
                  )
              }
            );
          }

          for (const result of unitResults) {
            if (result) jobs.push(result);
          }
          const failed = outcomes.some(
            (o) => o?.result === 'failure' && !o.allowedFailure
          );
          const cancelled =
            !failed && outcomes.some((o) => o?.result === 'cancelled');
          if (!failed && !cancelled) {
            logger.success(`Job ${jobId} completed successfully`);
          }
          return {
            result: failed ? 'failure' : cancelled ? 'cancelled' : 'success',
            // As if the combinations ran in order: the last one's value wins.
            outputs: Object.assign({}, ...unitOutputs)
          };
        });

      const jobResults = await runJobGraph(order, needsOf, runJob, concurrent);
      const jobs = order.flatMap((jobId) => resultsByJob.get(jobId) ?? []);

      for (const key of unknownMatrixKeys(matrixFilter, definedMatrixKeys)) {
        logger.warn(
          `--matrix ${key}: no matrix job defines this key; it was ignored`
        );
      }

      const callOutputs = workflowCallOutputs(parsed.file.on);
      return {
        success:
          !matrixUnmatched && jobs.every((j) => j.success || j.continueOnError),
        jobs,
        duration: Date.now() - startTime,
        ...(callOutputs
          ? {
              outputs: substituteRecord(callOutputs, {
                ...createContext({}, inputs, options.secrets),
                vars: options.vars ?? {},
                jobs: Object.fromEntries(jobResults)
              })
            }
          : {})
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
          options.secrets?.GITHUB_TOKEN,
          options.runId
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
        logger.error(
          `Only composite actions can be run directly; call this ${parsed.file.runs.using} action from a workflow step instead.`
        );
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
