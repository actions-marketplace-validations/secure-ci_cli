import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import type { ContainerRuntimePreference } from './runner/container-runtime';
import { defaultParallelism, parseParallel } from './runner/scheduler';

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
export function loadConfig(): CliConfig {
  const configFile = getConfigFilePath();
  if (!fs.existsSync(configFile)) return {};

  try {
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as CliConfig) : {};
  } catch {
    return {};
  }
}

/** Persist the given config object to the global config file. */
export function saveConfig(config: CliConfig): void {
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
  'env-file',
  'secret-file',
  'input-file',
  'var-file'
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** `runner-images.<label>`: one entry of the runs-on -> image mapping. */
const RUNNER_IMAGE_KEY = /^runner-images\.(.+)$/;

/** A plain key, or `runner-images.<label>`. */
export function isValidConfigKey(key: string): boolean {
  return (
    (CONFIG_KEYS as readonly string[]).includes(key) ||
    RUNNER_IMAGE_KEY.test(key)
  );
}

/** Read a key (see isValidConfigKey) from a config object. */
export function getConfigValue(
  config: CliConfig,
  key: string
): CliConfig[ConfigKey] | undefined {
  const label = key.match(RUNNER_IMAGE_KEY)?.[1];
  if (label !== undefined) return config['runner-images']?.[label];
  return config[key as ConfigKey];
}

/** Parse `rawValue` for `key` and set it on `config`. Throws if invalid. */
export function setConfigValue(
  config: CliConfig,
  key: string,
  rawValue: string
): CliConfig[ConfigKey] {
  const label = key.match(RUNNER_IMAGE_KEY)?.[1];
  if (label !== undefined) {
    config['runner-images'] = { ...config['runner-images'], [label]: rawValue };
    return rawValue;
  }
  const value = parseConfigValue(key as ConfigKey, rawValue);
  (config as Record<string, unknown>)[key] = value;
  return value;
}

/** Remove `key` from `config`, dropping an emptied runner-images map. */
export function unsetConfigValue(config: CliConfig, key: string): void {
  const label = key.match(RUNNER_IMAGE_KEY)?.[1];
  if (label === undefined) {
    delete config[key as ConfigKey];
    return;
  }
  const images = { ...config['runner-images'] };
  delete images[label];
  if (Object.keys(images).length > 0) config['runner-images'] = images;
  else delete config['runner-images'];
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
      if (rawValue !== 'true' && rawValue !== 'false') {
        throw new Error(
          `Invalid value "${rawValue}" for allow-network. Must be "true" or "false".`
        );
      }
      return rawValue === 'true';
    case 'parallel':
      return parseParallel(rawValue);
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
