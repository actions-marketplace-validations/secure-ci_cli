import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from '../parser/workflow-parser';
import { logger } from '../utils/logger';
import { RunOptions, StepResult, Step, ActionFile } from '../types';
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
  ifEvaluationError,
  resolveExpressionValue,
  substituteExpressions,
  substituteRecord,
  ExpressionContext
} from './expression';
import { CONTAINER_WORKDIR } from './container-runtime';
import {
  JobRuntime,
  ParentAction,
  actionDirInContainer,
  stepActionEnv,
  stepDisplayName
} from './job-runtime';
import { isLocalCheckout, localCheckout } from './checkout';
import { executeStep } from './steps';
import { executeDockerAction } from './docker-action';
import { executeNodeAction, runPreIf } from './node-action';
import { actionExpressionErrors } from '../parser/validator';

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
    if (!/^node\d+$/.test(action.runs.using) || !action.runs.pre) continue;
    let runPre: boolean;
    try {
      runPre = runPreIf(action, step, stepCtx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(message);
      stepResults.push({
        step: { name: `Pre ${step.name || step.uses}` },
        success: false,
        error: message,
        duration: 0
      });
      jobCtx.jobFailed = true;
      continue;
    }
    if (!runPre) continue;

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
      const invalid = actionExpressionErrors(action);
      if (invalid.length > 0) {
        const error = `Invalid action file for ${step.uses}: ${invalid
          .map((e) => `${e.path}: ${e.message}`)
          .join('; ')}`;
        logger.error(error);
        return {
          step,
          success: false,
          error,
          duration: Date.now() - startTime
        };
      }

      // Execute composite action steps
      logger.info(`Executing composite action: ${action.name}`);

      const compositeSteps = action.runs.steps || [];
      const outputs: Record<string, string> = {};
      // Composite steps see only the action's own inputs, plus the
      // caller's env and github context - never the workflow's inputs.
      // The action's files, as its steps see them (copied into the job
      // container in container mode).
      const actionDir = runtime.container
        ? actionDirInContainer(runtime.container, path.dirname(actionPath))
        : path.dirname(actionPath);
      const callerActionEnv = runtime.actionEnv;
      const parent: ParentAction = {
        repository: callerActionEnv.GITHUB_ACTION_REPOSITORY ?? '',
        ref: callerActionEnv.GITHUB_ACTION_REF ?? '',
        path: actionDir
      };
      const actionCtx: ExpressionContext = {
        ...createContext(
          { ...callerCtx.env },
          actionInputs,
          {},
          { ...callerCtx.github, action_path: actionDir }
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
          runtime.actionEnv = stepActionEnv(runtime, compositeStep, parent);
          const envCtx: ExpressionContext = {
            ...actionCtx,
            github: {
              ...actionCtx.github,
              action: runtime.actionEnv.GITHUB_ACTION
            },
            env: { ...actionCtx.env, ...runtime.env }
          };
          const stepCtx: ExpressionContext = {
            ...envCtx,
            env: {
              ...envCtx.env,
              ...substituteRecord(compositeStep.env, envCtx)
            }
          };

          let runCompositeStep: boolean;
          try {
            runCompositeStep = evaluateCondition(compositeStep.if, stepCtx);
          } catch (error) {
            const message = ifEvaluationError(
              `step '${stepDisplayName(compositeStep, stepCtx)}' of ${step.uses}`,
              error
            );
            logger.error(message);
            return {
              step,
              success: false,
              error: message,
              duration: Date.now() - startTime
            };
          }
          if (!runCompositeStep) {
            logger.info(
              `Skipping composite step: ${stepDisplayName(compositeStep, stepCtx)} (condition not met)`
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
              error: `Composite action step failed: ${stepDisplayName(compositeStep, stepCtx)}`,
              duration: Date.now() - startTime
            };
          }
        }
      } finally {
        runtime.defaults = callerDefaults;
        runtime.actionEnv = callerActionEnv;
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
