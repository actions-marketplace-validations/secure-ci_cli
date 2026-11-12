import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  CONFIG_KEYS,
  ConfigKey,
  CliConfig,
  getConfigFilePath,
  parseConfigValue,
  Profile,
  SecureciConfig,
  WORKFLOW_OVERRIDE_KEYS,
  WorkflowOverride,
  WorkflowOverrides
} from './config';

/** A repository's SecureCI config, at its root (next to package.json). */
export const REPO_CONFIG_FILE = 'secureci.yml';

/** The `package.json` key that can hold the same config instead. */
const PACKAGE_JSON_KEY = 'secureci';

const FILE_KEYS = ['env-file', 'secret-file', 'input-file', 'var-file'];

/**
 * Keys a repository's config can't set, because a cloned repository would
 * control them: running steps on the host, reading files from this machine
 * into steps, or turning container networking on.
 */
const REPO_BLOCKED_KEYS = ['container-runtime', ...FILE_KEYS];

export interface RepoConfig {
  config: SecureciConfig;
  /** Where it was read from, for messages. */
  source: string;
}

/** The effective settings of a `run`, before CLI flags. */
export interface ResolvedRunConfig {
  config: CliConfig;
  /** The profile's env vars for every step (lowest precedence). */
  env: Record<string, string>;
  /** The profile's vars (lowest precedence). */
  vars: Record<string, string>;
  workflow: WorkflowOverrides;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The repository root: the nearest directory at or above `start` that holds
 * `.git` (a directory, or a file for worktrees and submodules), else `start`.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

function join(where: string, key: string): string {
  return where ? `${where}.${key}` : key;
}

function checkStringMap(value: unknown, where: string, scalars = false): void {
  if (!isRecord(value)) throw new Error(`${where}: must be a mapping`);
  for (const [key, entry] of Object.entries(value)) {
    const ok = scalars
      ? ['string', 'number', 'boolean'].includes(typeof entry)
      : typeof entry === 'string' && entry !== '';
    if (!ok) {
      throw new Error(
        `${join(where, key)}: must be ${scalars ? 'a string, number or boolean' : 'a non-empty string'}`
      );
    }
  }
}

function checkConfigValue(key: ConfigKey, value: unknown, where: string): void {
  if (FILE_KEYS.includes(key)) {
    const files = Array.isArray(value) ? value : [value];
    if (files.length === 0 || files.some((f) => typeof f !== 'string' || !f)) {
      throw new Error(`${where}: must be a file path or a list of them`);
    }
    return;
  }
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new Error(`${where}: must be a single value`);
  }
  try {
    parseConfigValue(key, String(value));
  } catch (error) {
    throw new Error(
      `${where}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function checkWorkflow(value: unknown, where: string): void {
  if (!isRecord(value)) throw new Error(`${where}: must be a mapping`);
  for (const [key, override] of Object.entries(value)) {
    if (!(WORKFLOW_OVERRIDE_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${where}: unknown key "${key}" (expected ${WORKFLOW_OVERRIDE_KEYS.join(', ')})`
      );
    }
    if (typeof override === 'string' && override !== '') continue;
    if (isRecord(override)) {
      checkStringMap(override, join(where, key));
      continue;
    }
    throw new Error(
      `${join(where, key)}: must be a string or a mapping of original -> replacement`
    );
  }
}

/**
 * Check one level of config (the top level, or a profile at `where`),
 * throwing on unknown keys, invalid values and, for a repository's config,
 * keys it can't set.
 */
function checkSettings(
  settings: Record<string, unknown>,
  where: string,
  repo: boolean
): void {
  const inProfile = where !== '';
  for (const [key, value] of Object.entries(settings)) {
    const at = join(where, key);
    if (repo && value !== undefined) {
      const blocked =
        REPO_BLOCKED_KEYS.includes(key) ||
        (key === 'allow-network' && value === true);
      if (blocked) {
        throw new Error(
          `${at}: can't be set in a repository's config, since a cloned repository would control it; set it in ${getConfigFilePath()} or pass the flag`
        );
      }
    }
    if ((CONFIG_KEYS as readonly string[]).includes(key)) {
      checkConfigValue(key as ConfigKey, value, at);
    } else if (key === 'runner-images') {
      checkStringMap(value, at);
    } else if (!inProfile && key === 'profiles') {
      if (!isRecord(value)) throw new Error(`${at}: must be a mapping`);
      for (const [name, profile] of Object.entries(value)) {
        checkProfile(profile, join(at, name), repo);
      }
    } else if (inProfile && (key === 'env' || key === 'vars')) {
      checkStringMap(value, at, true);
    } else if (inProfile && key === 'workflow') {
      checkWorkflow(value, at);
    } else {
      const hint = (WORKFLOW_OVERRIDE_KEYS as readonly string[]).includes(key)
        ? ` (did you mean ${join(where, `workflow.${key}`)}?)`
        : '';
      throw new Error(`${where || 'config'}: unknown key "${key}"${hint}`);
    }
  }
}

function checkProfile(profile: unknown, where: string, repo: boolean): void {
  // An empty profile (`dev:`) is allowed: it selects no overrides.
  if (profile === null || profile === undefined) return;
  if (!isRecord(profile)) throw new Error(`${where}: must be a mapping`);
  checkSettings(profile, where, repo);
}

function withSource<T>(source: string, fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new Error(
      `${source}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

function readPackageJsonConfig(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    const pkg: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isRecord(pkg) ? pkg[PACKAGE_JSON_KEY] : undefined;
  } catch {
    // Not ours to report: npm will.
    return undefined;
  }
}

/**
 * Load a repository's config from `<root>/secureci.yml`, or else the
 * `secureci` key of `<root>/package.json`. Returns undefined when there is
 * neither; throws when there are both, or when it is invalid (unknown keys,
 * bad values, or keys a repository can't set).
 */
export function loadRepoConfig(root: string): RepoConfig | undefined {
  const ymlFile = path.join(root, REPO_CONFIG_FILE);
  const pkgFile = path.join(root, 'package.json');
  const fromPackage = readPackageJsonConfig(pkgFile);
  const hasYml = fs.existsSync(ymlFile);

  if (hasYml && fromPackage !== undefined) {
    throw new Error(
      `${root}: both ${REPO_CONFIG_FILE} and a "${PACKAGE_JSON_KEY}" key in package.json set SecureCI config; keep one`
    );
  }

  let source: string;
  let raw: unknown;
  if (hasYml) {
    source = ymlFile;
    const doc = YAML.parseDocument(fs.readFileSync(ymlFile, 'utf-8'));
    if (doc.errors.length > 0) {
      throw new Error(`${source}: invalid YAML: ${doc.errors[0].message}`);
    }
    raw = doc.toJS() ?? {};
  } else if (fromPackage !== undefined) {
    source = `${pkgFile} (${PACKAGE_JSON_KEY})`;
    raw = fromPackage;
  } else {
    return undefined;
  }

  if (!isRecord(raw)) throw new Error(`${source}: must be a mapping`);
  withSource(source, () =>
    checkSettings(raw as Record<string, unknown>, '', true)
  );
  return { config: raw as SecureciConfig, source };
}

function settingsOf(layer: SecureciConfig | Profile | undefined): CliConfig {
  if (!layer) return {};
  const settings: Record<string, unknown> = { ...layer };
  for (const key of ['profiles', 'env', 'vars', 'workflow']) {
    delete settings[key];
  }
  return settings as CliConfig;
}

function mergeSettings(layers: CliConfig[]): CliConfig {
  const merged: CliConfig = {};
  for (const layer of layers) {
    const { 'runner-images': images, ...rest } = layer;
    Object.assign(merged, rest);
    if (images) {
      merged['runner-images'] = { ...merged['runner-images'], ...images };
    }
  }
  return merged;
}

function stringValues(
  layers: Array<Record<string, unknown> | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer ?? {})) {
      merged[key] = String(value);
    }
  }
  return merged;
}

function mergeWorkflow(
  layers: Array<WorkflowOverrides | undefined>
): WorkflowOverrides {
  const merged: WorkflowOverrides = {};
  for (const layer of layers) {
    for (const key of WORKFLOW_OVERRIDE_KEYS) {
      const next: WorkflowOverride | undefined = layer?.[key];
      if (next === undefined) continue;
      const prev = merged[key];
      merged[key] =
        typeof next === 'object' && typeof prev === 'object'
          ? { ...prev, ...next }
          : next;
    }
  }
  return merged;
}

/**
 * The effective settings of a `run`: the active profile (the repository's
 * over the global one, per key) over the repository's top-level keys, over
 * the global config. CLI flags apply on top of this. Throws for a profile
 * defined nowhere, or an invalid global profile.
 */
export function resolveRunConfig(options: {
  global: SecureciConfig;
  repo?: RepoConfig;
  profile?: string;
}): ResolvedRunConfig {
  const { global, repo, profile } = options;
  let globalProfile: Profile | undefined;
  let repoProfile: Profile | undefined;

  if (profile !== undefined) {
    const globalProfiles = isRecord(global.profiles) ? global.profiles : {};
    const repoProfiles = repo?.config.profiles ?? {};
    const inGlobal = Object.prototype.hasOwnProperty.call(
      globalProfiles,
      profile
    );
    const inRepo = Object.prototype.hasOwnProperty.call(repoProfiles, profile);
    if (!inGlobal && !inRepo) {
      const names = [
        ...new Set([
          ...Object.keys(globalProfiles),
          ...Object.keys(repoProfiles)
        ])
      ].sort();
      throw new Error(
        names.length > 0
          ? `Unknown profile "${profile}". Defined profiles: ${names.join(', ')}`
          : `Unknown profile "${profile}": no profiles are defined (add one under profiles: in ${REPO_CONFIG_FILE} or ${getConfigFilePath()})`
      );
    }
    if (inGlobal) {
      withSource(getConfigFilePath(), () =>
        checkProfile(globalProfiles[profile], `profiles.${profile}`, false)
      );
      globalProfile = globalProfiles[profile] ?? {};
    }
    if (inRepo) repoProfile = repoProfiles[profile] ?? {};
  }

  return {
    config: mergeSettings([
      settingsOf(global),
      settingsOf(repo?.config),
      settingsOf(globalProfile),
      settingsOf(repoProfile)
    ]),
    env: stringValues([globalProfile?.env, repoProfile?.env]),
    vars: stringValues([globalProfile?.vars, repoProfile?.vars]),
    workflow: mergeWorkflow([globalProfile?.workflow, repoProfile?.workflow])
  };
}
