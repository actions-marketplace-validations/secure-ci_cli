import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunOptions } from '../types';
import { GithubContext } from './expression';
import { execSync } from 'child_process';

/**
 * Best-effort local git lookup, used to populate `github.sha` / `github.ref`.
 * Returns undefined if git isn't available or the directory isn't a repo.
 */
export function tryGit(command: string, cwd: string): string | undefined {
  try {
    return execSync(command, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

/** The triggering event: `github.event_name` and `github.event`. */
export interface EventInfo {
  name: string;
  payload: Record<string, unknown>;
}

/**
 * `owner/repo` from a git remote URL (`git@host:o/r.git`,
 * `https://host/o/r`, `ssh://git@host/o/r.git`); undefined for local paths.
 */
export function parseRepositoryFromRemote(url: string): string | undefined {
  const match = url
    .trim()
    .match(
      /^(?:[\w.-]+@[\w.-]+:|(?:https?|ssh|git):\/\/(?:[^@/]+@)?[^/]+\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/
    );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function payloadString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  let value: unknown = payload;
  for (const key of keys) {
    if (!value || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Build a (best-effort, local-only) `github.*` context object. Real GitHub
 * Actions populates this from the live Actions run; locally we fall back to
 * `GITHUB_*` environment variables (if the user has set them), the event
 * payload, and local git state (HEAD, branch, `origin` remote), matching
 * act's approach of approximating the context for local runs.
 */
export function buildGithubContext(
  workflowName: string,
  jobId: string,
  cwd: string,
  event: EventInfo = { name: 'workflow_dispatch', payload: {} },
  token = '',
  runId = ''
): GithubContext {
  const env = process.env;
  const sha = env.GITHUB_SHA || tryGit('git rev-parse HEAD', cwd) || '';
  const ref =
    env.GITHUB_REF ||
    payloadString(event.payload, 'ref') ||
    (() => {
      const branch = tryGit('git rev-parse --abbrev-ref HEAD', cwd);
      return branch ? `refs/heads/${branch}` : '';
    })();
  const refName =
    env.GITHUB_REF_NAME || ref.replace(/^refs\/(heads|tags)\//, '');
  const remote = tryGit('git config --get remote.origin.url', cwd);
  const repository =
    env.GITHUB_REPOSITORY ||
    payloadString(event.payload, 'repository', 'full_name') ||
    (remote && parseRepositoryFromRemote(remote)) ||
    path.basename(cwd);

  return {
    workflow: workflowName,
    job: jobId,
    sha,
    ref,
    ref_name: refName,
    event_name: event.name,
    event: event.payload,
    actor: env.GITHUB_ACTOR || os.userInfo().username,
    repository,
    repository_owner:
      env.GITHUB_REPOSITORY_OWNER ||
      payloadString(event.payload, 'repository', 'owner', 'login') ||
      (repository.includes('/') ? repository.split('/')[0] : ''),
    run_id: runId || env.GITHUB_RUN_ID || String(Date.now()),
    run_number: env.GITHUB_RUN_NUMBER || '1',
    run_attempt: env.GITHUB_RUN_ATTEMPT || '1',
    workspace: env.GITHUB_WORKSPACE || cwd,
    server_url: env.GITHUB_SERVER_URL || 'https://github.com',
    api_url: env.GITHUB_API_URL || 'https://api.github.com',
    // Only what the user passed as secrets.GITHUB_TOKEN: a local token is
    // never picked up implicitly, since every action in the run could read it.
    token
  };
}

/**
 * Defaults declared for `on.workflow_dispatch.inputs` / `on.workflow_call.
 * inputs`, which populate the `inputs` context when not passed explicitly.
 */
export function declaredInputDefaults(on: unknown): Record<string, string> {
  const defaults: Record<string, string> = {};
  if (!on || typeof on !== 'object' || Array.isArray(on)) return defaults;
  for (const trigger of ['workflow_dispatch', 'workflow_call']) {
    const inputs = (on as Record<string, { inputs?: unknown }>)[trigger]
      ?.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    for (const [name, def] of Object.entries(
      inputs as Record<string, { default?: unknown }>
    )) {
      if (def && def.default !== undefined && !(name in defaults)) {
        defaults[name] = String(def.default);
      }
    }
  }
  return defaults;
}

/** `on.workflow_call.outputs` as name -> value expression, if declared. */
export function workflowCallOutputs(
  on: unknown
): Record<string, string> | undefined {
  const outputs =
    on && typeof on === 'object' && !Array.isArray(on)
      ? (on as { workflow_call?: { outputs?: unknown } }).workflow_call?.outputs
      : undefined;
  if (!outputs || typeof outputs !== 'object') return undefined;
  const values: Record<string, string> = {};
  for (const [name, def] of Object.entries(
    outputs as Record<string, { value?: unknown }>
  )) {
    if (def?.value !== undefined) values[name] = String(def.value);
  }
  return values;
}

/** The workflow's own triggers, in declaration order. */
export function workflowTriggers(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (on && typeof on === 'object') return Object.keys(on);
  return [];
}

/**
 * The event for this run: `--event-name`, else $GITHUB_EVENT_NAME, else
 * workflow_dispatch if the workflow declares it, else its first trigger.
 * The payload comes from `--event-path`; without one, workflow_dispatch
 * gets `{ inputs }` like on GitHub, other events `{}`.
 */
export function loadEvent(
  options: RunOptions,
  inputs: Record<string, string>,
  on: unknown
): EventInfo {
  const triggers = workflowTriggers(on);
  const name =
    options.eventName ||
    process.env.GITHUB_EVENT_NAME ||
    (triggers.includes('workflow_dispatch') || triggers.length === 0
      ? 'workflow_dispatch'
      : triggers[0]);
  if (!options.eventPath) {
    return { name, payload: name === 'workflow_dispatch' ? { inputs } : {} };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(options.eventPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Invalid event payload ${options.eventPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      `Invalid event payload ${options.eventPath}: expected a JSON object`
    );
  }
  return { name, payload: payload as Record<string, unknown> };
}
