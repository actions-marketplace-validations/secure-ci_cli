import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseFile } from '../parser/workflow-parser';
import { logger } from '../utils/logger';
import { RunOptions, StepResult, Step, ActionFile } from '../types';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fetchAction } from './action-fetcher';
import { splitArgs } from './shell';
import {
  builtinActionFor,
  containerFileSystem,
  downloadArtifact,
  hostFileSystem,
  runCacheAction,
  StepFileSystem,
  uploadArtifact,
  BuiltinAction
} from './builtin-actions';
import {
  createContext,
  evaluateCondition,
  resolveExpressionValue,
  substituteExpressions,
  substituteRecord,
  ExpressionContext
} from './expression';
import {
  resolveContainerRuntime,
  CONTAINER_EXCHANGE_DIR,
  CONTAINER_WORKDIR
} from './container-runtime';
import {
  cleanupStepFiles,
  createStepFiles,
  hostBaseEnv,
  prependPath,
  StepFiles
} from './runner-env';
import {
  JobRuntime,
  createContainerStepFiles,
  killStepProcesses,
  fileCommandEnv,
  containerRunnerEnv,
  finishStepOutput
} from './job-runtime';
import { DEFAULT_CONTAINER_IMAGE } from './job-container';
import { isLocalCheckout, localCheckout } from './checkout';
import { executeStep } from './steps';

const execFileAsync = promisify(execFile);

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
          ...fileCommandEnv(files, containerDir),
          SECURECI_STEP: path.basename(files.dir)
        },
        timeoutMs: options.containerTimeoutMs
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
            ...hostBaseEnv(),
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
  } else if (
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
export function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

/**
 * Build an action's `inputs.*`: the step's `with:` values (resolved against
 * the calling step's context), falling back to each declared input's
 * `default` (which may itself contain expressions, e.g. `${{ github.token }}`).
 */
export function resolveActionInputs(
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
 * Warn that a job's remote actions are about to run on the host, with the
 * user's privileges (container mode off, or no runtime available). Local
 * actions, `docker://` steps and a local checkout are left out.
 */
export function warnUnsandboxedActions(
  steps: Step[],
  ctx: ExpressionContext,
  options: RunOptions
): void {
  const remote = steps
    .filter(
      (step) =>
        step.uses &&
        !isLocalActionRef(step.uses) &&
        !step.uses.startsWith('docker://') &&
        !builtinActionFor(step.uses) &&
        !(
          options.localCheckout !== false &&
          isLocalCheckout(step.uses, step.with, ctx)
        )
    )
    .map((step) => step.uses as string);
  if (remote.length === 0) return;
  logger.warn(
    `Running remote actions on the host without container isolation: ${[...new Set(remote)].join(', ')}. They run with your user's privileges; use a container runtime (--container-runtime docker|podman|containerd) to sandbox them.`
  );
}

/** The file system a step sees: the host, or the job container. */
export async function stepFileSystem(
  runtime: JobRuntime
): Promise<StepFileSystem> {
  const container = runtime.container;
  if (!container) return hostFileSystem(process.cwd());
  if (container.home === undefined) {
    const probe = await container.runtime.exec(container.id, {
      command: 'printf %s "$HOME"'
    });
    container.home = (probe.success && probe.stdout.trim()) || '/root';
  }
  return containerFileSystem({
    workspace: CONTAINER_WORKDIR,
    hostWorkspace: process.cwd(),
    home: container.home,
    copyFrom: (from, to) => container.runtime.copyFrom(container.id, from, to),
    copyTo: (from, to) => container.runtime.copyTo(container.id, from, to),
    mkdir: async (dir) => {
      await container.runtime.exec(container.id, {
        args: ['mkdir', '-p', dir]
      });
    }
  });
}

/**
 * Run actions/upload-artifact, download-artifact or cache locally (see
 * builtin-actions.ts); actions/cache's save is queued as a post step.
 */
export async function runBuiltinAction(
  kind: BuiltinAction,
  step: Step,
  ctx: ExpressionContext,
  options: RunOptions,
  runtime: JobRuntime,
  startTime: number
): Promise<StepResult> {
  const inputs = substituteRecord(step.with, ctx);
  const runId = String(ctx.github.run_id ?? options.runId ?? 'local');
  const repository = String(ctx.github.repository ?? '');
  const fsys = await stepFileSystem(runtime);
  try {
    const result =
      kind === 'upload-artifact'
        ? await uploadArtifact(fsys, inputs, runId)
        : kind === 'download-artifact'
          ? await downloadArtifact(fsys, inputs, runId)
          : await runCacheAction(kind, fsys, inputs, repository);

    if (result.warning) logger.warn(result.warning);
    if (result.output) logger.info(result.output);
    if (!result.success) logger.error(result.error ?? 'failed');

    const post = result.post;
    if (post) {
      const postStep: Step = { name: `Post ${step.name || step.uses}` };
      runtime.postSteps.push({
        step: postStep,
        condition: 'success()',
        run: async () => {
          const postFs = await stepFileSystem(runtime);
          try {
            const saved = await post(postFs);
            if (saved.warning) logger.warn(saved.warning);
            if (saved.output) logger.info(saved.output);
            return {
              step: postStep,
              success: saved.success,
              output: saved.output,
              error: saved.error,
              duration: 0
            };
          } finally {
            postFs.cleanup();
          }
        }
      });
    }

    return {
      step,
      success: result.success,
      output: result.output,
      outputs: result.outputs,
      error: result.error,
      duration: Date.now() - startTime
    };
  } finally {
    fsys.cleanup();
  }
}

/** fetchAction, once per remote action per job. */
export async function fetchActionOnce(
  uses: string,
  options: RunOptions,
  runtime: JobRuntime
): Promise<string | null> {
  if (!runtime.actionPaths.has(uses)) {
    runtime.actionPaths.set(
      uses,
      await fetchAction(uses, { offline: options.offline })
    );
  }
  return runtime.actionPaths.get(uses) ?? null;
}

/**
 * Run the `pre` scripts of the job's remote JavaScript actions at job
 * start, before any step, as GitHub does (gated by `pre-if`, default
 * `always()`). Their `main` later continues from the state they saved.
 * Local actions usually come from the checkout, so their `pre` still runs
 * right before their `main`. A failed `pre` fails the job.
 */
export async function runPreSteps(
  steps: Step[],
  options: RunOptions,
  runtime: JobRuntime,
  jobCtx: ExpressionContext,
  stepResults: StepResult[]
): Promise<void> {
  for (const step of steps) {
    if (
      !step.uses ||
      isLocalActionRef(step.uses) ||
      step.uses.startsWith('docker://') ||
      builtinActionFor(step.uses)
    ) {
      continue;
    }
    const envCtx: ExpressionContext = {
      ...jobCtx,
      env: { ...jobCtx.env, ...runtime.env }
    };
    const stepCtx: ExpressionContext = {
      ...envCtx,
      env: { ...envCtx.env, ...substituteRecord(step.env, envCtx) }
    };
    if (
      options.localCheckout !== false &&
      isLocalCheckout(step.uses, step.with, stepCtx)
    ) {
      continue;
    }

    // Unresolvable actions are reported when their step runs.
    const actionPath = await fetchActionOnce(step.uses, options, runtime);
    if (!actionPath) continue;
    let action: ActionFile;
    try {
      const parsed = parseFile(actionPath);
      if (parsed.type !== 'action') continue;
      action = parsed.file;
    } catch {
      continue;
    }
    if (
      !/^node\d+$/.test(action.runs.using) ||
      !action.runs.pre ||
      !evaluateCondition(action.runs['pre-if'] ?? 'always()', stepCtx)
    ) {
      continue;
    }

    logger.info(`Running: Pre ${step.name || step.uses}`);
    const result = await executeNodeAction(
      action,
      actionPath,
      step,
      resolveActionInputs(action, step.with, stepCtx),
      stepCtx,
      options,
      runtime,
      Date.now(),
      'pre'
    );
    stepResults.push(result);
    if (!result.success) {
      jobCtx.jobFailed = true;
      logger.error(`Step failed: Pre ${step.name || step.uses}`);
    }
  }
}

export function isLocalActionRef(uses: string): boolean {
  return uses.startsWith('./') || uses.startsWith('../');
}

/**
 * Resolve a local action (`uses: ./path/to/action`) relative to the
 * workspace, like the runner does, to its action.yml / action.yaml.
 */
export function resolveLocalAction(uses: string): string | null {
  const dir = path.resolve(process.cwd(), uses);
  for (const name of ['action.yml', 'action.yaml']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Execute an action step: local (`./`), remote (`owner/repo@ref`) or
 * `docker://image`.
 */
export async function executeAction(
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

    const builtin = builtinActionFor(step.uses);
    if (builtin) {
      return await runBuiltinAction(
        builtin,
        step,
        callerCtx,
        options,
        runtime,
        startTime
      );
    }

    const actionPath = isLocalActionRef(step.uses)
      ? resolveLocalAction(step.uses)
      : await fetchActionOnce(step.uses, options, runtime);

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
          {},
          callerCtx.github
        ),
        secretsUnavailable: true,
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
