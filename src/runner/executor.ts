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

// Public API, kept here so `executor` stays the entry point.
export { parseRepositoryFromRemote } from './github-context';
export { expandMatrix, topologicalJobOrder } from './job-plan';
export {
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_RUNNER_IMAGES
} from './job-container';

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
  ctx: ExpressionContext
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

  const subResult = await executeWorkflow(resolvedPath, {
    ...options,
    inputs,
    secrets,
    // --job and --matrix select the caller's jobs, not the called ones.
    job: undefined,
    matrix: undefined
  });

  return {
    job: jobId,
    success: subResult.success,
    steps: subResult.jobs.flatMap((j) => j.steps),
    outputs: subResult.outputs ?? {},
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

      const jobs: JobResult[] = [];
      const jobResults = new Map<string, NeedsInfo>();
      const jobOrder = topologicalJobOrder(parsed.file.jobs);
      const matrixFilter = options.matrix ?? {};
      const definedMatrixKeys = new Set<string>();
      let matrixUnmatched = false;
      // --matrix: the combinations of this job to run, with their index in
      // the full expansion. None left skips the job (and fails the run).
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
          jobResults.set(jobId, { result: 'skipped', outputs: {} });
          matrixUnmatched = true;
        }
        return matches;
      };

      for (const jobId of jobOrder) {
        const job = parsed.file.jobs[jobId];

        // Skip if specific job requested and this isn't it
        if (options.job && jobId !== options.job) {
          continue;
        }

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
          ...createContext({}, inputs, options.secrets, github),
          needs,
          vars,
          dependencies: {
            allSucceeded: Object.values(needs).every(
              (n) => n.result === 'success'
            ),
            anyFailed: Object.values(needs).some((n) => n.result === 'failure')
          }
        };
        let runJob: boolean;
        try {
          runJob = evaluateCondition(withImplicitSuccess(job.if), jobIfCtx);
        } catch (error) {
          // An if: that can't be evaluated fails the job, as on GitHub.
          logger.error(ifEvaluationError(`job '${jobId}'`, error));
          jobs.push({ job: jobId, success: false, steps: [], duration: 0 });
          jobResults.set(jobId, { result: 'failure', outputs: {} });
          continue;
        }
        if (!runJob) {
          const notOk = needsIds.find((dep) => needs[dep].result !== 'success');
          logger.info(
            notOk
              ? `Skipping job: ${jobId} (dependency "${notOk}" ${needs[notOk].result === 'skipped' ? 'was skipped' : 'did not succeed'})`
              : `Skipping job: ${jobId} (condition not met)`
          );
          jobResults.set(jobId, { result: 'skipped', outputs: {} });
          continue;
        }

        // Handle reusable workflow calls (once per matrix combination)
        if (job.uses) {
          const combinations = expandMatrix(job.strategy?.matrix, jobIfCtx);
          const selected = selectCombinations(jobId, combinations);
          if (selected.length === 0) continue;
          const callOutputs: Record<string, string> = {};
          let callFailed = false;
          for (const { values: matrixValues } of selected) {
            if (callFailed && job.strategy?.['fail-fast'] !== false) break;
            const label =
              combinations.length > 1
                ? `${jobId} (${matrixLabel(matrixValues)})`
                : jobId;
            const reusableResult = await executeReusableWorkflowJob(
              label,
              job,
              filePath,
              options,
              { ...jobIfCtx, matrix: matrixValues }
            );
            jobs.push(reusableResult);
            Object.assign(callOutputs, reusableResult.outputs);
            if (!reusableResult.success) callFailed = true;
          }
          jobResults.set(jobId, {
            result: callFailed ? 'failure' : 'success',
            outputs: callOutputs
          });
          if (!callFailed) {
            logger.success(`Job ${jobId} completed successfully`);
          }
          continue;
        }

        const matrixCombinations = expandMatrix(job.strategy?.matrix, jobIfCtx);
        const selected = selectCombinations(jobId, matrixCombinations);
        if (selected.length === 0) continue;
        const failFast = job.strategy?.['fail-fast'] !== false;
        let matrixFailed = false;
        const jobOutputs: Record<string, string> = {};

        for (const { index: jobIndex, values: matrixValues } of selected) {
          if (matrixFailed && failFast) {
            logger.info(
              `Skipping remaining matrix jobs for ${jobId} (fail-fast)`
            );
            break;
          }

          const matrixSuffix =
            matrixCombinations.length > 1
              ? ` (${matrixLabel(matrixValues)})`
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

          if (
            !(await startJobServices(job, jobCtx, options, runtime)) ||
            !(await startJobContainer(job, jobCtx, options, runtime, runDir))
          ) {
            await stopJobContainer(runtime);
            jobs.push({
              job: jobLabel,
              success: false,
              steps: [],
              duration: Date.now() - jobStartTime
            });
            matrixFailed = true;
            continue;
          }

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
              runtime.actionEnv = stepActionEnv(runtime, step);
              const stepCtx: ExpressionContext = {
                ...envCtx,
                github: {
                  ...envCtx.github,
                  action: runtime.actionEnv.GITHUB_ACTION
                },
                env: { ...envCtx.env, ...substituteRecord(step.env, envCtx) }
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

              // timeout-minutes: the step's own, or what's left of the job's.
              const stepMinutes = numberSetting(
                step['timeout-minutes'],
                stepCtx
              );
              const jobLeft =
                jobDeadline !== undefined
                  ? Math.max(jobDeadline - Date.now(), 1)
                  : undefined;
              const stepMs = stepMinutes ? stepMinutes * 60_000 : undefined;
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
              if (jobDeadline !== undefined && Date.now() >= jobDeadline) {
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
                  conclusion: step['continue-on-error'] ? 'success' : outcome,
                  outputs: stepResult.outputs || {}
                };
              }

              if (!stepResult.success && !step['continue-on-error']) {
                jobCtx.jobFailed = true;
                logger.error(`Step failed: ${stepDisplayName(step, stepCtx)}`);
              }
            }

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
          // Job-level continue-on-error (often `${{ matrix.experimental }}`)
          // lets this combination fail without failing the job or run.
          const allowedFailure =
            !jobSuccess && isTruthySetting(job['continue-on-error'], jobCtx);

          jobs.push({
            job: jobLabel,
            success: jobSuccess,
            ...(allowedFailure ? { continueOnError: true } : {}),
            ...(runtime.summary ? { summary: runtime.summary } : {}),
            steps: stepResults,
            outputs: { ...jobOutputs },
            duration: Date.now() - jobStartTime
          });

          if (!jobSuccess && !allowedFailure) {
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
