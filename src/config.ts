import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import type { ContainerRuntimePreference } from './runner/container-runtime';

/**
 * Global ghact configuration, stored as YAML at `~/.ghact/config.yml`.
 * Can be edited by hand or managed via `ghact config get|set|unset|list`.
 * Values here are used as defaults, overridden by explicit CLI flags.
 *
 * Keys match the CLI flag names (kebab-case, minus the leading `--`) so
 * `ghact config set container-runtime podman` mirrors `ghact
 * --container-runtime podman` directly.
 */
export interface GhactConfig {
  'container-runtime'?: ContainerRuntimePreference;
  'container-image'?: string;
  'container-timeout'?: number;
  'container-memory'?: string;
  'allow-network'?: boolean;
}

/** Built-in defaults, used when a key is absent from the config file. */
export const DEFAULT_CONFIG: Required<Pick<GhactConfig, 'container-runtime'>> &
  GhactConfig = {
  'container-runtime': 'docker'
};

const CONTAINER_RUNTIME_VALUES: ContainerRuntimePreference[] = [
  'auto',
  'docker',
  'podman',
  'containerd',
  'none'
];

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '/tmp';
}

function getConfigDir(): string {
  return path.join(getHomeDir(), '.ghact');
}

export function getConfigFilePath(): string {
  return path.join(getConfigDir(), 'config.yml');
}

/** Config location used before the project was renamed from actly. */
function getLegacyConfigFilePath(): string {
  return path.join(getHomeDir(), '.actly', 'config.yml');
}

/**
 * Load the global config file, returning `{}` if absent or unreadable.
 * Falls back to the legacy `~/.actly/config.yml` when `~/.ghact/config.yml`
 * doesn't exist; the next `saveConfig` then writes to the new location.
 */
export function loadConfig(): GhactConfig {
  let configFile = getConfigFilePath();
  if (!fs.existsSync(configFile)) {
    configFile = getLegacyConfigFilePath();
    if (!fs.existsSync(configFile)) return {};
  }

  try {
    const raw = fs.readFileSync(configFile, 'utf-8');
    const parsed: unknown = YAML.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as GhactConfig) : {};
  } catch {
    return {};
  }
}

/** Persist the given config object to the global config file. */
export function saveConfig(config: GhactConfig): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(getConfigFilePath(), YAML.stringify(config));
}

/** Resolve the effective value for `container-runtime`: config, else built-in default. */
export function getDefaultContainerRuntime(
  config: GhactConfig = loadConfig()
): ContainerRuntimePreference {
  return config['container-runtime'] ?? DEFAULT_CONFIG['container-runtime'];
}

export const CONFIG_KEYS = [
  'container-runtime',
  'container-image',
  'container-timeout',
  'container-memory',
  'allow-network'
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isValidConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

/**
 * Parse and validate a raw CLI string value for the given config key,
 * returning the typed value to store. Throws on invalid input.
 */
export function parseConfigValue(
  key: ConfigKey,
  rawValue: string
): GhactConfig[ConfigKey] {
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
    case 'container-image':
    case 'container-memory':
      return rawValue;
  }
}
