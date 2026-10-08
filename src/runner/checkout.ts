import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { StepResult, Step } from '../types';
import { substituteRecord, ExpressionContext } from './expression';
import { JobRuntime } from './job-runtime';

/** Marks a `path:` copy made by localCheckout, so it may be replaced. */
const CHECKOUT_MARKER = '.secureci-checkout';

/**
 * Copy `srcDir` into `dstDir`, skipping `exclude` (the copy's own location,
 * which may lie inside `srcDir`) and earlier local checkout copies.
 */
export function copyWorkingCopy(
  srcDir: string,
  dstDir: string,
  exclude: string
): void {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (src === exclude) continue;
    if (entry.isDirectory()) {
      if (fs.existsSync(path.join(src, CHECKOUT_MARKER))) continue;
      if (exclude.startsWith(src + path.sep)) {
        copyWorkingCopy(src, dst, exclude);
        continue;
      }
    }
    fs.cpSync(src, dst, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => !fs.existsSync(path.join(file, CHECKOUT_MARKER))
    });
  }
}

/**
 * Whether a step is `actions/checkout` of the repository being run (no
 * `repository:` input, or the current one in any case), which is served
 * from the local working copy rather than cloned.
 */
export function isLocalCheckout(
  uses: string,
  withValues: Step['with'],
  ctx: ExpressionContext
): boolean {
  if (!/^actions\/checkout@/i.test(uses)) return false;
  const repository = substituteRecord(withValues, ctx).repository ?? '';
  return (
    repository === '' ||
    repository.toLowerCase() === String(ctx.github.repository).toLowerCase()
  );
}

/**
 * `actions/checkout` of the current repository: the workspace already is
 * the user's working copy (uncommitted changes included), so nothing is
 * cloned and `.git` is never touched. With `path:`, the working copy is
 * copied into that subdirectory and the copy is removed at job end.
 */
export function localCheckout(
  step: Step,
  ctx: ExpressionContext,
  runtime: JobRuntime,
  startTime: number
): StepResult {
  const withValues = substituteRecord(step.with, ctx);
  const outputs = {
    ref: String(ctx.github.ref ?? ''),
    commit: String(ctx.github.sha ?? '')
  };
  const fail = (error: string): StepResult => {
    logger.error(error);
    return { step, success: false, error, duration: Date.now() - startTime };
  };

  const ref = withValues.ref;
  if (
    ref &&
    ![ctx.github.ref, ctx.github.ref_name, ctx.github.sha].includes(ref)
  ) {
    logger.warn(
      `actions/checkout: ignoring ref "${ref}"; using the local working copy (pass --no-local-checkout to run the real action)`
    );
  }

  const workspace = process.cwd();
  const dest = path.resolve(workspace, withValues.path || '.');
  const relative = path.relative(workspace, dest);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return fail(
      `actions/checkout: path "${withValues.path}" is outside the workspace`
    );
  }

  let output = 'Using local working copy';
  if (relative !== '') {
    if (fs.existsSync(dest)) {
      if (fs.existsSync(path.join(dest, CHECKOUT_MARKER))) {
        fs.rmSync(dest, { recursive: true, force: true });
      } else if (fs.readdirSync(dest).length > 0) {
        return fail(
          `actions/checkout: path "${withValues.path}" already exists in the working copy; remove it or pass --no-local-checkout`
        );
      }
    }
    copyWorkingCopy(workspace, dest, dest);
    fs.writeFileSync(path.join(dest, CHECKOUT_MARKER), '');
    output = `Using local working copy (copied to ${relative})`;

    const postStep: Step = { name: `Post ${step.name || step.uses}` };
    runtime.postSteps.push({
      step: postStep,
      condition: 'always()',
      run: async () => {
        fs.rmSync(dest, { recursive: true, force: true });
        return { step: postStep, success: true, duration: 0 };
      }
    });
  }

  logger.info(output);
  return {
    step,
    success: true,
    output,
    outputs,
    duration: Date.now() - startTime
  };
}
