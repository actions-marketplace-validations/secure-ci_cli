import * as fs from 'fs';
import * as path from 'path';
import { parseFile } from './parser/workflow-parser';
import { repositoryRoot } from './utils/repository';
import type { ParsedWorkflow, Step, WorkflowFile } from './types';

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
 */
export function collectReferences(parsed: ParsedWorkflow): Reference[] {
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
    if (!isLocal(step.uses)) return;
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

  addWorkflow(parsed.file, '', [path.resolve(parsed.path)]);
  return refs;
}

/** A remote action in the inventory, with its resolved commit. */
export interface InventoryAction {
  uses: string;
  owner: string;
  repo: string;
  subpath?: string;
  ref?: string;
  pinned: boolean;
  resolvedSha?: string;
  paths: string[];
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
    if (!ref.owner || !ref.repo) continue;
    let action = byUses.get(ref.uses);
    if (!action) {
      action = {
        uses: ref.uses,
        owner: ref.owner,
        repo: ref.repo,
        subpath: ref.subpath,
        ref: ref.ref,
        pinned: ref.pinned,
        resolvedSha:
          ref.ref && FULL_SHA.test(ref.ref) ? ref.ref.toLowerCase() : undefined,
        paths: []
      };
      byUses.set(ref.uses, action);
    }
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

/** `secureci.lock`: a map of `owner/repo@ref` to the commit it resolved to. */
export interface Lockfile {
  version: 1;
  actions: Record<string, string>;
}

export interface LockDiff {
  changed: boolean;
  /** Refs whose resolved commit moved since the lock was written. */
  drifted: Array<{ uses: string; from: string; to: string }>;
  /** Refs present now but not in the lock. */
  added: string[];
  /** Refs in the lock but no longer referenced. */
  removed: string[];
}

/** Compare current `uses -> sha` against a lockfile's recorded commits. */
export function diffLock(
  current: Record<string, string>,
  lock: Lockfile
): LockDiff {
  const drifted: LockDiff['drifted'] = [];
  const added: string[] = [];
  for (const [uses, sha] of Object.entries(current)) {
    const known = lock.actions[uses];
    if (known === undefined) added.push(uses);
    else if (known !== sha) drifted.push({ uses, from: known, to: sha });
  }
  const removed = Object.keys(lock.actions).filter(
    (uses) => !(uses in current)
  );
  return {
    changed: drifted.length > 0 || added.length > 0 || removed.length > 0,
    drifted,
    added: added.sort(),
    removed: removed.sort()
  };
}

/** The `uses -> resolvedSha` map an inventory contributes to a lockfile. */
export function lockEntries(inv: Inventory): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const action of inv.actions) {
    if (action.resolvedSha) entries[action.uses] = action.resolvedSha;
  }
  return entries;
}
