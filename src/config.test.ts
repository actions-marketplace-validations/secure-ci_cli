import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('config', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-config-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('getConfigFilePath points at ~/.secureci/config.yml', async () => {
    const { getConfigFilePath } = await import('./config');
    expect(getConfigFilePath()).toBe(
      path.join(tempHome, '.secureci', 'config.yml')
    );
  });

  it('loadConfig returns {} when the config file does not exist', async () => {
    const { loadConfig } = await import('./config');
    expect(loadConfig()).toEqual({});
  });

  it('loadConfig returns {} when the config file has invalid YAML', async () => {
    const { loadConfig, getConfigFilePath } = await import('./config');
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    fs.writeFileSync(getConfigFilePath(), '{ not: valid: yaml');

    expect(loadConfig()).toEqual({});
  });

  it('saveConfig persists values as kebab-case YAML, and loadConfig reads them back', async () => {
    const { saveConfig, loadConfig, getConfigFilePath } =
      await import('./config');

    saveConfig({ 'container-runtime': 'podman', 'allow-network': true });

    const raw = fs.readFileSync(getConfigFilePath(), 'utf-8');
    expect(raw).toContain('container-runtime: podman');
    expect(raw).toContain('allow-network: true');

    expect(loadConfig()).toEqual({
      'container-runtime': 'podman',
      'allow-network': true
    });
  });

  it('getDefaultContainerRuntime falls back to the built-in default ("docker") when unset', async () => {
    const { getDefaultContainerRuntime } = await import('./config');
    expect(getDefaultContainerRuntime({})).toBe('docker');
  });

  it('getDefaultContainerRuntime prefers the config value when set', async () => {
    const { getDefaultContainerRuntime } = await import('./config');
    expect(
      getDefaultContainerRuntime({ 'container-runtime': 'containerd' })
    ).toBe('containerd');
  });

  it('getDefaultContainerRuntime rejects an invalid value, with a hint for the old "none"', async () => {
    const { getDefaultContainerRuntime } = await import('./config');
    const legacy = { 'container-runtime': 'none' } as unknown as Parameters<
      typeof getDefaultContainerRuntime
    >[0];
    expect(() => getDefaultContainerRuntime(legacy)).toThrow(
      /"none" .*renamed to "host"/
    );
    const bogus = { 'container-runtime': 'lxc' } as unknown as Parameters<
      typeof getDefaultContainerRuntime
    >[0];
    expect(() => getDefaultContainerRuntime(bogus)).toThrow(
      'Invalid container-runtime "lxc"'
    );
  });

  it('isValidConfigKey accepts kebab-case keys and rejects unknown/camelCase ones', async () => {
    const { isValidConfigKey } = await import('./config');
    expect(isValidConfigKey('container-runtime')).toBe(true);
    expect(isValidConfigKey('allow-network')).toBe(true);
    expect(isValidConfigKey('containerRuntime')).toBe(false);
    expect(isValidConfigKey('bogus')).toBe(false);
  });

  describe('parseConfigValue', () => {
    it('validates container-runtime against the known engine list', async () => {
      const { parseConfigValue } = await import('./config');
      expect(parseConfigValue('container-runtime', 'containerd')).toBe(
        'containerd'
      );
      expect(() => parseConfigValue('container-runtime', 'bogus')).toThrow(
        /Invalid value "bogus" for container-runtime/
      );
    });

    it('parses container-timeout as a non-negative number', async () => {
      const { parseConfigValue } = await import('./config');
      expect(parseConfigValue('container-timeout', '5000')).toBe(5000);
      expect(() => parseConfigValue('container-timeout', '-1')).toThrow(
        /container-timeout/
      );
      expect(() => parseConfigValue('container-timeout', 'abc')).toThrow(
        /container-timeout/
      );
    });

    it('parses allow-network as a strict boolean', async () => {
      const { parseConfigValue } = await import('./config');
      expect(parseConfigValue('allow-network', 'true')).toBe(true);
      expect(parseConfigValue('allow-network', 'false')).toBe(false);
      expect(() => parseConfigValue('allow-network', 'yes')).toThrow(
        /allow-network/
      );
    });

    it('parses parallel as a positive integer', async () => {
      const { parseConfigValue } = await import('./config');
      expect(parseConfigValue('parallel', '4')).toBe(4);
      for (const bad of ['0', '-2', '1.5', 'many']) {
        expect(() => parseConfigValue('parallel', bad)).toThrow(
          /Invalid value "[^"]*" for parallel/
        );
      }
    });

    it('passes container-image and container-memory through as strings', async () => {
      const { parseConfigValue } = await import('./config');
      expect(parseConfigValue('container-image', 'node:20-alpine')).toBe(
        'node:20-alpine'
      );
      expect(parseConfigValue('container-memory', '512m')).toBe('512m');
    });

    it('accepts env-file, secret-file, input-file and var-file paths', async () => {
      const { parseConfigValue, isValidConfigKey } = await import('./config');
      for (const key of [
        'env-file',
        'secret-file',
        'input-file',
        'var-file'
      ] as const) {
        expect(isValidConfigKey(key)).toBe(true);
        expect(parseConfigValue(key, '.env')).toBe('.env');
        expect(() => parseConfigValue(key, '')).toThrow(
          new RegExp(`${key}. Must be a file path`)
        );
      }
    });
  });

  describe('getDefaultParallel', () => {
    it('is the CPU count when unset', async () => {
      const { getDefaultParallel } = await import('./config');
      const { defaultParallelism } = await import('./runner/scheduler');
      expect(getDefaultParallel({})).toBe(defaultParallelism());
    });

    it('prefers the config value, and rejects an invalid one', async () => {
      const { getDefaultParallel } = await import('./config');
      expect(getDefaultParallel({ parallel: 3 })).toBe(3);
      expect(() => getDefaultParallel({ parallel: 0 })).toThrow(
        /Invalid value "0" for parallel/
      );
    });
  });

  describe('resolveNetworkDisabled', () => {
    it('leaves networking on by default', async () => {
      const { resolveNetworkDisabled } = await import('./config');
      expect(resolveNetworkDisabled({}, {})).toBe(false);
    });

    it('turns networking off with --no-network, even over --allow-network', async () => {
      const { resolveNetworkDisabled } = await import('./config');
      expect(resolveNetworkDisabled({ network: false }, {})).toBe(true);
      expect(
        resolveNetworkDisabled({ network: false, allowNetwork: true }, {})
      ).toBe(true);
    });

    it('honours allow-network: false from the config file', async () => {
      const { resolveNetworkDisabled } = await import('./config');
      expect(resolveNetworkDisabled({}, { 'allow-network': false })).toBe(true);
      expect(resolveNetworkDisabled({}, { 'allow-network': true })).toBe(false);
    });

    it('lets --allow-network override allow-network: false in config', async () => {
      const { resolveNetworkDisabled } = await import('./config');
      expect(
        resolveNetworkDisabled(
          { allowNetwork: true },
          { 'allow-network': false }
        )
      ).toBe(false);
    });
  });

  describe('runner-images', () => {
    it('accepts runner-images.<label> keys', async () => {
      const { isValidConfigKey } = await import('./config');
      expect(isValidConfigKey('runner-images.ubuntu-latest')).toBe(true);
      expect(isValidConfigKey('runner-images.')).toBe(false);
      expect(isValidConfigKey('runner-images')).toBe(false);
    });

    it('sets, gets and unsets one label without touching the others', async () => {
      const {
        loadConfig,
        saveConfig,
        setConfigValue,
        getConfigValue,
        unsetConfigValue
      } = await import('./config');
      saveConfig({ 'runner-images': { 'my-runner': 'alpine:3' } });

      const config = loadConfig();
      setConfigValue(config, 'runner-images.ubuntu-latest', 'node:22');
      saveConfig(config);
      expect(loadConfig()['runner-images']).toEqual({
        'my-runner': 'alpine:3',
        'ubuntu-latest': 'node:22'
      });
      expect(getConfigValue(loadConfig(), 'runner-images.ubuntu-latest')).toBe(
        'node:22'
      );

      const after = loadConfig();
      unsetConfigValue(after, 'runner-images.my-runner');
      unsetConfigValue(after, 'runner-images.ubuntu-latest');
      expect(after['runner-images']).toBeUndefined();
    });

    it('still handles plain keys', async () => {
      const { setConfigValue, getConfigValue, unsetConfigValue } =
        await import('./config');
      const config = {};
      setConfigValue(config, 'container-timeout', '500');
      expect(getConfigValue(config, 'container-timeout')).toBe(500);
      unsetConfigValue(config, 'container-timeout');
      expect(config).toEqual({});
    });
  });
});
