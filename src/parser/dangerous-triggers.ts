import { Step, ValidationError, WorkflowFile } from '../types';

const RULE = 'secureci/dangerous-trigger';

/**
 * Triggers whose runs get the base repository's secrets and a read/write
 * `GITHUB_TOKEN` even when the change came from a fork.
 */
const PRIVILEGED_TRIGGERS = ['pull_request_target', 'workflow_run'];

/**
 * Expressions (or literal refs) in `actions/checkout`'s `ref:` /
 * `repository:` that select code the pull request's author controls,
 * rather than the base branch.
 */
const UNTRUSTED_CHECKOUT = [
  /github\.event\.pull_request\.head\.(sha|ref|repo\.full_name)\b/,
  /github\.event\.pull_request\.merge_commit_sha\b/,
  /github\.head_ref\b/,
  /github\.event\.workflow_run\.head_(sha|branch|commit\.id|repository\.full_name)\b/,
  /refs\/pull\//
];

/** A job `if:` that requires a maintainer-applied label to run. */
const LABEL_GATE = /github\.event\.(pull_request\.labels|label\.name)\b/;

/** The event names in `on:`, whichever form it takes (string, list or map). */
export function workflowTriggers(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) {
    return on.filter((t): t is string => typeof t === 'string');
  }
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
}

function isCheckout(step: Step): boolean {
  return step.uses?.split('@')[0].toLowerCase() === 'actions/checkout';
}

/** `with.ref` / `with.repository` of a checkout that selects untrusted code. */
function untrustedCheckoutInput(step: Step): string | undefined {
  if (!isCheckout(step)) return undefined;
  for (const key of ['ref', 'repository']) {
    const value = step.with?.[key];
    if (value === undefined) continue;
    if (UNTRUSTED_CHECKOUT.some((re) => re.test(String(value)))) {
      return `${key}: ${String(value)}`;
    }
  }
  return undefined;
}

/** How a step would execute checked-out code, or undefined if it doesn't. */
function executes(step: Step): string | undefined {
  if (step.run) return 'run:';
  if (step.uses?.startsWith('./')) return `uses: ${step.uses}`;
  return undefined;
}

/**
 * "Pwn request" detection (#46): a workflow triggered by
 * `pull_request_target` or `workflow_run` runs with secrets and a write
 * token, so a job that checks out the pull request's code and then runs
 * it (a `run:` step or a local `./` action, both of which use the checked
 * out files) lets a fork execute code with those privileges.
 *
 * - error: such a job (reported once, at its untrusted checkout).
 * - warning: the same job when its `if:` requires a label, since a
 *   maintainer must then approve each run.
 * - warning: a privileged trigger with no such job, once per trigger, so
 *   teams can audit it. Omitted when a job-level finding is reported, so
 *   a workflow is never reported twice for the same problem.
 */
export function dangerousTriggerErrors(
  workflow: WorkflowFile
): ValidationError[] {
  const triggers = workflowTriggers(workflow.on).filter((t) =>
    PRIVILEGED_TRIGGERS.includes(t)
  );
  if (triggers.length === 0) return [];
  const named = triggers.map((t) => `"${t}"`).join(', ');

  const findings: ValidationError[] = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const steps = job.steps ?? [];
    const checkoutIdx = steps.findIndex((s) => untrustedCheckoutInput(s));
    if (checkoutIdx === -1) continue;
    const runIdx = steps.findIndex(
      (s, i) => i > checkoutIdx && executes(s) !== undefined
    );
    if (runIdx === -1) continue;

    const gated = LABEL_GATE.test(String(job.if ?? ''));
    findings.push({
      path: `jobs.${jobId}.steps[${checkoutIdx}]`,
      message:
        `Job "${jobId}" checks out untrusted code (${untrustedCheckoutInput(steps[checkoutIdx])}) ` +
        `in a workflow triggered by ${named}, then executes it at steps[${runIdx}] (${executes(steps[runIdx])}). ` +
        `These triggers run with the repository's secrets and a write token, so a fork can run its own code with them` +
        (gated
          ? `. The job is gated by a label check in its if:, so review the pull request's code before applying the label`
          : `; check out the base ref instead, or move the build to an unprivileged pull_request workflow`),
      severity: gated ? 'warning' : 'error',
      rule: RULE
    });
  }
  if (findings.length > 0) return findings;

  return triggers.map((trigger) => ({
    path: `on.${trigger}`,
    message:
      `Workflow is triggered by "${trigger}", which runs with the repository's secrets and a write token ` +
      `even for ${trigger === 'workflow_run' ? 'runs started from a fork' : 'pull requests from forks'}; ` +
      `make sure it never checks out or runs untrusted code`,
    severity: 'warning' as const,
    rule: RULE
  }));
}

/** Contract `forbidden-triggers`: one error per forbidden event in `on:`. */
export function forbiddenTriggerErrors(
  workflow: WorkflowFile,
  forbidden: string[]
): ValidationError[] {
  return workflowTriggers(workflow.on)
    .filter((t) => forbidden.includes(t))
    .map((trigger) => ({
      path: `on.${trigger}`,
      message: `Trigger "${trigger}" is forbidden by the pipeline contract (forbidden-triggers)`,
      severity: 'error' as const,
      rule: 'secureci/contract'
    }));
}
