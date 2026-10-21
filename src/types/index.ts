// TypeScript types for GitHub Actions and Workflows
// Types are designed to align with the official GitHub Workflow schema:
// https://json.schemastore.org/github-workflow.json
// https://json.schemastore.org/github-action.json
//
// Note: These types focus on the subset of features needed for local execution.
// Full schema compliance would include additional properties not relevant for SecureCI's use case.

export interface WorkflowFile {
  name: string;
  on: WorkflowTrigger;
  /** Default GITHUB_TOKEN permissions for every job. */
  permissions?: Permissions;
  env?: Record<string, string>;
  defaults?: WorkflowDefaults;
  jobs: Record<string, Job>;
}

export type WorkflowTrigger = string | string[] | Record<string, unknown>;

/** Access a GITHUB_TOKEN permission scope grants. */
export type PermissionLevel = 'read' | 'write' | 'none';

/**
 * `permissions:` at the workflow or job level: a shorthand for every scope,
 * or scope -> level (unlisted scopes get `none`).
 */
export type Permissions =
  'read-all' | 'write-all' | Partial<Record<string, PermissionLevel>>;

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
  if?: string | boolean;
  /** GITHUB_TOKEN permissions for this job; replaces the workflow's. */
  permissions?: Permissions;
  env?: Record<string, string>;
  defaults?: WorkflowDefaults;
  steps?: Step[];
  outputs?: Record<string, string>;
  strategy?: JobStrategy;
  container?: string | JobContainer;
  /** Sidecar containers (databases, caches...) for the job. */
  services?: Record<string, string | JobService>;
  /** Minutes before the job is stopped and fails (may be an expression). */
  'timeout-minutes'?: number | string;
  /** Let the job (or a matrix combination) fail without failing the run. */
  'continue-on-error'?: boolean | string;
}

/** `jobs.<id>.container`: the image (and env) the job's steps run in. */
export interface JobContainer {
  image: string;
  env?: Record<string, string>;
  options?: string;
  volumes?: string[];
  ports?: Array<string | number>;
  credentials?: Record<string, string>;
}

/** `jobs.<id>.services.<id>`. */
export interface JobService {
  image: string;
  env?: Record<string, string>;
  ports?: Array<string | number>;
  volumes?: string[];
  /** Extra `docker run` options, e.g. `--health-cmd ...`. */
  options?: string;
  credentials?: Record<string, string>;
}

export interface JobStrategy {
  /** Axes plus include/exclude, or an expression producing them. */
  matrix?: Record<string, unknown> | string;
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
  /** Minutes before the step is stopped and fails (may be an expression). */
  'timeout-minutes'?: number | string;
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
  'pre-if'?: string;
  post?: string;
  'post-if'?: string;
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
 * order they must run in. Used by `secureci validate --contract <file>` to enforce
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
  /** Supply-chain pinning: require remote actions pinned to a commit SHA. */
  pins?: {
    required?: boolean;
    /** Owners or owner/repo exempt from the SHA requirement. */
    allow?: string[];
  };
  /** If set, every remote action's owner must be in this list. */
  allowedOwners?: string[];
  /** `forbidden-triggers`: events (e.g. pull_request_target) no workflow may use. */
  forbiddenTriggers?: string[];
  /**
   * Require a committed lockfile (secureci.lock, or GitHub's actions.lock)
   * listing every remote action and reusable workflow used.
   */
  lockfile?: {
    required?: boolean;
  };
  /** GITHUB_TOKEN permissions policy. */
  permissions?: PermissionsPolicy;
  /**
   * Known security advisories (`secureci/vulnerable-action`): findings at
   * or above `failOn` are errors, the rest warnings. Default: high.
   */
  advisories?: {
    failOn?: 'critical' | 'high' | 'medium' | 'low';
  };
}

/** Contract `permissions:` policy; violations are errors. */
export interface PermissionsPolicy {
  /** Every workflow (or every job) must declare `permissions:`. */
  required?: boolean;
  /**
   * Ceiling for workflow-level permissions (unlisted scopes: `none`); write
   * scopes beyond it must be granted per job.
   */
  max?: Record<string, PermissionLevel>;
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
  /** SARIF rule id, e.g. "secureci/injection"; derived from the path when unset. */
  rule?: string;
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
  containerRuntime?: 'auto' | 'docker' | 'podman' | 'containerd' | 'host';
  /**
   * Image for every job without `jobs.<id>.container` (`--container-image`),
   * overriding the `runs-on` mapping.
   */
  containerImage?: string;
  /** `runs-on` label -> image, merged over the built-in mapping. */
  runnerImages?: Record<string, string>;
  /** Image for `runs-on` labels with no mapping (config `container-image`). */
  defaultContainerImage?: string;
  /** Per-step execution timeout in milliseconds when containerized. */
  containerTimeoutMs?: number;
  /** Memory limit (e.g. '512m') applied to the container, if supported. */
  containerMemoryLimit?: string;
  /** Disable container networking. Default: false (network on). */
  networkDisabled?: boolean;
  /** Extra env for every step (`--env`), below workflow/job/step `env:`. */
  env?: Record<string, string>;
  /** The `vars` context (configuration variables), e.g. from --var. */
  vars?: Record<string, string>;
  /** JSON file with the triggering event payload (`github.event`). */
  eventPath?: string;
  /** `github.event_name`. Default: $GITHUB_EVENT_NAME, else workflow_dispatch. */
  eventName?: string;
  /**
   * Use the local working copy for `actions/checkout` of the current
   * repository instead of running the action. Default: true.
   */
  localCheckout?: boolean;
  /** Use only cached remote actions; never download. */
  offline?: boolean;
  /** `github.run_id`, shared by every job and called workflow of a run. */
  runId?: string;
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
  /** Evaluated `jobs.<id>.outputs`. */
  outputs?: Record<string, string>;
  /** Failed, but allowed to by job-level `continue-on-error`. */
  continueOnError?: boolean;
  /** Markdown the steps wrote to `$GITHUB_STEP_SUMMARY`. */
  summary?: string;
  duration: number;
}

export interface WorkflowResult {
  success: boolean;
  jobs: JobResult[];
  duration: number;
  /** `on.workflow_call.outputs`, evaluated after the jobs ran. */
  outputs?: Record<string, string>;
}
