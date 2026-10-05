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
import { exec } from 'child_process';
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
  ExpressionContext,
  GithubContext
} from './expression';
import { execSync } from 'child_process';
import {
  resolveContainerRuntime,
  ContainerRuntime,
  CONTAINER_EXCHANGE_DIR
} from './container-runtime';

const DEFAULT_CONTAINER_IMAGE = 'ubuntu:22.04';

const execAsync = promisify(exec);

/**
 * Parse a `$GITHUB_OUTPUT` file written by a step, supporting both the
 * simple `name=value` form and the multiline heredoc form:
 * `name<<DELIMITER` ... `DELIMITER`.
 */
function parseGithubOutputFile(filePath: string): Record<string, string> {
  const outputs: Record<string, string> = {};

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return outputs;
  }

  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }

    const heredocMatch = line.match(/^([^=<]+)<<(.+)$/);
    if (heredocMatch) {
      const [, name, delimiter] = heredocMatch;
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      outputs[name.trim()] = valueLines.join('\n');
      i++; // Skip the closing delimiter line
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex > -1) {
      const name = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1);
      outputs[name] = value;
    }
    i++;
  }

  return outputs;
}

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
function topologicalJobOrder(
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

          const jobCtx = createContext(
            { ...(parsed.file.env || {}), ...(job.env || {}) },
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

          // Execute each step
          for (const step of job.steps || []) {
            const stepCtx: ExpressionContext = {
              ...jobCtx,
              env: { ...jobCtx.env, ...(step.env || {}) }
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

            const stepResult = await executeStep(step, options, stepCtx);
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

        for (const step of parsed.file.runs.steps) {
          const stepResult = await executeStep(step, options);
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
  }
}

/**
 * Execute a single step
 */
async function executeStep(
  step: Step,
  options: RunOptions,
  ctx?: ExpressionContext
): Promise<StepResult> {
  const startTime = Date.now();

  try {
    if (step.name) {
      logger.info(`Running: ${step.name}`);
    }

    // Handle 'uses' actions - fetch and execute remote actions
    if (step.uses) {
      return await executeAction(step, options, startTime);
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

      // Merge workflow-level, job-level, and step-level `env:` (ctx.env
      // already combines all three - see jobCtx/stepCtx construction in
      // executeWorkflow). Fall back to step.env alone when no context is
      // available (e.g. composite action steps run outside a job).
      const mergedEnv = ctx ? ctx.env : step.env;

      const containerPreference = options.containerRuntime ?? 'none';
      if (containerPreference !== 'none') {
        const runtime = await resolveContainerRuntime(containerPreference);
        if (runtime) {
          return await executeInContainer(
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

      const outputFilePath = path.join(
        os.tmpdir(),
        `actly-output-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      fs.writeFileSync(outputFilePath, '');

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: step['working-directory'] || process.cwd(),
          shell: step.shell || 'bash',
          env: {
            ...process.env,
            ...mergedEnv,
            GITHUB_OUTPUT: outputFilePath
          }
        });

        if (stdout) {
          logger.info(stdout.trim());
        }
        if (stderr) {
          logger.warn(stderr.trim());
        }

        logger.success(`Step completed: ${step.name || 'unnamed'}`);

        const outputs = parseGithubOutputFile(outputFilePath);

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

        if (error.stdout) {
          logger.info(error.stdout.trim());
        }
        if (error.stderr) {
          logger.error(error.stderr.trim());
        }

        const outputs = parseGithubOutputFile(outputFilePath);

        return {
          step,
          success: false,
          error: error.message,
          output: error.stdout,
          outputs,
          duration: Date.now() - startTime
        };
      } finally {
        try {
          fs.unlinkSync(outputFilePath);
        } catch {
          // Ignore cleanup errors
        }
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
 * working directory and a scratch "exchange" directory (used to carry
 * `$GITHUB_OUTPUT` back out of the container) as volumes.
 */
async function executeInContainer(
  runtime: ContainerRuntime,
  step: Step,
  options: RunOptions,
  command: string,
  startTime: number,
  mergedEnv?: Record<string, string>
): Promise<StepResult> {
  const exchangeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actly-exchange-'));
  const containerOutputPath = `${CONTAINER_EXCHANGE_DIR}/output`;

  try {
    const workingDir = step['working-directory']
      ? `cd '${step['working-directory'].replace(/'/g, "'\\''")}' && ${command}`
      : command;

    const result = await runtime.execute({
      image: options.containerImage || DEFAULT_CONTAINER_IMAGE,
      command: workingDir,
      workingDir: process.cwd(),
      exchangeDir,
      env: {
        ...(mergedEnv ?? step.env),
        GITHUB_OUTPUT: containerOutputPath
      },
      timeoutMs: options.containerTimeoutMs,
      memoryLimit: options.containerMemoryLimit,
      networkDisabled: options.networkDisabled !== false
    });

    if (result.stdout) {
      logger.info(result.stdout.trim());
    }
    if (result.stderr) {
      logger[result.success ? 'warn' : 'error'](result.stderr.trim());
    }

    const outputs = parseGithubOutputFile(path.join(exchangeDir, 'output'));

    if (result.timedOut) {
      logger.error(
        `Step timed out after ${options.containerTimeoutMs}ms (container: ${runtime.name})`
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
        `Step failed (container: ${runtime.name}, exit code: ${result.exitCode})`
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
      `Step completed: ${step.name || 'unnamed'} (container: ${runtime.name})`
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
  options: RunOptions,
  startTime: number
): Promise<StepResult> {
  const runtime = await resolveContainerRuntime(
    options.containerRuntime ?? 'auto'
  );
  if (!runtime) {
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

    const tag = `actly-action-${crypto.createHash('sha1').update(actionDir).digest('hex').slice(0, 12)}`;
    logger.info(`Building Docker action image: ${action.name} (${tag})`);
    const buildResult = await runtime.build(actionDir, tag, dockerfileRelative);
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
  // convention (same one actly already uses for JS actions).
  const mergedInputs: Record<string, string> = {};
  const env: Record<string, string> = {};
  if (step.with) {
    for (const [key, value] of Object.entries(step.with)) {
      mergedInputs[key] = String(value);
      env[`INPUT_${key.toUpperCase().replace(/-/g, '_')}`] = String(value);
    }
  }

  // `runs.args` may reference ${{ inputs.* }} / ${{ secrets.* }}.
  const actionCtx = createContext({}, mergedInputs, options.secrets);
  const args = (action.runs.args || []).map((arg) =>
    substituteExpressions(arg, actionCtx)
  );

  logger.info(`Executing Docker action: ${action.name}`);

  const exchangeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actly-exchange-'));
  const containerOutputPath = `${CONTAINER_EXCHANGE_DIR}/output`;

  try {
    const result = await runtime.execute({
      image,
      args,
      entrypoint: action.runs.entrypoint,
      workingDir: process.cwd(),
      exchangeDir,
      env: { ...env, GITHUB_OUTPUT: containerOutputPath },
      timeoutMs: options.containerTimeoutMs,
      memoryLimit: options.containerMemoryLimit,
      networkDisabled: options.networkDisabled !== false
    });

    if (result.stdout) {
      logger.info(result.stdout.trim());
    }
    if (result.stderr) {
      logger[result.success ? 'warn' : 'error'](result.stderr.trim());
    }

    const outputs = parseGithubOutputFile(path.join(exchangeDir, 'output'));

    if (result.timedOut) {
      logger.error(
        `Docker action timed out after ${options.containerTimeoutMs}ms (${runtime.name})`
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
        `Docker action failed (${runtime.name}, exit code: ${result.exitCode})`
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
 * Execute a remote action
 */
async function executeAction(
  step: Step,
  options: RunOptions,
  startTime: number
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

    // Handle different action types
    if (action.runs.using === 'composite') {
      // Execute composite action steps
      logger.info(`Executing composite action: ${action.name}`);

      const compositeSteps = action.runs.steps || [];
      const outputs: Record<string, string> = {};
      const actionCtx: ExpressionContext = createContext(
        {},
        {},
        options.secrets
      );

      for (const compositeStep of compositeSteps) {
        // Merge step inputs with action inputs
        // Convert all input values to strings for compatibility
        const mergedInputs: Record<string, string> = {};

        if (options.inputs) {
          Object.assign(mergedInputs, options.inputs);
        }

        if (step.with) {
          for (const [key, value] of Object.entries(step.with)) {
            mergedInputs[key] = String(value);
          }
        }

        const stepCtx: ExpressionContext = {
          ...actionCtx,
          inputs: mergedInputs,
          env: { ...actionCtx.env, ...(compositeStep.env || {}) }
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
          inputs: mergedInputs
        };

        const stepResult = await executeStep(
          compositeStep,
          stepOptions,
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
      // Execute JavaScript action (node12, node16, node20, node22, etc.)
      logger.info(
        `Executing JavaScript action: ${action.name} (${action.runs.using})`
      );

      const mainScript = action.runs.main;
      if (!mainScript) {
        return {
          step,
          success: false,
          error: 'No main script specified for JavaScript action',
          duration: Date.now() - startTime
        };
      }

      // Get the action directory
      const actionDir = actionPath.substring(0, actionPath.lastIndexOf('/'));
      const scriptPath = `${actionDir}/${mainScript}`;

      // Prepare environment variables for inputs
      const env = { ...process.env };

      if (step.with) {
        for (const [key, value] of Object.entries(step.with)) {
          env[`INPUT_${key.toUpperCase().replace(/-/g, '_')}`] = String(value);
        }
      }

      // Execute the script
      try {
        const { stdout, stderr } = await execAsync(`node ${scriptPath}`, {
          cwd: actionDir,
          env
        });

        if (stdout) {
          logger.info(stdout.trim());
        }
        if (stderr) {
          logger.warn(stderr.trim());
        }

        return {
          step,
          success: true,
          output: stdout,
          duration: Date.now() - startTime
        };
      } catch (execError: unknown) {
        const error = execError as {
          message: string;
          stdout?: string;
          stderr?: string;
        };
        logger.error(`JavaScript action failed: ${error.message}`);

        return {
          step,
          success: false,
          error: error.message,
          output: error.stdout,
          duration: Date.now() - startTime
        };
      }
    } else if (action.runs.using === 'docker') {
      return await executeDockerAction(
        action,
        actionPath,
        step,
        options,
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
