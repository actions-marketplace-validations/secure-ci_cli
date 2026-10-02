import { parseFile } from '../parser/workflow-parser';
import { logger } from '../utils/logger';
import {
  RunOptions,
  WorkflowResult,
  JobResult,
  StepResult,
  Step
} from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fetchAction } from './action-fetcher';
import {
  createContext,
  evaluateCondition,
  resolveExpressionValue,
  ExpressionContext
} from './expression';
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

        // Handle reusable workflow calls
        if (job.uses) {
          logger.warn(
            `Skipping reusable workflow call: ${job.uses} (not yet implemented)`
          );
          continue;
        }

        const jobCtx = createContext(
          { ...(parsed.file.env || {}), ...(job.env || {}) },
          options.inputs,
          options.secrets
        );

        if (!evaluateCondition(job.if, jobCtx)) {
          logger.info(`Skipping job: ${jobId} (condition not met)`);
          continue;
        }

        logger.step(`Executing job: ${jobId}`);
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

          const stepResult = await executeStep(step, options);
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
          job: jobId,
          success: jobSuccess,
          steps: stepResults,
          duration: Date.now() - jobStartTime
        });
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
  options: RunOptions
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
      // Replace basic environment variables
      let command = step.run;

      // Replace inputs if provided
      if (options.inputs) {
        for (const [key, value] of Object.entries(options.inputs)) {
          command = command.replace(
            new RegExp(`\\$\\{\\{\\s*inputs\\.${key}\\s*\\}\\}`, 'g'),
            value
          );
        }
      }

      // Replace secrets if provided
      if (options.secrets) {
        for (const [key, value] of Object.entries(options.secrets)) {
          command = command.replace(
            new RegExp(`\\$\\{\\{\\s*secrets\\.${key}\\s*\\}\\}`, 'g'),
            value
          );
        }
      }

      logger.debug(`Executing: ${command}`);

      const containerPreference = options.containerRuntime ?? 'none';
      if (containerPreference !== 'none') {
        const runtime = await resolveContainerRuntime(containerPreference);
        if (runtime) {
          return await executeInContainer(
            runtime,
            step,
            options,
            command,
            startTime
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
            ...step.env,
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
  startTime: number
): Promise<StepResult> {
  const exchangeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'actly-exchange-')
  );
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
        ...step.env,
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

        const stepResult = await executeStep(compositeStep, stepOptions);

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
      // Docker actions not yet supported
      logger.warn(`Docker actions not yet supported: ${step.uses}`);
      return {
        step,
        success: true,
        output: 'Skipped - Docker actions not yet supported',
        duration: Date.now() - startTime
      };
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
