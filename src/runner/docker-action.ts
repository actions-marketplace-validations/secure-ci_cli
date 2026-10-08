import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { RunOptions, StepResult, Step, ActionFile } from '../types';
import { createContext, substituteExpressions } from './expression';
import {
  resolveContainerRuntime,
  CONTAINER_EXCHANGE_DIR
} from './container-runtime';
import { createStepFiles } from './runner-env';
import {
  JobRuntime,
  fileCommandEnv,
  containerRunnerEnv,
  finishStepOutput
} from './job-runtime';
import { inputEnvName } from './node-action';

/**
 * Execute a Docker-type action (`runs.using: docker`). Unlike `run:` steps,
 * container isolation is mandatory here (the image *is* the action) - there
 * is no safe host-execution fallback, so this fails the step (rather than
 * skip-as-success) if no container runtime is available.
 */
export async function executeDockerAction(
  action: ActionFile,
  actionPath: string,
  step: Step,
  actionInputs: Record<string, string>,
  callerEnv: Record<string, string>,
  options: RunOptions,
  runtime: JobRuntime,
  startTime: number
): Promise<StepResult> {
  // The image is the action, so even with steps on the host (`host`) it
  // runs in a container, using whichever engine is available.
  const preference = options.containerRuntime ?? 'auto';
  const containerRuntime = await resolveContainerRuntime(
    preference === 'host' ? 'auto' : preference
  );
  if (!containerRuntime) {
    logger.error(
      `Docker action "${step.uses}" needs a container runtime (docker, podman or containerd), but none is available.`
    );
    return {
      step,
      success: false,
      error:
        'No container runtime (docker, podman or containerd) available for the Docker action',
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
