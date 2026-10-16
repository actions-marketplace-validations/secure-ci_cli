import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import type { Lockfile } from './inventory';

/** SecureCI's own lockfile, at the repository root. */
export const SECURECI_LOCKFILE = 'secureci.lock';

/**
 * GitHub's workflow dependency lockfile, written by `gh actions-lock`
 * (public preview). See
 * https://docs.github.com/actions/concepts/security/workflow-dependency-lockfiles
 */
export const GITHUB_LOCKFILE = path.join(
  '.github',
  'workflows',
  'actions.lock'
);

/**
 * Versions of GitHub's format this release reads. The format is pre-1.0 and
 * may change, so an unknown version is an error rather than a guess.
 */
const SUPPORTED_GITHUB_VERSIONS = ['v0.0.2', 'v0.0.3'];

const SHA1_COMMIT = /^sha1-([0-9a-f]{40})$/;

export interface LockSource {
  kind: 'secureci' | 'github';
  file: string;
}

/**
 * The lockfile to check against: `secureci.lock` when present (it stays
 * first-class), otherwise GitHub's `actions.lock`, otherwise none.
 */
export function findLockfile(repoRoot: string): LockSource | undefined {
  const secureci = path.join(repoRoot, SECURECI_LOCKFILE);
  if (fs.existsSync(secureci)) return { kind: 'secureci', file: secureci };
  const github = path.join(repoRoot, GITHUB_LOCKFILE);
  if (fs.existsSync(github)) return { kind: 'github', file: github };
  return undefined;
}

/**
 * Read GitHub's `actions.lock` as a `uses -> commit` map, the same shape as
 * `secureci.lock`. It includes transitive dependencies (actions that your
 * actions use), which SecureCI doesn't scan.
 */
export function parseGitHubLockfile(text: string): Lockfile {
  const doc = YAML.parse(text) as {
    version?: unknown;
    dependencies?: Record<string, { commit?: unknown }> | null;
  } | null;
  const version = String(doc?.version ?? '');
  if (!SUPPORTED_GITHUB_VERSIONS.includes(version)) {
    throw new Error(
      `Unsupported actions.lock version "${version}" (this release reads ${SUPPORTED_GITHUB_VERSIONS.join(', ')}). Update @secureci/cli, or use ${SECURECI_LOCKFILE}.`
    );
  }
  const actions: Record<string, string> = {};
  for (const [uses, dep] of Object.entries(doc?.dependencies ?? {})) {
    const match = SHA1_COMMIT.exec(String(dep?.commit ?? ''));
    if (!match) {
      throw new Error(
        `actions.lock entry ${uses} has no sha1 commit (got "${String(dep?.commit)}").`
      );
    }
    actions[uses] = match[1];
  }
  return { version: 1, actions };
}
