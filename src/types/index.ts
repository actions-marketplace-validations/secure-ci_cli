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
}

export interface StepResult {
  step: Step;
  success: boolean;
  output?: string;
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
