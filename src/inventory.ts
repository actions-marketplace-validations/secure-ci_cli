import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from './parser/workflow-parser';
import { repositoryRoot } from './utils/repository';
import type { ParsedFile, ParsedWorkflow, Step, WorkflowFile } from './types';

/** A resolved `uses:` reference and where it appears. */
export interface Reference {
  /** The raw `uses:` string. */
  uses: string;
  kind: 'action' | 'reusable-workflow' | 'local' | 'docker';
  owner?: string;
  repo?: string;
  /** Path within the repo for `owner/repo/path`. */
  subpath?: string;
  ref?: string;
  /** True when `ref` is a full 40-char commit SHA. */
  pinned: boolean;
  /** Call path, e.g. `jobs.build.steps[2] > ./x > steps[0]`. */
  path: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const MAX_DEPTH = 10;

function classify(uses: string, kind: Reference['kind']): Reference {
  const base: Reference = { uses, kind, pinned: false, path: '' };
  if (uses.startsWith('docker://')) {
    return { ...base, kind: 'docker' };
  }
  if (uses.startsWith('./') || uses.startsWith('../')) {
    return { ...base, kind: 'local' };
  }
  const at = uses.lastIndexOf('@');
  const ref = at === -1 ? undefined : uses.slice(at + 1);
  const name = at === -1 ? uses : uses.slice(0, at);
  const parts = name.split('/');
  return {
    ...base,
    kind,
    owner: parts[0],
    repo: parts[1],
    subpath: parts.length > 2 ? parts.slice(2).join('/') : undefined,
    ref,
    pinned: !!ref && FULL_SHA.test(ref)
  };
}

/**
 * Every `uses:` reference in a workflow, recursing into local composite
 * actions (`./path`) and local reusable workflows (`jobs.<id>.uses: ./x.yml`)
 * so wrapped references are still listed. Remote references are listed but
 * not followed. Order is the walk order; each carries its call path.
 *
 * Also takes a composite action (its steps). `localActions: false` lists
 * but doesn't follow `./` actions: in a downloaded action or workflow they
 * resolve against whatever the caller checked out, which isn't known here.
 */
export function collectReferences(
  parsed: ParsedFile,
  options: { localActions?: boolean } = {}
): Reference[] {
  const followLocalActions = options.localActions ?? true;
  const root = repositoryRoot(parsed.path);
  const refs: Reference[] = [];

  const resolveLocal = (uses: string, names: string[]): string | null => {
    const target = path.resolve(root, uses);
    for (const candidate of [
      target,
      ...names.map((n) => path.join(target, n))
    ]) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  };
  const isLocal = (u: string) => u.startsWith('./') || u.startsWith('../');

  const addStep = (step: Step, at: string, stack: string[]): void => {
    if (!step.uses) return;
    const ref = classify(step.uses, 'action');
    refs.push({ ...ref, path: at });
    if (!isLocal(step.uses) || !followLocalActions) return;
    const file = resolveLocal(step.uses, ['action.yml', 'action.yaml']);
    if (!file || stack.includes(file) || stack.length >= MAX_DEPTH) return;
    let parsedAction;
    try {
      parsedAction = parseFile(file);
    } catch {
      return;
    }
    if (
      parsedAction.type === 'action' &&
      parsedAction.file.runs.using === 'composite'
    ) {
      (parsedAction.file.runs.steps ?? []).forEach((s, i) =>
        addStep(s, `${at} > ${step.uses} > steps[${i}]`, [...stack, file])
      );
    }
  };

  const addWorkflow = (
    workflow: WorkflowFile,
    at: string,
    stack: string[]
  ): void => {
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      const jobPath = `${at}jobs.${jobId}`;
      if (job.uses) {
        const ref = classify(job.uses, 'reusable-workflow');
        refs.push({ ...ref, path: jobPath });
        if (!isLocal(job.uses)) continue;
        const file = resolveLocal(job.uses, []);
        if (!file || stack.includes(file) || stack.length >= MAX_DEPTH)
          continue;
        try {
          const called = parseFile(file);
          if (called.type === 'workflow') {
            addWorkflow(called.file, `${jobPath} > ${job.uses} > `, [
              ...stack,
              file
            ]);
          }
        } catch {
          // Unparseable reusable workflow: skip.
        }
        continue;
      }
      (job.steps ?? []).forEach((step, i) =>
        addStep(step, `${jobPath}.steps[${i}]`, stack)
      );
    }
  };

  if (parsed.type === 'workflow') {
    addWorkflow(parsed.file, '', [path.resolve(parsed.path)]);
  } else if (parsed.file.runs.using === 'composite') {
    (parsed.file.runs.steps ?? []).forEach((s, i) =>
      addStep(s, `steps[${i}]`, [path.resolve(parsed.path)])
    );
  }
  return refs;
}

/** A remote action in the inventory, with its resolved commit. */
export interface InventoryAction {
  uses: string;
  kind: 'action' | 'reusable-workflow';
  owner: string;
  repo: string;
  subpath?: string;
  ref?: string;
  pinned: boolean;
  resolvedSha?: string;
  paths: string[];
  /** Set for a transitive dependency: the references that pull it in. */
  via?: string[];
  /** GitHub's ids for the repository, when looked up. */
  ownerId?: number;
  repoId?: number;
}

export interface Inventory {
  workflow: string;
  /** Distinct remote actions, with resolved commits. */
  actions: InventoryAction[];
  /** All references (remote, local, docker, reusable), as collected. */
  references: Reference[];
}

/** Resolve a `uses:` ref to a commit SHA, or undefined when it can't. */
export type ShaResolver = (uses: string) => Promise<string | undefined>;

/**
 * The inventory of a workflow: every reference, plus the distinct remote
 * actions resolved to commit SHAs (an already-pinned ref resolves to
 * itself; otherwise `resolveSha` is consulted).
 */
export async function buildInventory(
  parsed: ParsedWorkflow,
  resolveSha?: ShaResolver
): Promise<Inventory> {
  const references = collectReferences(parsed);
  const remote = references.filter(
    (r) => r.kind === 'action' || r.kind === 'reusable-workflow'
  );

  const byUses = new Map<string, InventoryAction>();
  for (const ref of remote) {
    const action = byUses.get(ref.uses) ?? toAction(ref);
    if (!action) continue;
    byUses.set(ref.uses, action);
    action.paths.push(ref.path);
  }

  if (resolveSha) {
    for (const action of byUses.values()) {
      if (!action.resolvedSha) {
        action.resolvedSha = await resolveSha(action.uses);
      }
    }
  }

  return {
    workflow: parsed.path,
    actions: [...byUses.values()],
    references
  };
}

/** A remote reference as an inventory entry (no paths yet), or null. */
function toAction(ref: Reference): InventoryAction | null {
  if (!ref.owner || !ref.repo) return null;
  if (ref.kind !== 'action' && ref.kind !== 'reusable-workflow') return null;
  return {
    uses: ref.uses,
    kind: ref.kind,
    owner: ref.owner,
    repo: ref.repo,
    subpath: ref.subpath,
    ref: ref.ref,
    pinned: ref.pinned,
    resolvedSha:
      ref.ref && FULL_SHA.test(ref.ref) ? ref.ref.toLowerCase() : undefined,
    paths: []
  };
}

export interface TransitiveDeps {
  /**
   * Download `owner/repo[/path]@sha` and return the local path of the
   * action's action.yml (kind `action`) or of the workflow file, or null.
   */
  fetch: (
    uses: string,
    kind: InventoryAction['kind']
  ) => Promise<string | null>;
  resolveSha?: ShaResolver;
  warn: (message: string) => void;
  /** Called when a newly found dependency is queued to be read. */
  onQueue?: (action: InventoryAction) => void;
}

/**
 * The inventory plus every transitive dependency: remote composite actions
 * and remote reusable workflows are downloaded at their resolved commit
 * (so what's read is what's locked) and their own `uses:` added, up to
 * MAX_DEPTH levels. A dependency records `via`, the references that pull it
 * in. Node and Docker actions have no `uses:` to follow.
 */
export async function addTransitive(
  direct: InventoryAction[],
  deps: TransitiveDeps
): Promise<InventoryAction[]> {
  const byUses = new Map(direct.map((a) => [a.uses, a]));
  const queue = direct.map((action) => ({ action, depth: 1 }));

  while (queue.length > 0) {
    const { action, depth } = queue.shift() as (typeof queue)[number];
    const at = action.resolvedSha ?? action.ref;
    if (!at || depth > MAX_DEPTH) continue;
    const name = [action.owner, action.repo, action.subpath]
      .filter(Boolean)
      .join('/');
    const file = await deps.fetch(`${name}@${at}`, action.kind);
    let parsed: ParsedFile | undefined;
    try {
      parsed = file ? parseFile(file) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!parsed) {
      deps.warn(
        `Could not read ${action.uses}, so the actions it uses are not listed.`
      );
      continue;
    }

    for (const ref of collectReferences(parsed, { localActions: false })) {
      const refPath = `${action.uses} > ${ref.path}`;
      const known = byUses.get(ref.uses);
      if (known) {
        known.paths.push(refPath);
        if (known.via && !known.via.includes(action.uses)) {
          known.via = [...known.via, action.uses].sort();
        }
        continue;
      }
      const dep = toAction(ref);
      if (!dep) continue;
      dep.paths.push(refPath);
      dep.via = [action.uses];
      if (!dep.resolvedSha && deps.resolveSha) {
        dep.resolvedSha = await deps.resolveSha(dep.uses);
      }
      byUses.set(dep.uses, dep);
      queue.push({ action: dep, depth: depth + 1 });
      deps.onQueue?.(dep);
    }
  }
  return [...byUses.values()];
}

/** One locked reference: its commit and, when known, its repository. */
export interface LockEntry {
  commit: string;
  /** GitHub's numeric id of the repository owner. */
  ownerId?: number;
  /** GitHub's numeric id of the repository; changes if it's re-created. */
  repoId?: number;
  /** For a transitive dependency: the references that pull it in. */
  via?: string[];
}

/** A lockfile, read into one shape whichever file it came from. */
export interface Lockfile {
  version: 1 | 2;
  actions: Record<string, LockEntry>;
}

export interface LockDiff {
  changed: boolean;
  /** Refs whose resolved commit moved since the lock was written. */
  drifted: Array<{ uses: string; from: string; to: string }>;
  /** Refs present now but not in the lock. */
  added: string[];
  /** Refs in the lock but no longer referenced. */
  removed: string[];
  /** Refs whose repository is no longer the one that was locked. */
  identity: Array<{
    uses: string;
    field: 'owner_id' | 'repo_id';
    from: number;
    to: number;
  }>;
}

/**
 * Compare the current entries against a lockfile: moved commits, new and
 * removed refs, and repositories whose identity changed (compared only
 * when both sides know it).
 */
export function diffLock(
  current: Record<string, LockEntry>,
  lock: Lockfile
): LockDiff {
  const drifted: LockDiff['drifted'] = [];
  const identity: LockDiff['identity'] = [];
  const added: string[] = [];
  for (const [uses, entry] of Object.entries(current)) {
    const known = lock.actions[uses];
    if (known === undefined) {
      added.push(uses);
      continue;
    }
    if (known.commit !== entry.commit) {
      drifted.push({ uses, from: known.commit, to: entry.commit });
    }
    for (const [field, key] of [
      ['owner_id', 'ownerId'],
      ['repo_id', 'repoId']
    ] as const) {
      const from = known[key];
      const to = entry[key];
      if (from !== undefined && to !== undefined && from !== to) {
        identity.push({ uses, field, from, to });
      }
    }
  }
  const removed = Object.keys(lock.actions).filter(
    (uses) => !(uses in current)
  );
  return {
    changed:
      drifted.length > 0 ||
      added.length > 0 ||
      removed.length > 0 ||
      identity.length > 0,
    drifted,
    added: added.sort(),
    removed: removed.sort(),
    identity
  };
}
