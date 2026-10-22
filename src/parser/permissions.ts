import {
  Job,
  PermissionLevel,
  Permissions,
  PermissionsPolicy,
  ValidationError,
  WorkflowFile
} from '../types';

/** SARIF rule for every GITHUB_TOKEN permissions finding. */
const RULE = 'secureci/permissions';

/**
 * Scopes `permissions:` accepts, per GitHub's workflow syntax.
 * `repository-projects` is kept for older workflows (classic Projects).
 */
export const GITHUB_TOKEN_SCOPES: readonly string[] = [
  'actions',
  'artifact-metadata',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'repository-projects',
  'security-events',
  'statuses'
];

const RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2 };

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

/** Rank of a level, or undefined for anything that isn't one. */
const rankOf = (level: unknown): number | undefined =>
  typeof level === 'string' && hasOwn(RANK, level)
    ? RANK[level as PermissionLevel]
    : undefined;

const declared = (permissions: Permissions | undefined | null): boolean =>
  permissions !== undefined && permissions !== null;

const isScopeMap = (
  permissions: Permissions | undefined | null
): permissions is Partial<Record<string, PermissionLevel>> =>
  typeof permissions === 'object' &&
  permissions !== null &&
  !Array.isArray(permissions);

/**
 * A reusable workflow runs with its caller's token, so a workflow whose only
 * trigger is `workflow_call` doesn't need its own top-level block.
 */
function onlyWorkflowCall(on: WorkflowFile['on']): boolean {
  const events =
    typeof on === 'string'
      ? [on]
      : Array.isArray(on)
        ? on
        : on && typeof on === 'object'
          ? Object.keys(on)
          : [];
  return events.length > 0 && events.every((e) => e === 'workflow_call');
}

/**
 * Jobs whose token falls back to the repository/organization default:
 * no top-level `permissions:` and none on the job. Empty when the workflow
 * declares a top-level block or only runs as a reusable workflow.
 */
function uncoveredJobs(workflow: WorkflowFile): string[] {
  if (declared(workflow.permissions) || onlyWorkflowCall(workflow.on)) {
    return [];
  }
  return Object.entries(workflow.jobs ?? {})
    .filter(([, job]: [string, Job | null]) => !declared(job?.permissions))
    .map(([id]) => id);
}

const quoteList = (ids: string[]): string =>
  ids.map((id) => `"${id}"`).join(', ');

const finding = (
  path: string,
  message: string,
  severity: ValidationError['severity']
): ValidationError => ({ path, message, severity, rule: RULE });

/**
 * Default GITHUB_TOKEN checks (warnings, so existing workflows keep
 * validating): jobs left on the default token, `write-all` at either level,
 * and write scopes granted to every job at the workflow level.
 */
export function workflowPermissionErrors(
  workflow: WorkflowFile
): ValidationError[] {
  const errors: ValidationError[] = [];
  const uncovered = uncoveredJobs(workflow);
  if (uncovered.length > 0) {
    errors.push(
      finding(
        'permissions',
        `No top-level permissions: and job(s) ${quoteList(uncovered)} declare none, so their GITHUB_TOKEN gets the repository's default permissions (read/write on every scope in many repositories). Add a top-level block such as "permissions: { contents: read }", or declare permissions on each job`,
        'warning'
      )
    );
  }

  const top = workflow.permissions;
  if (top === 'write-all') {
    errors.push(
      finding(
        'permissions',
        'permissions: write-all gives every job write access to every scope. Keep the top level read-only (e.g. "contents: read") and grant write scopes on the jobs that need them',
        'warning'
      )
    );
  } else if (isScopeMap(top)) {
    for (const [scope, level] of Object.entries(top)) {
      if (level !== 'write') continue;
      errors.push(
        finding(
          `permissions.${scope}`,
          `Workflow-level "${scope}: write" applies to every job. Declare it on the job(s) that need it instead (job-level permissions replace the top-level ones)`,
          'warning'
        )
      );
    }
  }

  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if ((job as Job | null)?.permissions === 'write-all') {
      errors.push(
        finding(
          `jobs.${jobId}.permissions`,
          `Job "${jobId}" uses permissions: write-all, giving its GITHUB_TOKEN write access to every scope. List only the scopes it needs`,
          'warning'
        )
      );
    }
  }
  return errors;
}

/**
 * Contract `permissions:` policy (errors). `required`: every job must have
 * declared permissions, top-level or its own. `max`: a ceiling on the
 * top-level block (unlisted scopes are capped at `none`); job-level
 * permissions aren't capped, so write scopes go per job. A workflow whose
 * only trigger is `workflow_call` needs no top-level block for either.
 */
export function contractPermissionErrors(
  workflow: WorkflowFile,
  policy: PermissionsPolicy
): ValidationError[] {
  const uncovered = uncoveredJobs(workflow);
  const max = policy.max;
  if (uncovered.length > 0 && (policy.required || max)) {
    return [
      finding(
        'permissions',
        policy.required
          ? `The contract requires declared GITHUB_TOKEN permissions, but the workflow has no top-level permissions: and job(s) ${quoteList(uncovered)} declare none. Add a top-level permissions: block, or declare permissions on each job`
          : `The contract caps workflow-level permissions at (${formatCeiling(max!)}), but the workflow has no top-level permissions:, so job(s) ${quoteList(uncovered)} get the repository's default token permissions. Add a top-level block within the cap, or declare permissions on each job`,
        'error'
      )
    ];
  }
  if (!max) return [];

  const ceiling = (scope: string): number =>
    (hasOwn(max, scope) ? rankOf(max[scope]) : undefined) ?? RANK.none;
  const top = workflow.permissions;
  if (top === 'read-all' || top === 'write-all') {
    const needed = top === 'read-all' ? RANK.read : RANK.write;
    if (GITHUB_TOKEN_SCOPES.some((scope) => ceiling(scope) < needed)) {
      return [
        finding(
          'permissions',
          `Workflow-level "${top}" exceeds the contract's cap on workflow-level permissions (${formatCeiling(max)}). List only the scopes the cap allows, and grant the rest on the jobs that need them`,
          'error'
        )
      ];
    }
    return [];
  }

  const errors: ValidationError[] = [];
  if (isScopeMap(top)) {
    for (const [scope, level] of Object.entries(top)) {
      const rank = rankOf(level);
      if (rank !== undefined && rank > ceiling(scope)) {
        errors.push(
          finding(
            `permissions.${scope}`,
            `Workflow-level "${scope}: ${level}" exceeds the contract's cap on workflow-level permissions (${formatCeiling(max)}). Grant it on the job(s) that need it instead`,
            'error'
          )
        );
      }
    }
  }
  return errors;
}

function formatCeiling(max: Record<string, PermissionLevel>): string {
  const entries = Object.entries(max);
  return entries.length === 0
    ? 'none'
    : entries.map(([scope, level]) => `${scope}: ${level}`).join(', ');
}
