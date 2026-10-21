import * as fs from 'fs';
import * as path from 'path';
import {
  ActionFile,
  Step,
  ValidationError,
  WorkflowFile,
  WorkflowTrigger
} from '../types';
import { expressionDataFlow } from '../runner/expression';
import { repositoryRoot } from '../utils/repository';
import { parseFile } from './workflow-parser';

/**
 * Contexts an outside contributor can set to arbitrary text (`*` matches
 * any key or array index). Based on GitHub Security Lab's list of untrusted
 * input (https://securitylab.github.com/resources/github-actions-untrusted-input/),
 * which GitHub's security hardening guide and zizmor's template-injection
 * audit also use, plus discussion text, PR/issue label names and the
 * fields of `workflow_run` that come from the triggering branch.
 *
 * Inputs of `workflow_dispatch` / `workflow_call` (and the matching
 * `github.event.inputs.*`) are untrusted too, except typed ones that can't
 * hold arbitrary text; those are derived from each workflow's triggers.
 */
export const UNTRUSTED_CONTEXTS: readonly string[] = [
  'github.head_ref',
  'github.event.issue.title',
  'github.event.issue.body',
  'github.event.issue.labels.*.name',
  'github.event.pull_request.title',
  'github.event.pull_request.body',
  'github.event.pull_request.labels.*.name',
  'github.event.pull_request.head.ref',
  'github.event.pull_request.head.label',
  'github.event.pull_request.head.repo.default_branch',
  'github.event.comment.body',
  'github.event.review.body',
  'github.event.discussion.title',
  'github.event.discussion.body',
  'github.event.pages.*.page_name',
  'github.event.commits.*.message',
  'github.event.commits.*.author.email',
  'github.event.commits.*.author.name',
  'github.event.commits.*.committer.email',
  'github.event.commits.*.committer.name',
  'github.event.head_commit.message',
  'github.event.head_commit.author.email',
  'github.event.head_commit.author.name',
  'github.event.head_commit.committer.email',
  'github.event.head_commit.committer.name',
  'github.event.workflow_run.display_title',
  'github.event.workflow_run.head_branch',
  'github.event.workflow_run.head_commit.message',
  'github.event.workflow_run.head_commit.author.email',
  'github.event.workflow_run.head_commit.author.name',
  'github.event.workflow_run.pull_requests.*.head.ref'
];

/** A context path as lower-cased segments, `*` for any key. */
type ContextPath = string[];

const BASE_PATTERNS: ContextPath[] = UNTRUSTED_CONTEXTS.map((c) =>
  c.split('.')
);

/** Input types whose values are constrained, so can't carry a payload. */
const SAFE_INPUT_TYPES = new Set([
  'boolean',
  'number',
  'choice',
  'environment'
]);

const GITHUB_SCRIPT = /^actions\/github-script(@|$)/i;

const RULE = 'secureci/injection';

/** The inner text of every `${{ }}` in a string, as the runner finds them. */
function expressionsIn(text: string): string[] {
  return [...text.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1].trim());
}

/** Whether `prefix` matches the leading segments of `full`. */
function startsWith(full: ContextPath, prefix: ContextPath): boolean {
  return (
    prefix.length <= full.length &&
    prefix.every((seg, i) => seg === '*' || full[i] === '*' || seg === full[i])
  );
}

/**
 * The untrusted context paths that reach an expression's result: a value
 * at or below an untrusted path, or (via toJSON) a whole subtree that holds
 * one. An expression GitHub couldn't parse has none.
 */
function untrustedSources(expr: string, patterns: ContextPath[]): string[] {
  const flow = expressionDataFlow(expr);
  if (!flow) return [];
  const hits = [
    ...flow.values.filter((v) => patterns.some((p) => startsWith(v, p))),
    ...flow.trees.filter((t) =>
      patterns.some((p) => startsWith(t, p) || startsWith(p, t))
    )
  ];
  return [...new Set(hits.map((h) => h.join('.')))];
}

function isUntrusted(text: unknown, patterns: ContextPath[]): boolean {
  return expressionsIn(String(text)).some(
    (expr) => untrustedSources(expr, patterns).length > 0
  );
}

/** `inputs.<name>` / `github.event.inputs.<name>` of string-typed inputs. */
function workflowInputPatterns(on: WorkflowTrigger): ContextPath[] {
  if (!on || typeof on !== 'object' || Array.isArray(on)) return [];
  const names = new Set<string>();
  for (const trigger of ['workflow_dispatch', 'workflow_call']) {
    const spec = on[trigger] as
      { inputs?: Record<string, { type?: string } | null> } | null | undefined;
    for (const [name, input] of Object.entries(spec?.inputs ?? {})) {
      const type = String(input?.type ?? 'string').toLowerCase();
      if (!SAFE_INPUT_TYPES.has(type)) names.add(name.toLowerCase());
    }
  }
  return [...names].flatMap((name) => [
    ['inputs', name],
    ['github', 'event', 'inputs', name]
  ]);
}

/**
 * `inputs.<name>` of a composite action's inputs that its caller fills
 * with untrusted input (or whose default is untrusted, when not given).
 */
function compositeInputPatterns(
  action: ActionFile,
  given: Record<string, unknown> | undefined,
  callerPatterns: ContextPath[]
): ContextPath[] {
  const patterns: ContextPath[] = [];
  for (const [name, input] of Object.entries(action.inputs ?? {})) {
    // Input names are case-insensitive.
    const passed = Object.entries(given ?? {}).find(
      ([key]) => key.toLowerCase() === name.toLowerCase()
    );
    const untrusted = passed
      ? isUntrusted(passed[1], callerPatterns)
      : input?.default !== undefined &&
        isUntrusted(input.default, BASE_PATTERNS);
    if (untrusted) patterns.push(['inputs', name.toLowerCase()]);
  }
  return patterns;
}

/** An environment variable name to suggest for a context path. */
function envName(source: string): string {
  // The first segment is a context name, so some segment isn't `*`.
  const segment = source
    .split('.')
    .filter((s) => s !== '*')
    .pop() as string;
  return segment.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

function finding(
  expr: string,
  sources: string[],
  kind: 'run' | 'script',
  at: string
): ValidationError {
  const name = envName(sources[0]);
  const target =
    kind === 'run'
      ? 'the shell script, so a crafted value can run arbitrary commands'
      : 'the github-script code, so a crafted value can run arbitrary code';
  const use = kind === 'run' ? `"$${name}"` : `process.env.${name}`;
  return {
    path: at,
    message: `\${{ ${expr} }} expands untrusted input (${sources.join(', ')}) into ${target}. Pass it through env: (e.g. env: ${name}: \${{ ${expr} }}) and use ${use} instead.`,
    severity: 'error',
    rule: RULE
  };
}

interface Scan {
  /** Repository root that local actions (`./...`) resolve against. */
  root: string;
  errors: ValidationError[];
}

function checkText(
  text: unknown,
  kind: 'run' | 'script',
  at: string,
  patterns: ContextPath[],
  scan: Scan
): void {
  for (const expr of expressionsIn(String(text))) {
    const sources = untrustedSources(expr, patterns);
    if (sources.length > 0) scan.errors.push(finding(expr, sources, kind, at));
  }
}

/** Parse a file reached by recursion, or null if it can't be. */
function tryParse(file: string) {
  try {
    return parseFile(file);
  } catch {
    // Not this check's concern: validating that file reports it.
    return null;
  }
}

/** The action.yml behind a local `uses: ./path`, if there is one. */
function resolveLocalAction(uses: string, root: string): string | undefined {
  const target = path.resolve(root, uses);
  return [
    target,
    path.join(target, 'action.yml'),
    path.join(target, 'action.yaml')
  ].find((f) => fs.existsSync(f) && fs.statSync(f).isFile());
}

const isLocal = (uses: string): boolean =>
  uses.startsWith('./') || uses.startsWith('../');

function checkSteps(
  steps: Step[],
  at: string,
  patterns: ContextPath[],
  stack: string[],
  scan: Scan
): void {
  steps.forEach((step, i) => {
    const stepPath = `${at}steps[${i}]`;
    if (step.run !== undefined) {
      checkText(step.run, 'run', `${stepPath}.run`, patterns, scan);
    }
    if (!step.uses) return;
    if (GITHUB_SCRIPT.test(step.uses) && step.with?.script !== undefined) {
      checkText(
        step.with.script,
        'script',
        `${stepPath}.with.script`,
        patterns,
        scan
      );
    }
    if (!isLocal(step.uses)) return;
    const file = resolveLocalAction(step.uses, scan.root);
    if (!file || stack.includes(file)) return;
    const parsed = tryParse(file);
    if (parsed?.type !== 'action') return;
    checkSteps(
      parsed.file.runs.steps ?? [],
      `${stepPath} > ${step.uses} > `,
      [
        ...BASE_PATTERNS,
        ...compositeInputPatterns(parsed.file, step.with, patterns)
      ],
      [...stack, file],
      scan
    );
  });
}

function checkWorkflow(
  workflow: WorkflowFile,
  file: string,
  at: string,
  stack: string[],
  scan: Scan
): void {
  const patterns = [...BASE_PATTERNS, ...workflowInputPatterns(workflow.on)];
  for (const [jobId, job] of Object.entries(workflow.jobs)) {
    if (!job.uses) {
      checkSteps(job.steps ?? [], `${at}jobs.${jobId}.`, patterns, stack, scan);
      continue;
    }
    if (!isLocal(job.uses)) continue;
    // A local reusable workflow resolves against its caller's repository.
    const called = path.resolve(repositoryRoot(file), job.uses);
    if (stack.includes(called) || !fs.existsSync(called)) continue;
    const parsed = tryParse(called);
    if (parsed?.type !== 'workflow') continue;
    checkWorkflow(
      parsed.file,
      called,
      `${at}jobs.${jobId} > ${job.uses} > `,
      [...stack, called],
      scan
    );
  }
}

/**
 * Template injection in a workflow: an untrusted `${{ }}` expression (see
 * UNTRUSTED_CONTEXTS) in a `run:` script or `actions/github-script`'s
 * `with.script`. GitHub substitutes expressions into the script text before
 * it runs, so such a value becomes code. `env:` values are not checked:
 * passing data through the environment is the fix. Local composite
 * actions and local reusable workflows are checked recursively.
 */
export function workflowInjectionErrors(
  workflow: WorkflowFile,
  workflowPath: string
): ValidationError[] {
  const file = path.resolve(workflowPath);
  const scan: Scan = { root: repositoryRoot(file), errors: [] };
  checkWorkflow(workflow, file, '', [file], scan);
  return scan.errors;
}

/**
 * Template injection in a composite action's steps (see
 * workflowInjectionErrors). Its own inputs aren't treated as untrusted
 * here, since the callers are unknown; a workflow that passes untrusted
 * input to a local action is checked through that call.
 */
export function actionInjectionErrors(
  action: ActionFile,
  actionPath: string
): ValidationError[] {
  const file = path.resolve(actionPath);
  const scan: Scan = { root: repositoryRoot(file), errors: [] };
  checkSteps(action.runs?.steps ?? [], 'runs.', BASE_PATTERNS, [file], scan);
  return scan.errors;
}
