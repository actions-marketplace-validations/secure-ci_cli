import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { logger } from '../utils/logger';
import { StepResult, Step } from '../types';
import { substituteRecord, ExpressionContext } from './expression';
import { JobRuntime } from './job-runtime';
import { removeInContainer } from './job-container';
import { CONTAINER_WORKDIR } from './container-runtime';

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
      // Copy-on-write clones where the file system supports them.
      mode: fs.constants.COPYFILE_FICLONE,
      filter: (file) => !fs.existsSync(path.join(file, CHECKOUT_MARKER))
    });
  }
}

/**
 * A copy of the working copy (uncommitted changes and .git included) for
 * one job, in `parentDir`, for --isolate-workspace. Remove it with
 * removeIsolatedWorkspace.
 */
export function createIsolatedWorkspace(
  workingCopy: string,
  parentDir: string
): string {
  const dir = fs.mkdtempSync(path.join(parentDir, 'workspace-'));
  copyWorkingCopy(workingCopy, dir, dir);
  return dir;
}

/**
 * Remove a job's isolated workspace. Best effort: files a container step
 * created as another user may not be removable, which is only warned about.
 */
export function removeIsolatedWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn(
      `Couldn't remove the job's workspace copy ${dir}: ${error instanceof Error ? error.message : String(error)}`
    );
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
/**
 * Whether `dest` (or the closest part of it that exists) resolves outside
 * `workspace` through a symlink, e.g. one a container step planted.
 */
function escapesViaSymlink(workspace: string, dest: string): boolean {
  const root = fs.realpathSync(workspace);
  let existing = dest;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) {
    if (fs.lstatSync(existing, { throwIfNoEntry: false })) return true; // dangling link
    existing = path.dirname(existing);
  }
  const real = fs.realpathSync(existing);
  return real !== root && !real.startsWith(root + path.sep);
}

/** Run git in `cwd` on the host; undefined when it fails. */
function gitOutput(
  cwd: string,
  args: string[],
  env?: Record<string, string>
): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(env ? { env: { ...process.env, ...env } } : {})
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Environment for a git fetch from `url`: never prompts, and sends
 * `token` (as actions/checkout does) only to an https URL on the server's
 * own host, scoped to that host by the config key. Passed through the
 * environment, so it never shows in the process list.
 */
export function gitAuthEnv(
  url: string,
  token: string,
  serverUrl: string
): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  let target: URL;
  let server: URL;
  try {
    target = new URL(url);
    server = new URL(serverUrl);
  } catch {
    return env;
  }
  if (!token || target.protocol !== 'https:' || target.host !== server.host) {
    return env;
  }
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${target.host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  };
}

/** `fetch-depth`: a non-negative integer, default 1 as on GitHub; 0 is all. */
function fetchDepth(raw: string | undefined): number {
  const n = Number(raw === undefined || raw === '' ? 1 : raw);
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

/**
 * Check out `commit` (fetched from `source` when given, else from the
 * local repository) into an empty `dest`, with `depth` commits of history
 * (0: all). The working copy's `.git` is only read: a full-depth local
 * checkout shares its objects; anything fetched lands in `dest` only.
 * Returns the commit checked out, or undefined.
 */
function cloneInto(
  workspace: string,
  dest: string,
  what:
    | { commit: string }
    | { ref: string; source: string; env: Record<string, string> },
  depth: number
): string | undefined {
  const ok = (args: string[], cwd = dest, env?: Record<string, string>) =>
    gitOutput(cwd, args, env) !== undefined;
  const depthArgs = depth > 0 ? ['--depth', String(depth)] : [];
  if ('commit' in what && depth === 0) {
    return ok(
      ['clone', '--quiet', '--shared', '--no-checkout', '--', workspace, dest],
      workspace
    ) && ok(['checkout', '--quiet', '--detach', what.commit])
      ? what.commit
      : undefined;
  }
  fs.mkdirSync(dest, { recursive: true });
  if (!ok(['init', '--quiet']) || !ok(['remote', 'add', 'origin', workspace])) {
    return undefined;
  }
  const [source, ref, env] =
    'commit' in what
      ? [`file://${workspace}`, what.commit, undefined]
      : [what.source, what.ref, what.env];
  // `source` (the origin URL) and `ref` come from outside: never let either
  // be read as an option (`--upload-pack=<cmd>`), and never allow the
  // `ext::` transport, which runs a command, whatever the user's config says.
  if (
    !ok(
      [
        '-c',
        'protocol.ext.allow=never',
        'fetch',
        '--quiet',
        '--no-tags',
        ...depthArgs,
        '--end-of-options',
        source,
        ref
      ],
      dest,
      env
    )
  ) {
    return undefined;
  }
  const commit = gitOutput(dest, [
    'rev-parse',
    '--verify',
    'FETCH_HEAD^{commit}'
  ]);
  return commit && ok(['checkout', '--quiet', '--detach', commit])
    ? commit
    : undefined;
}

/**
 * The commit `ref` names in the local repository (as given, else as a
 * branch of `origin`), or undefined. A ref that looks like an option is
 * never passed to git.
 */
function resolveLocalRef(workspace: string, ref: string): string | undefined {
  if (ref.startsWith('-')) return undefined;
  for (const candidate of [ref, `refs/remotes/origin/${ref}`]) {
    const sha = gitOutput(workspace, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${candidate}^{commit}`
    ]);
    if (sha) return sha;
  }
  return undefined;
}

/**
 * Submodules of the working copy that aren't initialized (`git submodule
 * status` marks them with "-"), by path.
 */
function uninitializedSubmodules(workspace: string): string[] {
  if (!fs.existsSync(path.join(workspace, '.gitmodules'))) return [];
  const status = gitOutput(workspace, ['submodule', 'status', '--recursive']);
  return (status ?? '')
    .split('\n')
    .filter((line) => line.startsWith('-'))
    .map((line) => line.slice(1).split(' ')[1])
    .filter(Boolean);
}

export function localCheckout(
  step: Step,
  ctx: ExpressionContext,
  runtime: JobRuntime,
  startTime: number,
  options: { fetchRefs?: boolean } = {}
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

  const workspace = runtime.workspace;
  const dest = path.resolve(workspace, withValues.path || '.');
  const relative = path.relative(workspace, dest);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    escapesViaSymlink(workspace, dest)
  ) {
    return fail(
      `actions/checkout: path "${withValues.path}" is outside the workspace`
    );
  }

  // A ref other than the current one: check out that commit, when the local
  // repository has it, into path: (never over the user's working copy).
  // With --fetch-refs, a ref the local repository lacks is fetched from
  // origin into the path: copy (never into the user's repository).
  const ref = withValues.ref;
  let commit: string | undefined;
  let fetchFrom: string | undefined;
  if (
    ref &&
    ![ctx.github.ref, ctx.github.ref_name, ctx.github.sha].includes(ref)
  ) {
    commit = resolveLocalRef(workspace, ref);
    if (relative === '') {
      logger.warn(
        `actions/checkout: not checking out ref "${ref}" over your working copy; add a path: to check it out there, or pass --no-local-checkout to run the real action`
      );
      commit = undefined;
    } else if (!commit && options.fetchRefs && !ref.startsWith('-')) {
      fetchFrom = gitOutput(workspace, ['remote', 'get-url', 'origin']);
      if (!fetchFrom) {
        return fail(
          `actions/checkout: can't fetch ref "${ref}": the local repository has no origin remote`
        );
      }
    } else if (!commit) {
      logger.warn(
        `actions/checkout: ref "${ref}" isn't in the local repository; using the local working copy (pass --fetch-refs to fetch it from origin, or --no-local-checkout to run the real action)`
      );
    }
  }

  const submodules = String(withValues.submodules ?? '').toLowerCase();
  if (submodules === 'true' || submodules === 'recursive') {
    const missing = uninitializedSubmodules(workspace);
    if (missing.length > 0) {
      logger.warn(
        `actions/checkout: submodules aren't initialized in your working copy (${missing.join(', ')}); run \`git submodule update --init --recursive\` first`
      );
    }
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
    const depth = fetchDepth(withValues['fetch-depth']);
    if (fetchFrom) {
      const token = withValues.token || String(ctx.github.token ?? '');
      const fetched = cloneInto(
        workspace,
        dest,
        {
          ref: String(ref),
          source: fetchFrom,
          env: gitAuthEnv(
            fetchFrom,
            token,
            String(ctx.github.server_url ?? 'https://github.com')
          )
        },
        depth
      );
      if (!fetched) {
        fs.rmSync(dest, { recursive: true, force: true });
        return fail(
          `actions/checkout: couldn't fetch ref "${ref}" from origin (${fetchFrom})`
        );
      }
      outputs.ref = String(ref);
      outputs.commit = fetched;
      output = `Fetched ${ref} (${fetched.slice(0, 7)}) to ${relative}`;
    } else if (commit) {
      // A local clone (sharing the repository's objects at full depth):
      // nothing is fetched and the working copy's .git is only read.
      if (!cloneInto(workspace, dest, { commit }, depth)) {
        fs.rmSync(dest, { recursive: true, force: true });
        return fail(
          `actions/checkout: couldn't check out ref "${ref}" to "${withValues.path}"`
        );
      }
      outputs.ref = String(ref);
      outputs.commit = commit;
      output = `Checked out ${ref} (${commit.slice(0, 7)}) to ${relative}`;
    } else {
      copyWorkingCopy(workspace, dest, dest);
      output = `Using local working copy (copied to ${relative})`;
    }
    fs.writeFileSync(path.join(dest, CHECKOUT_MARKER), '');

    const postStep: Step = { name: `Post ${step.name || step.uses}` };
    runtime.postSteps.push({
      step: postStep,
      condition: 'always()',
      run: async () => {
        // Files a container step created as root may not be removable by
        // the host user: remove the copy from inside the container first.
        await removeInContainer(
          runtime,
          path.posix.join(CONTAINER_WORKDIR, ...relative.split(path.sep))
        );
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
