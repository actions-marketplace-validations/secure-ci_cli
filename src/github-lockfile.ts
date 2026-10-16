import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import type { LockEntry, Lockfile } from './inventory';

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

/** A positive integer id, or undefined. */
function id(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function entry(
  commit: string,
  ownerId?: number,
  repoId?: number,
  via?: string[]
): LockEntry {
  return {
    commit,
    ...(ownerId !== undefined ? { ownerId } : {}),
    ...(repoId !== undefined ? { repoId } : {}),
    ...(via && via.length > 0 ? { via } : {})
  };
}

/**
 * Read GitHub's `actions.lock`: each dependency's commit and repository
 * identity (`owner_id`, `repo_id`). It includes transitive dependencies.
 */
export function parseGitHubLockfile(text: string): Lockfile {
  const doc = YAML.parse(text) as {
    version?: unknown;
    dependencies?: Record<
      string,
      { commit?: unknown; owner_id?: unknown; repo_id?: unknown }
    > | null;
  } | null;
  const version = String(doc?.version ?? '');
  if (!SUPPORTED_GITHUB_VERSIONS.includes(version)) {
    throw new Error(
      `Unsupported actions.lock version "${version}" (this release reads ${SUPPORTED_GITHUB_VERSIONS.join(', ')}). Update @secureci/cli, or use ${SECURECI_LOCKFILE}.`
    );
  }
  const actions: Record<string, LockEntry> = {};
  for (const [uses, dep] of Object.entries(doc?.dependencies ?? {})) {
    const match = SHA1_COMMIT.exec(String(dep?.commit ?? ''));
    if (!match) {
      throw new Error(
        `actions.lock entry ${uses} has no sha1 commit (got "${String(dep?.commit)}").`
      );
    }
    actions[uses] = entry(match[1], id(dep?.owner_id), id(dep?.repo_id));
  }
  return { version: 2, actions };
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Read `secureci.lock`. Version 1 maps each reference to a commit; version
 * 2 maps it to `{ commit, owner_id?, repo_id?, via? }`.
 */
export function parseSecureciLockfile(text: string): Lockfile {
  const doc = JSON.parse(text) as { version?: unknown; actions?: unknown };
  const raw = (doc?.actions ?? {}) as Record<string, unknown>;
  const actions: Record<string, LockEntry> = {};
  const bad = (uses: string): Error =>
    new Error(`${SECURECI_LOCKFILE} entry ${uses} has no valid commit.`);

  if (doc?.version === 1) {
    for (const [uses, commit] of Object.entries(raw)) {
      if (typeof commit !== 'string' || !FULL_SHA.test(commit)) throw bad(uses);
      actions[uses] = { commit };
    }
    return { version: 1, actions };
  }
  if (doc?.version === 2) {
    for (const [uses, value] of Object.entries(raw)) {
      const e = (value ?? {}) as Record<string, unknown>;
      if (typeof e.commit !== 'string' || !FULL_SHA.test(e.commit)) {
        throw bad(uses);
      }
      const via = Array.isArray(e.via)
        ? e.via.filter((v): v is string => typeof v === 'string')
        : undefined;
      actions[uses] = entry(e.commit, id(e.owner_id), id(e.repo_id), via);
    }
    return { version: 2, actions };
  }
  throw new Error(
    `Unsupported ${SECURECI_LOCKFILE} version "${String(doc?.version)}". Update @secureci/cli.`
  );
}

/** `secureci.lock` (version 2) for these entries, keys sorted. */
export function serializeSecureciLockfile(
  actions: Record<string, LockEntry>
): string {
  const out: Record<string, Record<string, unknown>> = {};
  for (const uses of Object.keys(actions).sort()) {
    const e = actions[uses];
    out[uses] = {
      commit: e.commit,
      ...(e.ownerId !== undefined ? { owner_id: e.ownerId } : {}),
      ...(e.repoId !== undefined ? { repo_id: e.repoId } : {}),
      ...(e.via && e.via.length > 0 ? { via: e.via } : {})
    };
  }
  return JSON.stringify({ version: 2, actions: out }, null, 2) + '\n';
}

/** Read whichever lockfile `findLockfile` found. */
export function readLockfile(source: LockSource): Lockfile {
  const text = fs.readFileSync(source.file, 'utf-8');
  return source.kind === 'github'
    ? parseGitHubLockfile(text)
    : parseSecureciLockfile(text);
}
