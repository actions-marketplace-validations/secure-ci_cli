import * as fs from 'fs';
import * as path from 'path';
import {
  PipelineContractEntry,
  PipelineContractSpec,
  ParsedWorkflow,
  Step,
  ValidationError,
  ValidationResult,
  WorkflowFile
} from '../types';
import { topologicalJobOrder } from '../runner/job-plan';
import { parseFile } from './workflow-parser';
import { forbiddenTriggerErrors } from './dangerous-triggers';
import { repositoryRoot } from '../utils/repository';
import { fetchAction, fetchRepoFile } from '../runner/action-fetcher';
import { findLockfile, readLockfile } from '../github-lockfile';
import { contractPermissionErrors } from './permissions';

/**
 * Which composite actions / reusable workflows to look inside: none, local
 * (`./...`, the default, offline) or all (remote ones are downloaded).
 */
export type ContractRecurse = 'none' | 'local' | 'all';

/** Maximum nesting of composite actions / reusable workflows. */
const MAX_DEPTH = 10;

interface UsageEntry {
  /** The job (or reusable-workflow call) the step runs in. */
  node: string;
  /** Position among all steps of that job, nested composite steps included. */
  index: number;
  /** Where the step is declared, e.g. `jobs.build.steps[2] > ./x > steps[0]`. */
  path: string;
  name: string;
  version?: string;
  /** The step, or a job/step enclosing it, has an `if:` and may not run. */
  conditional: boolean;
}

interface JobNode {
  /** Display name, e.g. `build` or `release > ./.github/workflows/r.yml > ship`. */
  label: string;
  /** Jobs that finish before this one starts (direct `needs:`). */
  needs: Set<string>;
  /** Number of step positions in the job. */
  length: number;
}

/**
 * The workflow's `uses:` steps, with local composite actions and local
 * reusable workflows resolved into them, and the `needs:` graph between
 * jobs (a reusable-workflow call contributes its called jobs).
 */
interface PipelineGraph {
  sequence: UsageEntry[];
  nodes: Map<string, JobNode>;
  errors: ValidationError[];
}

/**
 * Validate a workflow's job/step sequence against a central pipeline
 * contract: a minimum set of required actions (optionally ordered) and a
 * deny-list of forbidden actions.
 *
 * Composite actions (`uses: ./path`) and reusable workflows
 * (`jobs.<id>.uses: ./path.yml`) are resolved recursively, so wrapping an
 * action doesn't hide it: local ones by default, remote ones too with
 * `recurse: 'all'`. Ordering follows
 * what GitHub guarantees: steps of a job run in order, and a job runs after
 * the jobs it (transitively) `needs:`; jobs with no such relationship may
 * run in parallel, so neither is "before" the other.
 */
export async function validatePipelineContract(
  parsed: ParsedWorkflow,
  spec: PipelineContractSpec,
  options: { recurse?: ContractRecurse } = {}
): Promise<ValidationResult> {
  const graph = await buildGraph(parsed, options.recurse ?? 'local');
  const { sequence, nodes } = graph;
  const errors: ValidationError[] = [...graph.errors];
  const ordering = spec.ordering ?? 'relative';

  for (const entry of spec.forbidden ?? []) {
    for (const usage of sequence) {
      if (
        usage.name === normalizeActionName(entry.uses) &&
        (entry.version === undefined || usage.version === entry.version)
      ) {
        errors.push({
          path: usage.path,
          message: entry.version
            ? `Forbidden action "${entry.uses}@${entry.version}" is used`
            : `Forbidden action "${entry.uses}" is used (any version)`,
          severity: 'error'
        });
      }
    }
  }

  const matchedPositions: {
    entry: PipelineContractEntry;
    usage: UsageEntry;
    /** Index of the entry in the contract's `required` list. */
    index: number;
  }[] = [];

  (spec.required ?? []).forEach((entry, idx) => {
    const path = `required[${idx}]`;
    const name = normalizeActionName(entry.uses);
    const candidates = sequence.filter((u) => u.name === name);
    if (candidates.length > 0 && candidates.every((c) => c.conditional)) {
      errors.push({
        path,
        message: `Required action "${entry.uses}" only runs under an if: condition (on its step or job), so it may be skipped`,
        severity: 'warning'
      });
    }

    if (candidates.length === 0) {
      errors.push({
        path,
        message: `Required action "${entry.uses}" was not found in the pipeline`,
        severity: 'error'
      });
      return;
    }

    if (!entry['min-version']) {
      matchedPositions.push({ entry, usage: candidates[0], index: idx });
      return;
    }

    const satisfying = candidates.find(
      (c) => c.version && isVersionAtLeast(c.version, entry['min-version']!)
    );
    if (satisfying) {
      matchedPositions.push({ entry, usage: satisfying, index: idx });
      return;
    }

    // Present but too old (or not comparable): still check its ordering,
    // using its first occurrence.
    matchedPositions.push({ entry, usage: candidates[0], index: idx });

    const comparable = candidates.find(
      (c) =>
        c.version &&
        isVersionAtLeast(c.version, entry['min-version']!) === false
    );
    if (comparable) {
      errors.push({
        path,
        message: `Required action "${entry.uses}" is used at version "${comparable.version}", which is below the required minimum "${entry['min-version']}"`,
        severity: 'error'
      });
    } else {
      errors.push({
        path,
        message: `Required action "${entry.uses}" was found, but its version could not be compared against the required minimum "${entry['min-version']}"`,
        severity: 'warning'
      });
    }
  });

  /** Whether `a` is guaranteed to have finished before `b` starts. */
  const runsBefore = (a: UsageEntry, b: UsageEntry): boolean =>
    a.node === b.node
      ? a.index < b.index
      : needsTransitively(nodes, b.node, a.node);

  for (let i = 1; i < matchedPositions.length; i++) {
    const prev = matchedPositions[i - 1];
    const curr = matchedPositions[i];
    const path = `required[${curr.index}]`;

    if (ordering === 'strict') {
      const a = prev.usage;
      const b = curr.usage;
      const adjacent =
        a.node === b.node
          ? b.index === a.index + 1
          : a.index === (nodes.get(a.node)?.length ?? 0) - 1 &&
            b.index === 0 &&
            (nodes.get(b.node)?.needs.has(a.node) ?? false);
      if (!adjacent) {
        errors.push({
          path,
          message: `Required action "${curr.entry.uses}" must run immediately after "${prev.entry.uses}" (ordering: strict), but other steps appear in between`,
          severity: 'error'
        });
      }
    } else if (!runsBefore(prev.usage, curr.usage)) {
      const parallel = !runsBefore(curr.usage, prev.usage);
      errors.push({
        path,
        message:
          `Required action "${curr.entry.uses}" must run after "${prev.entry.uses}", but it does not` +
          (parallel
            ? ` (jobs "${nodes.get(prev.usage.node)?.label}" and "${nodes.get(curr.usage.node)?.label}" have no needs: relationship, so they may run in parallel)`
            : ''),
        severity: 'error'
      });
    }
  }

  // Supply-chain rules over the same flattened sequence (recursion
  // included), so a wrapper can't hide an unpinned or disallowed action.
  const FULL_SHA = /^[0-9a-f]{40}$/i;
  const isRemote = (u: UsageEntry): boolean =>
    !u.name.startsWith('.') && !u.name.startsWith('docker://');
  if (spec.pins?.required) {
    const allow = new Set(
      (spec.pins.allow ?? []).map((a) => normalizeActionName(a))
    );
    for (const usage of sequence) {
      if (!isRemote(usage)) continue;
      const owner = usage.name.split('/')[0];
      if (allow.has(usage.name) || allow.has(owner)) continue;
      if (!usage.version || !FULL_SHA.test(usage.version)) {
        errors.push({
          path: usage.path,
          message: `Action "${usage.name}${usage.version ? '@' + usage.version : ''}" must be pinned to a full commit SHA`,
          severity: 'error'
        });
      }
    }
  }
  if (spec.allowedOwners && spec.allowedOwners.length > 0) {
    const allowed = new Set(
      spec.allowedOwners.map((o) => o.split('/')[0].toLowerCase())
    );
    for (const usage of sequence) {
      if (!isRemote(usage)) continue;
      const owner = usage.name.split('/')[0];
      if (!allowed.has(owner)) {
        errors.push({
          path: usage.path,
          message: `Action owner "${owner}" is not allowed (allowed owners: ${[...allowed].join(', ')})`,
          severity: 'error'
        });
      }
    }
  }

  if (spec.lockfile?.required) {
    errors.push(...checkLockfile(parsed, sequence.filter(isRemote)));
  }

  // The workflow file's own permissions; called workflows are validated as
  // files of their own.
  if (spec.permissions) {
    errors.push(...contractPermissionErrors(parsed.file, spec.permissions));
  }

  // Only the workflow's own on: matters: a called reusable workflow runs
  // under its caller's event.
  if (spec.forbiddenTriggers) {
    errors.push(...forbiddenTriggerErrors(parsed.file, spec.forbiddenTriggers));
  }

  return {
    valid: errors.every((e) => e.severity !== 'error'),
    errors
  };
}

/**
 * `lockfile.required`: the repository commits a lockfile (secureci.lock,
 * else GitHub's actions.lock) and it lists every remote reference used.
 * Offline: whether the locked commits still match is `inventory --check`.
 */
function checkLockfile(
  parsed: ParsedWorkflow,
  remote: UsageEntry[]
): ValidationError[] {
  const source = findLockfile(repositoryRoot(parsed.path));
  if (!source) {
    return [
      {
        path: 'lockfile',
        message:
          'The contract requires a lockfile, but the repository has no secureci.lock (or .github/workflows/actions.lock). Create one with: secureci inventory --update-lock',
        severity: 'error'
      }
    ];
  }
  const name = path.basename(source.file);
  let locked: Set<string>;
  try {
    locked = new Set(
      Object.keys(readLockfile(source).actions).map((uses) => {
        const { name: n, version } = splitActionRef(uses);
        return version === undefined ? n : `${n}@${version}`;
      })
    );
  } catch (error) {
    return [
      {
        path: 'lockfile',
        message: `Could not read ${name}: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error'
      }
    ];
  }
  return remote
    .filter((u) => !locked.has(`${u.name}@${u.version}`))
    .map((u) => ({
      path: u.path,
      message: `Action "${u.name}${u.version ? '@' + u.version : ''}" is not in ${name}; lock it with ${source.kind === 'github' ? '`gh actions-lock`' : '`secureci inventory --update-lock`'}`,
      severity: 'error' as const
    }));
}

/** Whether job `from` (transitively) needs job `to`. */
function needsTransitively(
  nodes: Map<string, JobNode>,
  from: string,
  to: string
): boolean {
  const seen = new Set<string>();
  const queue = [...(nodes.get(from)?.needs ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(nodes.get(id)?.needs ?? []));
  }
  return false;
}

async function buildGraph(
  parsed: ParsedWorkflow,
  recurse: ContractRecurse
): Promise<PipelineGraph> {
  const graph: PipelineGraph = { sequence: [], nodes: new Map(), errors: [] };
  const root = repositoryRoot(parsed.path);

  const isLocal = (uses: string) =>
    uses.startsWith('./') || uses.startsWith('../');

  /**
   * The file behind a composite action / reusable workflow reference, or
   * null (with a warning) if it can't be found. Local actions resolve
   * against the workspace, local workflows against their own repository.
   * Returns undefined for references that aren't followed.
   */
  const resolveRef = async (
    uses: string,
    kind: 'action' | 'workflow',
    workflowRoot: string,
    at: string
  ): Promise<string | null | undefined> => {
    if (isLocal(uses)) {
      if (recurse === 'none') return undefined;
      const target = path.resolve(
        kind === 'action' ? root : workflowRoot,
        uses
      );
      const names = kind === 'action' ? ['action.yml', 'action.yaml'] : [];
      for (const candidate of [
        target,
        ...names.map((n) => path.join(target, n))
      ]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return candidate;
        }
      }
      graph.errors.push({
        path: at,
        message:
          kind === 'action'
            ? `Local action "${uses}" could not be resolved, so its steps were not checked`
            : `Local reusable workflow "${uses}" could not be resolved, so its jobs were not checked`,
        severity: 'warning'
      });
      return null;
    }
    if (recurse !== 'all' || uses.startsWith('docker://')) return undefined;
    const file =
      kind === 'action' ? await fetchAction(uses) : await fetchRepoFile(uses);
    if (!file) {
      graph.errors.push({
        path: at,
        message: `Remote ${kind} "${uses}" could not be fetched, so its ${kind === 'action' ? 'steps' : 'jobs'} were not checked`,
        severity: 'warning'
      });
    }
    return file;
  };

  /** Parse an action/workflow file, recording an error if it's invalid. */
  const parse = (file: string, at: string) => {
    try {
      return parseFile(file);
    } catch (error) {
      graph.errors.push({
        path: at,
        message: `Could not parse ${path.relative(root, file)}: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error'
      });
      return null;
    }
  };

  /** Check recursion limits; returns false (with an error) to stop. */
  const canEnter = (file: string, stack: string[], at: string): boolean => {
    if (stack.includes(file)) {
      graph.errors.push({
        path: at,
        message: `Action/workflow cycle: ${[...stack, file]
          .map((f) => path.relative(root, f))
          .join(' -> ')}`,
        severity: 'error'
      });
      return false;
    }
    if (stack.length >= MAX_DEPTH) {
      graph.errors.push({
        path: at,
        message: `Actions/workflows exceed the maximum nesting depth (${MAX_DEPTH})`,
        severity: 'error'
      });
      return false;
    }
    return true;
  };

  const addUsage = (
    node: string,
    index: number,
    at: string,
    uses: string,
    conditional: boolean
  ): void => {
    graph.sequence.push({
      node,
      index,
      path: at,
      conditional,
      ...splitActionRef(uses)
    });
  };

  /** Flatten a job's steps (and composite action steps) into `node`. */
  const addSteps = async (
    steps: Step[],
    node: string,
    at: string,
    counter: { next: number },
    stack: string[],
    workflowRoot: string,
    conditional: boolean
  ): Promise<void> => {
    for (const [i, step] of steps.entries()) {
      const stepPath = `${at}steps[${i}]`;
      if (!step.uses) {
        counter.next++;
        continue;
      }
      const stepConditional = conditional || hasCondition(step.if);
      addUsage(node, counter.next++, stepPath, step.uses, stepConditional);
      const file = await resolveRef(
        step.uses,
        'action',
        workflowRoot,
        stepPath
      );
      if (!file || !canEnter(file, stack, stepPath)) continue;
      const action = parse(file, stepPath);
      if (action?.type === 'action' && action.file.runs.using === 'composite') {
        await addSteps(
          action.file.runs.steps ?? [],
          node,
          `${stepPath} > ${step.uses} > `,
          counter,
          [...stack, file],
          workflowRoot,
          stepConditional
        );
      }
    }
  };

  /**
   * Add a workflow's jobs. Every job also runs after `after` (the jobs the
   * reusable-workflow call itself needs, plus the call). Returns the ids
   * of the added jobs.
   */
  const addWorkflow = async (
    workflow: WorkflowFile,
    workflowRoot: string,
    prefix: string,
    labelPrefix: string,
    at: string,
    after: string[],
    stack: string[],
    conditional: boolean
  ): Promise<string[]> => {
    const added: string[] = [];
    // A job id -> the graph nodes standing for it (a reusable-workflow call
    // stands for the call and all of its called jobs).
    const alias = new Map<string, string[]>();

    for (const jobId of topologicalJobOrder(workflow.jobs)) {
      const job = workflow.jobs[jobId];
      const node = `${prefix}${jobId}`;
      const needs = new Set(after);
      for (const dep of [job.needs ?? []].flat()) {
        for (const id of alias.get(dep) ?? []) needs.add(id);
      }
      graph.nodes.set(node, {
        label: `${labelPrefix}${jobId}`,
        needs,
        length: 0
      });
      added.push(node);
      const jobPath = `${at}jobs.${jobId}`;
      const jobConditional = conditional || hasCondition(job.if);

      if (job.uses) {
        // The call itself is a one-step "job" its called jobs run after.
        addUsage(node, 0, jobPath, job.uses, jobConditional);
        (graph.nodes.get(node) as JobNode).length = 1;
        const ids = [node];
        const file = await resolveRef(
          job.uses,
          'workflow',
          workflowRoot,
          jobPath
        );
        if (file && canEnter(file, stack, jobPath)) {
          const called = parse(file, jobPath);
          if (called?.type === 'workflow') {
            ids.push(
              ...(await addWorkflow(
                called.file,
                repositoryRoot(file),
                `${node}>`,
                `${labelPrefix}${jobId} > ${job.uses} > `,
                `${jobPath} > ${job.uses} > `,
                [...needs, node],
                [...stack, file],
                jobConditional
              ))
            );
          }
        }
        alias.set(jobId, ids);
        added.push(...ids.slice(1));
        continue;
      }

      alias.set(jobId, [node]);
      const counter = { next: 0 };
      await addSteps(
        job.steps ?? [],
        node,
        `${jobPath}.`,
        counter,
        stack,
        workflowRoot,
        jobConditional
      );
      (graph.nodes.get(node) as JobNode).length = counter.next;
    }
    return added;
  };

  await addWorkflow(
    parsed.file,
    root,
    '',
    '',
    '',
    [],
    [path.resolve(parsed.path)],
    false
  );
  return graph;
}

/**
 * Whether an `if:` can skip the step/job: anything but a missing value,
 * `true`, `success()` (the default) or `always()`.
 */
function hasCondition(condition: unknown): boolean {
  if (condition === undefined || condition === null || condition === true) {
    return false;
  }
  const text = String(condition)
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .trim();
  return !['', 'true', 'success()', 'always()'].includes(text);
}

function splitActionRef(uses: string): { name: string; version?: string } {
  const atIndex = uses.lastIndexOf('@');
  if (atIndex === -1 || uses.startsWith('docker://')) {
    return { name: normalizeActionName(uses) };
  }
  return {
    name: normalizeActionName(uses.slice(0, atIndex)),
    version: uses.slice(atIndex + 1)
  };
}

/**
 * Lower-case the `owner/repo` part of a marketplace-style reference, which
 * GitHub resolves case-insensitively. A path inside the repo, local paths
 * (`./...`) and `docker://` references (whose tags are case-sensitive) are
 * kept as they are.
 */
function normalizeActionName(name: string): string {
  if (name.startsWith('.') || name.startsWith('docker://')) return name;
  const parts = name.split('/');
  return [
    ...parts.slice(0, 2).map((p) => p.toLowerCase()),
    ...parts.slice(2)
  ].join('/');
}

/**
 * Best-effort numeric semver-style comparison (ignoring a leading "v").
 * Returns undefined when either version string isn't numeric dot-notation
 * (e.g. a branch name or commit SHA), since it can't be meaningfully compared.
 */
function isVersionAtLeast(actual: string, min: string): boolean | undefined {
  const a = parseVersionParts(actual);
  const m = parseVersionParts(min);
  if (!a || !m) return undefined;

  const len = Math.max(a.length, m.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}

function parseVersionParts(version: string): number[] | null {
  const cleaned = version.trim().replace(/^v/i, '');
  if (!cleaned) return null;
  const parts = cleaned.split('.').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}
