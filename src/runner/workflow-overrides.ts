import { parseFile } from '../parser/workflow-parser';
import type {
  Job,
  ParsedFile,
  WorkflowFile,
  WorkflowOverride,
  WorkflowOverrides
} from '../types';
import { logger } from '../utils/logger';

export interface OverriddenWorkflow {
  workflow: WorkflowFile;
  /** One line per value replaced: `jobs.<id>.<field>: old -> new`. */
  changes: string[];
}

/** The replacement for `value`, or undefined to keep it. */
function replacement(
  override: WorkflowOverride | undefined,
  values: string[]
): string | undefined {
  if (override === undefined) return undefined;
  if (typeof override === 'string') return override;
  for (const value of values) {
    if (Object.prototype.hasOwnProperty.call(override, value)) {
      return override[value];
    }
  }
  return undefined;
}

/** `runs-on` as a list of labels: a string, a list, or `{group, labels}`. */
function runsOnLabels(runsOn: unknown): string[] {
  const raw = Array.isArray(runsOn)
    ? runsOn
    : runsOn && typeof runsOn === 'object'
      ? [(runsOn as { labels?: unknown }).labels ?? []].flat()
      : [runsOn];
  return raw.filter((label): label is string => typeof label === 'string');
}

function describeRunsOn(runsOn: unknown): string {
  return typeof runsOn === 'object' && !Array.isArray(runsOn)
    ? JSON.stringify(runsOn)
    : runsOnLabels(runsOn).join(', ');
}

/** The image of a `container:` or service: the string, or its `image`. */
function imageOf(spec: unknown): string | undefined {
  if (typeof spec === 'string') return spec;
  if (spec && typeof spec === 'object') {
    const image = (spec as { image?: unknown }).image;
    return typeof image === 'string' ? image : undefined;
  }
  return undefined;
}

function withImage<T>(spec: T, image: string): T {
  return (typeof spec === 'string' ? image : { ...spec, image }) as T;
}

/**
 * Rewrite a workflow for a profile (`run --profile`): each job's `runs-on`,
 * the image of `jobs.<id>.container` and of `jobs.<id>.services`. A string
 * override replaces the value in every job that has one; a mapping replaces
 * only the values it lists (for `runs-on`, when any label matches, the whole
 * `runs-on` is replaced). Jobs without a `container:` don't get one: their
 * image comes from `runs-on` (see `runner-images`). Returns a copy.
 */
export function applyWorkflowOverrides(
  workflow: WorkflowFile,
  overrides: WorkflowOverrides
): OverriddenWorkflow {
  const changes: string[] = [];
  const jobs: Record<string, Job> = {};

  for (const [jobId, original] of Object.entries(workflow.jobs ?? {})) {
    const job: Job = { ...original };
    jobs[jobId] = job;

    if (job['runs-on'] !== undefined) {
      const runsOn = replacement(
        overrides['runs-on'],
        runsOnLabels(job['runs-on'])
      );
      if (runsOn !== undefined) {
        changes.push(
          `jobs.${jobId}.runs-on: ${describeRunsOn(job['runs-on'])} -> ${runsOn}`
        );
        job['runs-on'] = runsOn;
      }
    }

    const containerImage = imageOf(job.container);
    if (job.container !== undefined && containerImage !== undefined) {
      const image = replacement(overrides['container-image'], [containerImage]);
      if (image !== undefined) {
        changes.push(`jobs.${jobId}.container: ${containerImage} -> ${image}`);
        job.container = withImage(job.container, image);
      }
    }

    if (job.services && overrides['service-images'] !== undefined) {
      const services: NonNullable<Job['services']> = {};
      for (const [name, service] of Object.entries(job.services)) {
        const serviceImage = imageOf(service);
        const image =
          serviceImage === undefined
            ? undefined
            : replacement(overrides['service-images'], [serviceImage]);
        if (image === undefined) {
          services[name] = service;
          continue;
        }
        changes.push(
          `jobs.${jobId}.services.${name}: ${serviceImage} -> ${image}`
        );
        services[name] = withImage(service, image);
      }
      job.services = services;
    }
  }

  return { workflow: { ...workflow, jobs }, changes };
}

/**
 * Parse a workflow or action file for a run (or dry run), applying the
 * profile's workflow overrides and logging each value they replace.
 */
export function parseFileForRun(
  filePath: string,
  overrides: WorkflowOverrides | undefined,
  profile: string | undefined
): ParsedFile {
  const parsed = parseFile(filePath);
  if (parsed.type !== 'workflow' || !overrides) return parsed;
  const { workflow, changes } = applyWorkflowOverrides(parsed.file, overrides);
  const label = profile ? `Profile "${profile}"` : 'Profile';
  for (const change of changes) logger.info(`${label}: ${change}`);
  return { ...parsed, file: workflow };
}
