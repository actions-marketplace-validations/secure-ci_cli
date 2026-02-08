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
import { fetchAction } from './action-fetcher';

const execAsync = promisify(exec);

/**
 * Execute a workflow or action file
 */
export async function executeWorkflow(
  filePath: string,
  options: RunOptions = {}
): Promise<WorkflowResult> {
  const startTime = Date.now();

  try {
    const parsed = parseFile(filePath);

    if (parsed.type === 'workflow') {
      logger.info(`Executing workflow: ${parsed.file.name}`);

      const jobs: JobResult[] = [];

      for (const [jobId, job] of Object.entries(parsed.file.jobs)) {
        // Skip if specific job requested and this isn't it
        if (options.job && jobId !== options.job) {
          continue;
        }

        // Handle reusable workflow calls
        if (job.uses) {
          logger.warn(
            `Skipping reusable workflow call: ${job.uses} (not yet implemented)`
          );
          continue;
        }

        logger.step(`Executing job: ${jobId}`);
        const jobStartTime = Date.now();
        const stepResults: StepResult[] = [];

        // Execute each step
        for (const step of job.steps || []) {
          const stepResult = await executeStep(step, options);
          stepResults.push(stepResult);

          if (!stepResult.success && !step['continue-on-error']) {
            logger.error(`Step failed: ${step.name || 'unnamed'}`);
            jobs.push({
              job: jobId,
              success: false,
              steps: stepResults,
              duration: Date.now() - jobStartTime
            });

            return {
              success: false,
              jobs,
              duration: Date.now() - startTime
            };
          }
        }

        jobs.push({
          job: jobId,
          success: true,
          steps: stepResults,
          duration: Date.now() - jobStartTime
        });

        logger.success(`Job ${jobId} completed successfully`);
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

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: step['working-directory'] || process.cwd(),
          shell: step.shell || 'bash'
        });

        if (stdout) {
          logger.info(stdout.trim());
        }
        if (stderr) {
          logger.warn(stderr.trim());
        }

        logger.success(`Step completed: ${step.name || 'unnamed'}`);

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
        logger.error(`Step failed: ${error.message}`);

        if (error.stdout) {
          logger.info(error.stdout.trim());
        }
        if (error.stderr) {
          logger.error(error.stderr.trim());
        }

        return {
          step,
          success: false,
          error: error.message,
          output: error.stdout,
          duration: Date.now() - startTime
        };
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

        const stepOptions: RunOptions = {
          ...options,
          inputs: mergedInputs
        };

        const stepResult = await executeStep(compositeStep, stepOptions);

        if (!stepResult.success) {
          return {
            step,
            success: false,
            error: `Composite action step failed: ${compositeStep.name || 'unnamed'}`,
            duration: Date.now() - startTime
          };
        }

        // Collect outputs
        if (stepResult.output) {
          // Use step ID, name, or index as the output key
          const outputKey =
            compositeStep.id ||
            compositeStep.name ||
            `step-${compositeSteps.indexOf(compositeStep)}`;
          outputs[outputKey] = stepResult.output;
        }
      }

      return {
        step,
        success: true,
        output: JSON.stringify(outputs),
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
