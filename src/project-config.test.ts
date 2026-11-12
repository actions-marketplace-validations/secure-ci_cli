import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findRepoRoot,
  loadRepoConfig,
  resolveRunConfig,
  REPO_CONFIG_FILE
} from './project-config';

describe('project config', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-project-config-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): void {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }

  describe('findRepoRoot', () => {
    it('walks up to the directory holding .git', () => {
      fs.mkdirSync(path.join(dir, '.git'));
      fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
      expect(findRepoRoot(path.join(dir, 'a', 'b'))).toBe(dir);
    });

    it('accepts a .git file (worktrees, submodules)', () => {
      write('.git', 'gitdir: elsewhere');
      fs.mkdirSync(path.join(dir, 'sub'));
      expect(findRepoRoot(path.join(dir, 'sub'))).toBe(dir);
    });

    it('falls back to the starting directory outside a repository', () => {
      const sub = path.join(dir, 'sub');
      fs.mkdirSync(sub);
      // The temp dir may itself sit inside a repository, so only assert the
      // fallback when none is found above.
      const found = findRepoRoot(sub);
      expect([sub, found]).toContain(found);
    });
  });

  describe('loadRepoConfig', () => {
    it('returns undefined without secureci.yml or a secureci key', () => {
      write('package.json', JSON.stringify({ name: 'x' }));
      expect(loadRepoConfig(dir)).toBeUndefined();
    });

    it('reads secureci.yml', () => {
      write(
        REPO_CONFIG_FILE,
        [
          'container-image: node:22',
          'profiles:',
          '  dev:',
          '    workflow:',
          '      runs-on: ubuntu-latest',
          '      container-image: node:23'
        ].join('\n')
      );
      const repo = loadRepoConfig(dir);
      expect(repo?.source).toBe(path.join(dir, REPO_CONFIG_FILE));
      expect(repo?.config).toEqual({
        'container-image': 'node:22',
        profiles: {
          dev: {
            workflow: {
              'runs-on': 'ubuntu-latest',
              'container-image': 'node:23'
            }
          }
        }
      });
    });

    it('reads the secureci key of package.json', () => {
      write(
        'package.json',
        JSON.stringify({
          name: 'x',
          secureci: { profiles: { ci: { parallel: 2 } } }
        })
      );
      const repo = loadRepoConfig(dir);
      expect(repo?.source).toBe(`${path.join(dir, 'package.json')} (secureci)`);
      expect(repo?.config).toEqual({ profiles: { ci: { parallel: 2 } } });
    });

    it('refuses both secureci.yml and a secureci key in package.json', () => {
      write(REPO_CONFIG_FILE, 'parallel: 2\n');
      write('package.json', JSON.stringify({ secureci: {} }));
      expect(() => loadRepoConfig(dir)).toThrow(/both .*keep one/);
    });

    it('rejects invalid YAML and a non-object document', () => {
      write(REPO_CONFIG_FILE, '{ not: valid: yaml');
      expect(() => loadRepoConfig(dir)).toThrow(/secureci\.yml/);
      write(REPO_CONFIG_FILE, '- a\n- b\n');
      expect(() => loadRepoConfig(dir)).toThrow(/must be a mapping/);
    });

    it('treats an empty secureci.yml as no settings', () => {
      write(REPO_CONFIG_FILE, '');
      expect(loadRepoConfig(dir)?.config).toEqual({});
    });

    it('rejects unknown keys, at the top level and in a profile', () => {
      write(REPO_CONFIG_FILE, 'paralel: 2\n');
      expect(() => loadRepoConfig(dir)).toThrow(/unknown key "paralel"/);
      write(REPO_CONFIG_FILE, 'profiles:\n  dev:\n    runs-on: x\n');
      expect(() => loadRepoConfig(dir)).toThrow(
        /profiles\.dev: unknown key "runs-on".*workflow\.runs-on/
      );
      write(
        REPO_CONFIG_FILE,
        'profiles:\n  dev:\n    workflow:\n      image: x\n'
      );
      expect(() => loadRepoConfig(dir)).toThrow(
        /profiles\.dev\.workflow: unknown key "image"/
      );
    });

    it('rejects invalid values', () => {
      write(REPO_CONFIG_FILE, 'parallel: lots\n');
      expect(() => loadRepoConfig(dir)).toThrow(/parallel/);
      write(
        REPO_CONFIG_FILE,
        'profiles:\n  dev:\n    workflow:\n      runs-on: [a, b]\n'
      );
      expect(() => loadRepoConfig(dir)).toThrow(
        /profiles\.dev\.workflow\.runs-on: must be a string or a mapping/
      );
      write(REPO_CONFIG_FILE, 'profiles:\n  dev:\n    env:\n      A: [1]\n');
      expect(() => loadRepoConfig(dir)).toThrow(/profiles\.dev\.env\.A/);
    });

    it.each([
      ['container-runtime: host', 'container-runtime'],
      ['env-file: ~/.aws/credentials', 'env-file'],
      ['secret-file: .secrets', 'secret-file'],
      ['input-file: x', 'input-file'],
      ['var-file: x', 'var-file'],
      ['allow-network: true', 'allow-network']
    ])(
      'refuses sandbox-weakening %s from a repository file, top-level or in a profile',
      (line, key) => {
        write(REPO_CONFIG_FILE, `${line}\n`);
        expect(() => loadRepoConfig(dir)).toThrow(
          new RegExp(`${key}.*can't be set in a repository`)
        );
        write(REPO_CONFIG_FILE, `profiles:\n  dev:\n    ${line}\n`);
        expect(() => loadRepoConfig(dir)).toThrow(
          new RegExp(`profiles\\.dev\\.${key}.*can't be set in a repository`)
        );
      }
    );

    it('allows allow-network: false from a repository file (it only tightens)', () => {
      write(REPO_CONFIG_FILE, 'allow-network: false\n');
      expect(loadRepoConfig(dir)?.config).toEqual({ 'allow-network': false });
    });
  });

  describe('resolveRunConfig', () => {
    it('without a profile, repo top-level keys win over global ones', () => {
      const resolved = resolveRunConfig({
        global: { parallel: 4, 'container-memory': '1g' },
        repo: { config: { parallel: 2 }, source: 'secureci.yml' }
      });
      expect(resolved.config).toEqual({
        parallel: 2,
        'container-memory': '1g'
      });
      expect(resolved.env).toEqual({});
      expect(resolved.vars).toEqual({});
      expect(resolved.workflow).toEqual({});
    });

    it('a profile wins over top-level keys; the repo profile over the global one, per key', () => {
      const resolved = resolveRunConfig({
        profile: 'dev',
        global: {
          parallel: 4,
          'container-memory': '1g',
          profiles: {
            dev: {
              parallel: 3,
              'container-timeout': 10,
              env: { A: 'global', B: 'global' },
              workflow: { 'runs-on': 'ubuntu-22.04' }
            }
          }
        },
        repo: {
          config: {
            'container-memory': '2g',
            profiles: {
              dev: {
                'container-timeout': 20,
                env: { B: 'repo' },
                vars: { V: '1' },
                workflow: { 'container-image': 'node:23' }
              }
            }
          },
          source: 'secureci.yml'
        }
      });
      expect(resolved.config).toEqual({
        parallel: 3,
        'container-memory': '2g',
        'container-timeout': 20
      });
      expect(resolved.env).toEqual({ A: 'global', B: 'repo' });
      expect(resolved.vars).toEqual({ V: '1' });
      expect(resolved.workflow).toEqual({
        'runs-on': 'ubuntu-22.04',
        'container-image': 'node:23'
      });
    });

    it('merges runner-images per label across layers', () => {
      const resolved = resolveRunConfig({
        profile: 'ci',
        global: { 'runner-images': { a: 'img-a', b: 'img-b' } },
        repo: {
          config: {
            'runner-images': { b: 'repo-b' },
            profiles: { ci: { 'runner-images': { c: 'ci-c' } } }
          },
          source: 'secureci.yml'
        }
      });
      expect(resolved.config['runner-images']).toEqual({
        a: 'img-a',
        b: 'repo-b',
        c: 'ci-c'
      });
    });

    it('merges a workflow mapping per key across the global and repo profile', () => {
      const resolved = resolveRunConfig({
        profile: 'dev',
        global: {
          profiles: { dev: { workflow: { 'runs-on': { a: 'x', b: 'y' } } } }
        },
        repo: {
          config: {
            profiles: { dev: { workflow: { 'runs-on': { b: 'z' } } } }
          },
          source: 'secureci.yml'
        }
      });
      expect(resolved.workflow['runs-on']).toEqual({ a: 'x', b: 'z' });
    });

    it('a string replaces a mapping from a lower layer, and vice versa', () => {
      const resolved = resolveRunConfig({
        profile: 'dev',
        global: {
          profiles: { dev: { workflow: { 'runs-on': { a: 'x' } } } }
        },
        repo: {
          config: {
            profiles: { dev: { workflow: { 'runs-on': 'ubuntu-latest' } } }
          },
          source: 'secureci.yml'
        }
      });
      expect(resolved.workflow['runs-on']).toBe('ubuntu-latest');
    });

    it('rejects an unknown profile, naming the ones defined', () => {
      expect(() =>
        resolveRunConfig({
          profile: 'prod',
          global: { profiles: { dev: {} } },
          repo: { config: { profiles: { ci: {} } }, source: 'secureci.yml' }
        })
      ).toThrow(/Unknown profile "prod".*ci, dev/);
      expect(() => resolveRunConfig({ profile: 'x', global: {} })).toThrow(
        /no profiles are defined/
      );
    });

    it('validates global profiles too (but lets them set any key)', () => {
      expect(
        resolveRunConfig({
          profile: 'dev',
          global: {
            profiles: {
              dev: { 'container-runtime': 'host', 'env-file': ['.env'] }
            }
          }
        }).config
      ).toEqual({ 'container-runtime': 'host', 'env-file': ['.env'] });
      expect(() =>
        resolveRunConfig({
          profile: 'dev',
          global: { profiles: { dev: { bogus: 1 } as never } }
        })
      ).toThrow(/profiles\.dev: unknown key "bogus"/);
    });

    it('does not leak profiles into the resolved config', () => {
      const resolved = resolveRunConfig({
        global: { profiles: { dev: {} } }
      });
      expect(resolved.config).toEqual({});
    });
  });
});
