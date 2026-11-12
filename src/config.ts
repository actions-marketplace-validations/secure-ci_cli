import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import type { ContainerRuntimePreference } from './runner/container-runtime';
import type { WorkflowOverrides } from './types';
import {
  ConcurrencyMode,
  defaultParallelism,
  parseConcurrencyMode,
  parseParallel
} from './runner/scheduler';

/**
 * Global SecureCI configuration, stored as YAML at `~/.secureci/config.yml`.
 * Can be edited by hand or managed via `secureci config get|set|unset|list`.
 * Values here are used as defaults, overridden by explicit CLI flags.
 *
 * Keys match the CLI flag names (kebab-case, minus the leading `--`) so
 * `secureci config set container-runtime podman` mirrors `secureci
 * --container-runtime podman` directly.
 */
export interface CliConfig {
  'container-runtime'?: ContainerRuntimePreference;
  'container-image'?: string;
  'container-timeout'?: number;
  'container-memory'?: string;
  'allow-network'?: boolean;
  /** Jobs running at once (`--parallel`). Default: the CPU count. */
  parallel?: number;
  /** Each job in its own copy of the working copy (`--isolate-workspace`). */
  'isolate-workspace'?: boolean;
  /** How job `concurrency:` groups apply (`--concurrency`). */
  concurrency?: ConcurrencyMode;
  /**
   * Default files for `run --env-file` etc., used when the flag isn't given.
   * Relative paths resolve against the current directory. `config set`
   * stores one path; a YAML list in the file is read in order.
   */
  'env-file'?: string | string[];
  'secret-file'?: string | string[];
  'input-file'?: string | string[];
  'var-file'?: string | string[];
  /** `runs-on` label -> container image, over the built-in mapping. */
  'runner-images'?: Record<string, string>;
}

export type { WorkflowOverride, WorkflowOverrides } from './types';

export const WORKFLOW_OVERRIDE_KEYS = [
  'runs-on',
  'container-image',
  'service-images'
] as const;

/**
 * A named set of settings selected with `run --profile <name>` (or
 * `SECURECI_PROFILE`): any config key, plus env vars and vars for every
 * step and rewrites of the workflow.
 */
export interface Profile extends CliConfig {
  /** Env vars for every step, below --env-file and --env. */
  env?: Record<string, string>;
  /** Values for the vars context, below --var-file and --var. */
  vars?: Record<string, string>;
  workflow?: WorkflowOverrides;
}

/**
 * The shape of `~/.secureci/config.yml` and of a repository's
 * `secureci.yml` (or the `secureci` key of its package.json).
 */
export interface SecureciConfig extends CliConfig {
  profiles?: Record<string, Profile>;
}

/** Built-in defaults, used when a key is absent from the config file. */
export const DEFAULT_CONFIG: Required<Pick<CliConfig, 'container-runtime'>> &
  CliConfig = {
  'container-runtime': 'docker'
};

const CONTAINER_RUNTIME_VALUES: ContainerRuntimePreference[] = [
  'auto',
  'docker',
  'podman',
  'containerd',
  'host'
];

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

function getConfigDir(): string {
  return path.join(getHomeDir(), '.secureci');
}

export function getConfigFilePath(): string {
  return path.join(getConfigDir(), 'config.yml');
}

/** Load the global config file, returning `{}` if absent or unreadable. */
export function loadConfig(): SecureciConfig {
  const configFile = getConfigFilePath();
  if (!fs.existsSync(configFile)) return {};

  try {
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as SecureciConfig)
      : {};
  } catch {
    return {};
  }
}

/** Persist the given config object to the global config file. */
export function saveConfig(config: SecureciConfig): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(getConfigFilePath(), YAML.stringify(config));
}

/** Resolve the effective value for `container-runtime`: config, else built-in default. */
export function getDefaultContainerRuntime(
  config: CliConfig = loadConfig()
): ContainerRuntimePreference {
  const value = config['container-runtime'];
  if (value === undefined) return DEFAULT_CONFIG['container-runtime'];
  if (!CONTAINER_RUNTIME_VALUES.includes(value)) {
    const hint =
      String(value) === 'none' ? ' ("none" was renamed to "host")' : '';
    throw new Error(
      `Invalid container-runtime "${value}" in ${getConfigFilePath()}${hint}. Must be one of: ${CONTAINER_RUNTIME_VALUES.join(', ')}`
    );
  }
  return value;
}

/** Resolve the effective `parallel`: config, else the CPU count. */
export function getDefaultParallel(config: CliConfig = loadConfig()): number {
  const value = config.parallel;
  return value === undefined ? defaultParallelism() : parseParallel(value);
}

export const CONFIG_KEYS = [
  'container-runtime',
  'container-image',
  'container-timeout',
  'container-memory',
  'allow-network',
  'parallel',
  'isolate-workspace',
  'concurrency',
  'env-file',
  'secret-file',
  'input-file',
  'var-file'
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** How a dotted config key maps onto the config object. */
interface KeyPath {
  path: string[];
  /** Parse and validate the raw string from `config set`. */
  parse: (rawValue: string) => unknown;
}

const PROFILE_KEY = /^profiles\.([^.]+)\.(.+)$/;

function nonEmpty(key: string): (rawValue: string) => string {
  return (rawValue) => {
    if (rawValue === '') {
      throw new Error(`Invalid value "" for ${key}: must not be empty.`);
    }
    return rawValue;
  };
}

/** Keys valid both at the top level and inside a profile. */
function settingsKeyPath(key: string, fullKey: string): KeyPath | undefined {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) {
    return {
      path: [key],
      parse: (raw) => parseConfigValue(key as ConfigKey, raw)
    };
  }
  const label = key.match(/^runner-images\.(.+)$/)?.[1];
  if (label !== undefined) {
    return { path: ['runner-images', label], parse: nonEmpty(fullKey) };
  }
  return undefined;
}

/** Keys inside `profiles.<name>`. */
function profileKeyPath(key: string, fullKey: string): KeyPath | undefined {
  const settings = settingsKeyPath(key, fullKey);
  if (settings) return settings;
  const named = key.match(/^(env|vars)\.(.+)$/);
  if (named) return { path: [named[1], named[2]], parse: (raw) => raw };
  for (const field of WORKFLOW_OVERRIDE_KEYS) {
    const prefix = `workflow.${field}`;
    if (key === prefix) {
      return { path: ['workflow', field], parse: nonEmpty(fullKey) };
    }
    if (key.startsWith(`${prefix}.`) && key.length > prefix.length + 1) {
      return {
        path: ['workflow', field, key.slice(prefix.length + 1)],
        parse: nonEmpty(fullKey)
      };
    }
  }
  return undefined;
}

/**
 * The path of a dotted config key: a plain key, `runner-images.<label>`,
 * or `profiles.<name>.<key>`, where `<key>` is one of those, `env.<NAME>`,
 * `vars.<NAME>`, `workflow.<field>` or `workflow.<field>.<original>`.
 */
function configKeyPath(key: string): KeyPath | undefined {
  const profile = key.match(PROFILE_KEY);
  if (profile) {
    const inner = profileKeyPath(profile[2], key);
    return inner && { ...inner, path: ['profiles', profile[1], ...inner.path] };
  }
  return settingsKeyPath(key, key);
}

/** Every key form `config get|set|unset` accepts, for error messages. */
export const CONFIG_KEY_FORMS = [
  ...CONFIG_KEYS,
  'runner-images.<label>',
  'profiles.<name>.<key>',
  'profiles.<name>.env.<NAME>',
  'profiles.<name>.vars.<NAME>',
  `profiles.<name>.workflow.(${WORKFLOW_OVERRIDE_KEYS.join('|')})[.<original>]`
];

export function isValidConfigKey(key: string): boolean {
  return configKeyPath(key) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a key (see isValidConfigKey) from a config object. */
export function getConfigValue(config: SecureciConfig, key: string): unknown {
  const keyPath = configKeyPath(key);
  if (!keyPath) return undefined;
  let node: unknown = config;
  for (const part of keyPath.path) {
    if (!isRecord(node)) return undefined;
    node = node[part];
  }
  return node;
}

/** Parse `rawValue` for `key` and set it on `config`. Throws if invalid. */
export function setConfigValue(
  config: SecureciConfig,
  key: string,
  rawValue: string
): unknown {
  const keyPath = configKeyPath(key);
  if (!keyPath) throw new Error(`Unknown config key "${key}".`);
  const value = keyPath.parse(rawValue);
  let node = config as Record<string, unknown>;
  const parents = keyPath.path.slice(0, -1);
  parents.forEach((part, index) => {
    const next = node[part];
    if (next === undefined) {
      node[part] = {};
    } else if (!isRecord(next)) {
      const at = keyPath.path.slice(0, index + 1).join('.');
      throw new Error(
        `${at} is a single value, not a mapping: unset it first, or set ${at} itself.`
      );
    }
    node = node[part] as Record<string, unknown>;
  });
  node[keyPath.path[keyPath.path.length - 1]] = value;
  return value;
}

/** Remove `key` from `config`, dropping mappings it leaves empty. */
export function unsetConfigValue(config: SecureciConfig, key: string): void {
  const keyPath = configKeyPath(key);
  if (!keyPath) return;
  const chain: Array<Record<string, unknown>> = [
    config as Record<string, unknown>
  ];
  for (const part of keyPath.path.slice(0, -1)) {
    const next = chain[chain.length - 1][part];
    if (!isRecord(next)) return;
    chain.push(next);
  }
  delete chain[chain.length - 1][keyPath.path[keyPath.path.length - 1]];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length > 0) break;
    delete chain[i - 1][keyPath.path[i - 1]];
  }
}

/**
 * Every value under `profiles:` as `[dotted key, value]`, for `config list`.
 * Lists show as `a, b`; a profile with no values as `(empty)`.
 */
export function profileEntries(
  config: SecureciConfig
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const walk = (prefix: string, value: unknown): void => {
    if (isRecord(value)) {
      for (const [key, inner] of Object.entries(value)) {
        walk(`${prefix}.${key}`, inner);
      }
    } else {
      entries.push([
        prefix,
        Array.isArray(value) ? value.join(', ') : String(value)
      ]);
    }
  };
  for (const [name, profile] of Object.entries(config.profiles ?? {})) {
    if (!isRecord(profile) || Object.keys(profile).length === 0) {
      entries.push([`profiles.${name}`, '(empty)']);
    } else {
      walk(`profiles.${name}`, profile);
    }
  }
  return entries;
}

/**
 * Set (or, with `rawValue` undefined, unset) one key in a config file,
 * keeping its comments and layout. Creates the file if needed. Returns the
 * parsed value set.
 */
export function updateConfigFile(
  file: string,
  key: string,
  rawValue: string | undefined
): unknown {
  const keyPath = configKeyPath(key);
  if (!keyPath) throw new Error(`Unknown config key "${key}".`);
  const doc = YAML.parseDocument(
    fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  );
  if (doc.errors.length > 0) {
    throw new Error(`Invalid YAML in ${file}: ${doc.errors[0].message}`);
  }
  const current = doc.toJS() as unknown;
  const config: SecureciConfig = isRecord(current) ? current : {};
  let value: unknown;
  if (rawValue === undefined) {
    doc.deleteIn(keyPath.path);
    for (let i = keyPath.path.length - 1; i > 0; i--) {
      const parent = doc.getIn(keyPath.path.slice(0, i));
      if (!YAML.isMap(parent) || parent.items.length > 0) break;
      doc.deleteIn(keyPath.path.slice(0, i));
    }
  } else {
    // Validates the value and refuses an entry under a single value.
    value = setConfigValue(config, key, rawValue);
    doc.setIn(keyPath.path, value);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contents = doc.contents;
  // With nothing left, keep only the file's leading comments (YAML would
  // write `{}`).
  const emptied =
    contents === null || (YAML.isMap(contents) && contents.items.length === 0);
  const comments = (doc.commentBefore ?? '')
    .split('\n')
    .map((line) => `#${line}\n`)
    .join('');
  fs.writeFileSync(
    file,
    emptied ? (doc.commentBefore ? comments : '') : doc.toString()
  );
  return value;
}

/**
 * Parse and validate a raw CLI string value for the given config key,
 * returning the typed value to store. Throws on invalid input.
 */
export function parseConfigValue(
  key: ConfigKey,
  rawValue: string
): CliConfig[ConfigKey] {
  switch (key) {
    case 'container-runtime':
      if (
        !CONTAINER_RUNTIME_VALUES.includes(
          rawValue as ContainerRuntimePreference
        )
      ) {
        throw new Error(
          `Invalid value "${rawValue}" for container-runtime. Must be one of: ${CONTAINER_RUNTIME_VALUES.join(', ')}`
        );
      }
      return rawValue as ContainerRuntimePreference;
    case 'container-timeout': {
      const num = Number(rawValue);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error(
          `Invalid value "${rawValue}" for container-timeout. Must be a non-negative number.`
        );
      }
      return num;
    }
    case 'allow-network':
    case 'isolate-workspace':
      if (rawValue !== 'true' && rawValue !== 'false') {
        throw new Error(
          `Invalid value "${rawValue}" for ${key}. Must be "true" or "false".`
        );
      }
      return rawValue === 'true';
    case 'parallel':
      return parseParallel(rawValue);
    case 'concurrency':
      return parseConcurrencyMode(rawValue);
    case 'container-image':
    case 'container-memory':
      return rawValue;
    case 'env-file':
    case 'secret-file':
    case 'input-file':
    case 'var-file':
      if (rawValue === '') {
        throw new Error(`Invalid value "" for ${key}. Must be a file path.`);
      }
      return rawValue;
  }
}

/**
 * Whether each job runs in its own copy of the working copy:
 * `--isolate-workspace` / `--no-isolate-workspace`, else
 * `isolate-workspace` in the config file, else no.
 */
export function resolveIsolateWorkspace(
  flag: boolean | undefined,
  config: CliConfig = loadConfig()
): boolean {
  return flag ?? config['isolate-workspace'] === true;
}

/**
 * How job `concurrency:` groups apply: `--concurrency`, else
 * `concurrency` in the config file, else serialize.
 */
export function resolveConcurrency(
  flag: string | undefined,
  config: CliConfig = loadConfig()
): ConcurrencyMode {
  const value = flag ?? config.concurrency;
  return value === undefined ? 'serialize' : parseConcurrencyMode(value);
}

/**
 * Whether container networking should be disabled. Networking is on by
 * default (matching GitHub-hosted runners); `--no-network` turns it off and
 * wins over everything, then `--allow-network`, then `allow-network` in the
 * config file.
 */
export function resolveNetworkDisabled(
  flags: { network?: boolean; allowNetwork?: boolean },
  config: CliConfig = loadConfig()
): boolean {
  if (flags.network === false) return true;
  if (flags.allowNetwork === true) return false;
  return config['allow-network'] === false;
}
