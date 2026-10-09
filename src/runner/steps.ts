import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { RunOptions, StepResult, Step } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  createContext,
  substituteExpressions,
  substituteRecord,
  ExpressionContext
} from './expression';
import { CONTAINER_WORKDIR } from './container-runtime';
import {
  cleanupStepFiles,
  createStepFiles,
  hostBaseEnv,
  prependPath
} from './runner-env';
import { resolveShell, shellCommandLine } from './shell';
import {
  JobRuntime,
  JobContainerHandle,
  stepDisplayName,
  createContainerStepFiles,
  killStepProcesses,
  effectiveTimeout,
  containerPathPrefix,
  hostHasBash,
  fileCommandEnv,
  containerRunnerEnv,
  finishStepOutput
} from './job-runtime';
import { executeAction } from './actions';

const execAsync = promisify(exec);

/**
 * Execute a single step
 */
export async function executeStep(
  step: Step,
  options: RunOptions,
  runtime: JobRuntime,
  ctx?: ExpressionContext
): Promise<StepResult> {
  const startTime = Date.now();

  try {
    const displayName = stepDisplayName(step, ctx);
    // Don't echo a bare run: command before the step runs — it may contain
    // a value the step is about to register with ::add-mask::. Named and
    // uses steps have a safe label.
    if (step.name || step.uses) {
      logger.info(`Running: ${displayName}`);
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
          mergedEnv,
          displayName
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

      const limit = effectiveTimeout(runtime);
      try {
        const { stdout, stderr } = await execAsync(
          shellCommandLine(shell.template, scriptPath),
          {
            timeout: limit.ms,
            killSignal: 'SIGKILL',
            cwd: workingDirectory
              ? path.resolve(process.cwd(), workingDirectory)
              : process.cwd(),
            env: {
              ...hostBaseEnv(),
              ...runtime.runnerEnv,
              ...runtime.actionEnv,
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

        logger.success(`Step completed: ${displayName}`);

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
          killed?: boolean;
        };
        if (error.killed && limit.ms) error.message = limit.message;
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
export async function executeInJobContainer(
  container: JobContainerHandle,
  runtime: JobRuntime,
  step: Step,
  options: RunOptions,
  command: string,
  startTime: number,
  mergedEnv: Record<string, string>,
  displayName = stepDisplayName(step)
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

    const limit = effectiveTimeout(runtime, options.containerTimeoutMs);
    const result = await container.runtime.exec(container.id, {
      command:
        containerPathPrefix(runtime) +
        shellCommandLine(shell.template, `${containerDir}/${scriptName}`),
      workingDir,
      env: {
        ...containerRunnerEnv(runtime),
        ...runtime.actionEnv,
        ...mergedEnv,
        ...fileCommandEnv(files, containerDir),
        SECURECI_STEP: path.basename(files.dir)
      },
      timeoutMs: limit.ms
    });
    if (result.timedOut) {
      await killStepProcesses(container, path.basename(files.dir));
    }

    const { outputs } = finishStepOutput(result.stdout, files, runtime);
    if (result.stderr) {
      logger[result.success ? 'warn' : 'error'](result.stderr.trim());
    }

    if (result.timedOut) {
      logger.error(`${limit.message} (container: ${container.runtime.name})`);
      return {
        step,
        success: false,
        error: limit.message,
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
      `Step completed: ${displayName} (container: ${container.runtime.name})`
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
