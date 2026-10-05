// TypeScript types for GitHub Actions and Workflows
// Types are designed to align with the official GitHub Workflow schema:
// https://json.schemastore.org/github-workflow.json
// https://json.schemastore.org/github-action.json
//
// Note: These types focus on the subset of features needed for local execution.
// Full schema compliance would include additional properties not relevant for actly's use case.

export interface WorkflowFile {
  name: string;
  on: WorkflowTrigger;
  env?: Record<string, string>;
  defaults?: WorkflowDefaults;
  jobs: Record<string, Job>;
}

export type WorkflowTrigger = string | string[] | Record<string, unknown>;

export interface WorkflowDefaults {
  run?: {
    shell?: string;
    'working-directory'?: string;
  };
}

export interface Job {
  name?: string;
  'runs-on'?: string | string[];
  uses?: string; // For reusable workflows
  with?: Record<string, string | number | boolean>;
  secrets?: Record<string, string> | 'inherit';
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
  defaults?: WorkflowDefaults;
  steps?: Step[];
  outputs?: Record<string, string>;
  strategy?: JobStrategy;
}

export interface JobStrategy {
  matrix?: Record<string, unknown>;
  'fail-fast'?: boolean;
  'max-parallel'?: number;
}

export interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  if?: string;
  'continue-on-error'?: boolean;
  'working-directory'?: string;
  shell?: string;
}

export interface ActionFile {
  name: string;
  description: string;
  author?: string;
  inputs?: Record<string, ActionInput>;
  outputs?: Record<string, ActionOutput>;
  runs: ActionRuns;
}

export interface ActionInput {
  description: string;
  required?: boolean;
  default?: string;
}

export interface ActionOutput {
  description: string;
  value?: string;
}

export interface ActionRuns {
  using: 'composite' | 'node12' | 'node16' | 'node20' | 'node22' | 'docker';
  steps?: Step[];
  main?: string;
  pre?: string;
  post?: string;
  image?: string;
  entrypoint?: string;
  args?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * A central/platform-team-authored contract describing the minimum set of
 * actions a calling workflow must (or must not) use, and optionally the
 * order they must run in. Used by `actly --contract <file>` to enforce
 * organization-wide pipeline standards on top of a reusable workflow/action.
 */
export interface PipelineContractSpec {
  /**
   * 'relative' (default): required actions must appear in the given order,
   * but other steps may run in between.
   * 'strict': required actions must run back-to-back, with no other step
   * (of any kind) in between.
   */
  ordering?: 'relative' | 'strict';
  required?: PipelineContractEntry[];
  forbidden?: PipelineContractEntry[];
}

export interface PipelineContractEntry {
  /** Action reference without the version pin, e.g. "org/security-scan". */
  uses: string;
  /** required-only: the matched step's version must be >= this (best-effort semver compare). */
  'min-version'?: string;
  /** forbidden-only: forbid this exact version only; omit to forbid the action entirely. */
  version?: string;
}

export interface ValidationError {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ParsedWorkflow {
  type: 'workflow';
  file: WorkflowFile;
  path: string;
}

export interface ParsedAction {
  type: 'action';
  file: ActionFile;
  path: string;
}

export type ParsedFile = ParsedWorkflow | ParsedAction;

export interface RunOptions {
  dryRun?: boolean;
  inputs?: Record<string, string>;
  secrets?: Record<string, string>;
  job?: string;
  verbose?: boolean;
  /** Container runtime to use for isolating `run:` steps. Default: 'docker'. */
  containerRuntime?: 'auto' | 'docker' | 'podman' | 'containerd' | 'none';
  /** Image to run steps in when a container runtime is used. */
  containerImage?: string;
  /** Per-step execution timeout in milliseconds when containerized. */
  containerTimeoutMs?: number;
  /** Memory limit (e.g. '512m') applied to the container, if supported. */
  containerMemoryLimit?: string;
  /** Disable container networking. Default: true. */
  networkDisabled?: boolean;
}

export interface StepResult {
  step: Step;
  success: boolean;
  outcome?: 'success' | 'failure' | 'skipped';
  output?: string;
  outputs?: Record<string, string>;
  error?: string;
  duration: number;
}

export interface JobResult {
  job: string;
  success: boolean;
  steps: StepResult[];
  duration: number;
}

export interface WorkflowResult {
  success: boolean;
  jobs: JobResult[];
  duration: number;
}
