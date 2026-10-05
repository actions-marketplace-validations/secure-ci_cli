import {
  ParsedWorkflow,
  PipelineContractEntry,
  PipelineContractSpec,
  ValidationError,
  ValidationResult,
  WorkflowFile
} from '../types';
import { topologicalJobOrder } from '../runner/executor';

interface UsageEntry {
  jobId: string;
  stepIndex: number;
  globalIndex: number;
  name: string;
  version?: string;
}

/**
 * Validate a workflow's job/step sequence against a central pipeline
 * contract: a minimum set of required actions (optionally ordered) and a
 * deny-list of forbidden actions.
 *
 * Scope (see ai-docs discussion): only `uses:` steps declared directly in
 * the given workflow file are considered, in whole-workflow order (job
 * order resolved via `needs:`, then declared step order within each job).
 * Steps inside a called reusable workflow or composite action are not
 * resolved/recursed into.
 */
export function validatePipelineContract(
  parsed: ParsedWorkflow,
  spec: PipelineContractSpec
): ValidationResult {
  const errors: ValidationError[] = [];
  const sequence = collectUsageSequence(parsed.file);
  const ordering = spec.ordering ?? 'relative';

  for (const entry of spec.forbidden ?? []) {
    for (const usage of sequence) {
      if (
        usage.name === entry.uses &&
        (entry.version === undefined || usage.version === entry.version)
      ) {
        errors.push({
          path: `jobs.${usage.jobId}.steps[${usage.stepIndex}]`,
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
  }[] = [];

  (spec.required ?? []).forEach((entry, idx) => {
    const path = `required[${idx}]`;
    const candidates = sequence.filter((u) => u.name === entry.uses);

    if (candidates.length === 0) {
      errors.push({
        path,
        message: `Required action "${entry.uses}" was not found in the pipeline`,
        severity: 'error'
      });
      return;
    }

    if (!entry['min-version']) {
      matchedPositions.push({ entry, usage: candidates[0] });
      return;
    }

    const satisfying = candidates.find(
      (c) => c.version && isVersionAtLeast(c.version, entry['min-version']!)
    );
    if (satisfying) {
      matchedPositions.push({ entry, usage: satisfying });
      return;
    }

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
      matchedPositions.push({ entry, usage: candidates[0] });
    }
  });

  for (let i = 1; i < matchedPositions.length; i++) {
    const prev = matchedPositions[i - 1];
    const curr = matchedPositions[i];

    if (ordering === 'strict') {
      if (curr.usage.globalIndex !== prev.usage.globalIndex + 1) {
        errors.push({
          path: `required[${i}]`,
          message: `Required action "${curr.entry.uses}" must run immediately after "${prev.entry.uses}" (ordering: strict), but other steps appear in between`,
          severity: 'error'
        });
      }
    } else if (curr.usage.globalIndex <= prev.usage.globalIndex) {
      errors.push({
        path: `required[${i}]`,
        message: `Required action "${curr.entry.uses}" must run after "${prev.entry.uses}", but it does not`,
        severity: 'error'
      });
    }
  }

  return {
    valid: errors.every((e) => e.severity !== 'error'),
    errors
  };
}

function collectUsageSequence(workflow: WorkflowFile): UsageEntry[] {
  const jobOrder = topologicalJobOrder(workflow.jobs);
  const sequence: UsageEntry[] = [];
  let globalIndex = 0;

  for (const jobId of jobOrder) {
    const steps = workflow.jobs[jobId].steps ?? [];
    steps.forEach((step, stepIndex) => {
      if (step.uses) {
        const { name, version } = splitActionRef(step.uses);
        sequence.push({ jobId, stepIndex, globalIndex, name, version });
      }
      globalIndex++;
    });
  }

  return sequence;
}

function splitActionRef(uses: string): { name: string; version?: string } {
  const atIndex = uses.lastIndexOf('@');
  if (atIndex === -1) return { name: uses };
  return { name: uses.slice(0, atIndex), version: uses.slice(atIndex + 1) };
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
