import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GithubContext } from './expression';

/**
 * Parse a runner "file command" file (`$GITHUB_OUTPUT`, `$GITHUB_ENV`,
 * `$GITHUB_STATE`), supporting both the simple `name=value` form and the
 * multiline heredoc form: `name<<DELIMITER` ... `DELIMITER`.
 */
export function parseKeyValueFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return values;
  }

  const lines = content.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line) {
      i++;
      continue;
    }

    const heredocMatch = line.match(/^([^=<]+)<<(.+)$/);
    if (heredocMatch) {
      const [, name, delimiter] = heredocMatch;
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      values[name.trim()] = valueLines.join('\n');
      i++; // Skip the closing delimiter line
      continue;
    }

    const eqIndex = line.indexOf('=');
    if (eqIndex > -1) {
      values[line.slice(0, eqIndex).trim()] = line.slice(eqIndex + 1);
    }
    i++;
  }

  return values;
}

/** Per-step file commands, as exposed to the step via `GITHUB_*` env vars. */
export interface StepFiles {
  dir: string;
  output: string;
  env: string;
  path: string;
  state: string;
  summary: string;
}

export interface StepFileResults {
  outputs: Record<string, string>;
  env: Record<string, string>;
  path: string[];
  state: Record<string, string>;
  /** Markdown written to `$GITHUB_STEP_SUMMARY`. */
  summary: string;
}

/**
 * Create empty `GITHUB_OUTPUT` / `GITHUB_ENV` / `GITHUB_PATH` /
 * `GITHUB_STATE` / `GITHUB_STEP_SUMMARY` files for one step, in `dir` (e.g.
 * a container exchange dir) or a fresh temp directory.
 */
export function createStepFiles(dir?: string): StepFiles {
  const baseDir =
    dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-step-'));
  const files: StepFiles = {
    dir: baseDir,
    output: path.join(baseDir, 'output'),
    env: path.join(baseDir, 'env'),
    path: path.join(baseDir, 'path'),
    state: path.join(baseDir, 'state'),
    summary: path.join(baseDir, 'summary')
  };
  for (const file of [
    files.output,
    files.env,
    files.path,
    files.state,
    files.summary
  ]) {
    fs.writeFileSync(file, '');
  }
  return files;
}

export function readStepFiles(files: StepFiles): StepFileResults {
  let pathLines: string[] = [];
  try {
    pathLines = fs
      .readFileSync(files.path, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Missing file: no PATH additions
  }

  return {
    outputs: parseKeyValueFile(files.output),
    env: parseKeyValueFile(files.env),
    path: pathLines,
    state: parseKeyValueFile(files.state),
    summary: (() => {
      try {
        return fs.readFileSync(files.summary, 'utf-8');
      } catch {
        return '';
      }
    })()
  };
}

export function cleanupStepFiles(files: StepFiles): void {
  fs.rmSync(files.dir, { recursive: true, force: true });
}

export interface WorkflowCommandAnnotation {
  level: 'warning' | 'error' | 'notice' | 'debug' | 'group';
  message: string;
}

export interface WorkflowCommandResult {
  /** The output with workflow-command lines removed. */
  text: string;
  masks: string[];
  outputs: Record<string, string>;
  state: Record<string, string>;
  annotations: WorkflowCommandAnnotation[];
}

function unescapeData(value: string): string {
  return value
    .replace(/%0D/gi, '\r')
    .replace(/%0A/gi, '\n')
    .replace(/%25/g, '%');
}

function unescapeProperty(value: string): string {
  return unescapeData(value).replace(/%3A/gi, ':').replace(/%2C/gi, ',');
}

function parseProperties(raw: string | undefined): Record<string, string> {
  const props: Record<string, string> = {};
  for (const pair of (raw || '').split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      props[pair.slice(0, eq).trim()] = unescapeProperty(pair.slice(eq + 1));
    }
  }
  return props;
}

/**
 * Interpret GitHub Actions workflow commands (`::add-mask::`,
 * `::set-output`, `::save-state`, `::warning::`, `::group::`, ...) written
 * to a step's stdout, in both the `::cmd::` and legacy `##[cmd]` syntax.
 * Problem matchers and `::echo::` have no local effect and are hidden;
 * nothing is interpreted between `::stop-commands::<token>` and
 * `::<token>::`. Unknown commands are left in the text.
 * https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions
 */
export function processWorkflowCommands(stdout: string): WorkflowCommandResult {
  const result: WorkflowCommandResult = {
    text: '',
    masks: [],
    outputs: {},
    state: {},
    annotations: []
  };
  const kept: string[] = [];
  let stopToken: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (stopToken !== undefined) {
      if (line === `::${stopToken}::`) stopToken = undefined;
      else kept.push(line);
      continue;
    }

    const match =
      line.match(/^::([a-zA-Z-]+)(?:\s+([^:]*))?::(.*)$/) ??
      line.match(/^##\[([a-zA-Z-]+)(?:\s+([^\]]*))?\](.*)$/);
    if (!match) {
      kept.push(line);
      continue;
    }

    const [, command, rawProps, rawData] = match;
    const data = unescapeData(rawData);
    const props = parseProperties(rawProps);

    switch (command) {
      case 'add-mask':
        if (data) result.masks.push(data);
        break;
      case 'set-output':
        if (props.name) result.outputs[props.name] = data;
        break;
      case 'save-state':
        if (props.name) result.state[props.name] = data;
        break;
      case 'warning':
      case 'error':
      case 'notice':
      case 'debug':
      case 'group':
        result.annotations.push({ level: command, message: data });
        break;
      case 'stop-commands':
        if (data) stopToken = data;
        break;
      case 'endgroup':
      case 'add-matcher':
      case 'remove-matcher':
      case 'echo':
        break;
      default:
        kept.push(line);
    }
  }

  result.text = kept.join('\n');
  return result;
}

/** A context value as an env var string ('' when unset). */
function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

export interface RunnerEnvOptions {
  workspace: string;
  eventPath: string;
  tempDir: string;
  toolCache: string;
}

function runnerOs(): string {
  switch (process.platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    default:
      return 'Linux';
  }
}

/**
 * The default environment variables GitHub's runner exports to every step,
 * derived from the (local, best-effort) `github` context.
 * https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables
 */
export function buildRunnerEnv(
  github: GithubContext,
  options: RunnerEnvOptions
): Record<string, string> {
  const env: Record<string, string> = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    GITHUB_WORKFLOW: text(github.workflow),
    GITHUB_JOB: text(github.job),
    GITHUB_SHA: text(github.sha),
    GITHUB_REF: text(github.ref),
    GITHUB_REF_NAME: text(github.ref_name),
    GITHUB_EVENT_NAME: text(github.event_name),
    GITHUB_ACTOR: text(github.actor),
    GITHUB_REPOSITORY: text(github.repository),
    GITHUB_REPOSITORY_OWNER: text(github.repository_owner),
    GITHUB_RUN_ID: text(github.run_id),
    GITHUB_RUN_NUMBER: text(github.run_number),
    GITHUB_RUN_ATTEMPT: text(github.run_attempt),
    GITHUB_SERVER_URL: text(github.server_url),
    GITHUB_API_URL: text(github.api_url),
    GITHUB_WORKSPACE: options.workspace,
    GITHUB_EVENT_PATH: options.eventPath,
    RUNNER_OS: runnerOs(),
    RUNNER_TEMP: options.tempDir,
    RUNNER_TOOL_CACHE: options.toolCache
  };
  return env;
}

/** Prepend `$GITHUB_PATH` additions (most recent first) to a PATH value. */
export function prependPath(
  additions: string[],
  basePath: string | undefined
): string {
  return [...additions, ...(basePath ? [basePath] : [])].join(path.delimiter);
}

/**
 * Host variables that `run:` steps and actions on the host still get: what
 * tools need to work (PATH, HOME, locale, temp dirs, proxy and CA settings,
 * the container client's config, and Windows system variables). Everything
 * else in the user's shell (tokens, cloud credentials...) stays out; pass
 * what a workflow needs with `--env`.
 */
const HOST_ENV_ALLOWLIST =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|TMPDIR|TEMP|TMP|(HTTPS?|FTP|ALL|NO)_PROXY|SSL_CERT_(FILE|DIR)|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|DOCKER_(HOST|CONTEXT|CONFIG|CERT_PATH|TLS_VERIFY)|XDG_RUNTIME_DIR|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(\(X86\))?|COMMONPROGRAMFILES(\(X86\))?)$/i;

/** The allowlisted part of the host environment (see HOST_ENV_ALLOWLIST). */
export function hostBaseEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && HOST_ENV_ALLOWLIST.test(key)) base[key] = value;
  }
  return base;
}
