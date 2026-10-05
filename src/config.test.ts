import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('config', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-config-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('getConfigFilePath points at ~/.ghact/config.yml', async () => {
    const { getConfigFilePath } = await import('./config');
    expect(getConfigFilePath()).toBe(
      path.join(tempHome, '.ghact', 'config.yml')
    );
  });

  it('loadConfig falls back to the legacy ~/.actly/config.yml', async () => {
    const { loadConfig } = await import('./config');
    const legacyDir = path.join(tempHome, '.actly');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'config.yml'),
      'container-runtime: podman\n'
    );

    expect(loadConfig()).toEqual({ 'container-runtime': 'podman' });
  });

  it('loadConfig prefers ~/.ghact/config.yml over the legacy file', async () => {
    const { loadConfig, getConfigFilePath } = await import('./config');
    const legacyDir = path.join(tempHome, '.actly');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'config.yml'),
      'container-runtime: podman\n'
    );
    fs.mkdirSync(path.dirname(getConfigFilePath()), { recursive: true });
    fs.writeFileSync(getConfigFilePath(), 'container-runtime: none\n');

    expect(loadConfig()).toEqual({ 'container-runtime': 'none' });
  });

  it('saveConfig writes to ~/.ghact even when only a legacy file exists', async () => {
    const { saveConfig, getConfigFilePath } = await import('./config');
    const legacyFile = path.join(tempHome, '.actly', 'config.yml');
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, 'container-runtime: podman\n');

    saveConfig({ 'container-runtime': 'auto' });

    expect(fs.readFileSync(getConfigFilePath(), 'utf-8')).toContain('auto');
    expect(fs.readFileSync(legacyFile, 'utf-8')).toContain('podman');
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

    it('passes container-image and container-memory through as strings', async () => {
      const { parseConfigValue } = await import('./config');
      expect(parseConfigValue('container-image', 'node:20-alpine')).toBe(
        'node:20-alpine'
      );
      expect(parseConfigValue('container-memory', '512m')).toBe('512m');
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
});
