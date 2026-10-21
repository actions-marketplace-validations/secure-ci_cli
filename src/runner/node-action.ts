import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { logger } from '../utils/logger';
import { RunOptions, StepResult, Step, ActionFile } from '../types';
import {
  evaluateCondition,
  ifEvaluationError,
  ExpressionContext
} from './expression';
import { CONTAINER_WORKDIR } from './container-runtime';
import {
  cleanupStepFiles,
  createStepFiles,
  hostBaseEnv,
  prependPath,
  StepFiles
} from './runner-env';
import {
  JobRuntime,
  actionDirInContainer,
  effectiveTimeout,
  createContainerStepFiles,
  killStepProcesses,
  fileCommandEnv,
  containerRunnerEnv,
  finishStepOutput
} from './job-runtime';
import { DEFAULT_CONTAINER_IMAGE } from './job-container';
import { hostNodeBinary, isSea } from './node-binary';

const execFileAsync = promisify(execFile);

/**
 * Execute a JavaScript action (`runs.using: node*`): `pre` (if any) and
 * `main` now, with `post` queued on the job runtime to run at job end.
 * Scripts run with the CLI's own Node binary (in the standalone binary:
 * `node` from the step's PATH; in a job container: the image's `node`),
 * in the workspace, with the
 * runner's default env, the caller's env, `INPUT_*`, `STATE_*` and the
 * file-command variables. Note: GitHub runs every `pre` at job start;
 * here it runs immediately before its own `main`.
 */
export async function executeNodeAction(
  action: ActionFile,
  actionPath: string,
  step: Step,
  actionInputs: Record<string, string>,
  callerCtx: ExpressionContext,
  options: RunOptions,
  runtime: JobRuntime,
  startTime: number,
  phase: 'pre' | 'main' = 'main'
): Promise<StepResult> {
  if (phase === 'main') {
    logger.info(
      `Executing JavaScript action: ${action.name} (${action.runs.using})`
    );
  }

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
      const error = `JavaScript action "${step.uses}" needs \`node\` in the job container image (${container.image}). Use an image that includes Node.js (e.g. --container-image node:20, a runner-images mapping, or ${DEFAULT_CONTAINER_IMAGE}), or run on the host with --container-runtime host.`;
      logger.error(error);
      return { step, success: false, error, duration: Date.now() - startTime };
    }

    containerActionDir = actionDirInContainer(container, actionDir);
  }

  let state: Record<string, string> = {};
  let output = '';

  const limit = effectiveTimeout(runtime, options.containerTimeoutMs);

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
          ...runtime.actionEnv,
          ...callerCtx.env,
          ...inputEnv,
          ...stateEnv,
          GITHUB_ACTION_PATH: containerActionDir,
          PATH: [...runtime.path, container.node.basePath]
            .filter(Boolean)
            .join(':'),
          ...fileCommandEnv(files, containerDir),
          SECURECI_STEP: path.basename(files.dir)
        },
        timeoutMs: limit.ms
      });
      if (result.timedOut) {
        await killStepProcesses(container, path.basename(files.dir));
      }
      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.success
          ? undefined
          : result.timedOut
            ? limit.message
            : `node exited with code ${result.exitCode}`
      };
    }

    const hostPath = prependPath(
      runtime.path,
      callerCtx.env.PATH ?? process.env.PATH
    );
    const node = hostNodeBinary({ sea: isSea(), pathEnv: hostPath });
    if ('error' in node) {
      return { success: false, stdout: '', stderr: '', error: node.error };
    }

    try {
      const { stdout, stderr } = await execFileAsync(
        node.path,
        [path.join(actionDir, script)],
        {
          cwd: process.cwd(),
          maxBuffer: 64 * 1024 * 1024,
          timeout: limit.ms,
          killSignal: 'SIGKILL',
          env: {
            ...hostBaseEnv(),
            ...runtime.runnerEnv,
            ...runtime.actionEnv,
            ...callerCtx.env,
            ...inputEnv,
            ...stateEnv,
            GITHUB_ACTION_PATH: actionDir,
            PATH: hostPath,
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
        killed?: boolean;
      };
      return {
        success: false,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        error: error.killed && limit.ms ? limit.message : error.message
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

  // `pre` already ran at job start (see runPreSteps): continue from its state.
  const preState = runtime.preState.get(step);
  if (phase === 'pre' && pre) {
    const preStep: Step = { name: `Pre ${step.name || step.uses}` };
    const preResult = await runScript(pre);
    runtime.preState.set(step, state);
    return {
      step: preStep,
      success: preResult.success,
      error: preResult.error,
      output,
      duration: Date.now() - startTime
    };
  }
  if (preState) {
    state = { ...preState };
  } else if (pre && runPreIf(action, step, callerCtx)) {
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
export function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

/**
 * Whether a JavaScript action's `pre` should run (`pre-if`, default
 * always()). Throws a step error if `pre-if` can't be evaluated.
 */
export function runPreIf(
  action: ActionFile,
  step: Step,
  ctx: ExpressionContext
): boolean {
  try {
    return evaluateCondition(action.runs['pre-if'] ?? 'always()', ctx);
  } catch (error) {
    throw new Error(
      ifEvaluationError(`step 'Pre ${step.name || step.uses}'`, error)
    );
  }
}
