import {
  parseActionReference,
  fetchAction,
  fetchRepoFile,
  lsRemoteSha,
  resolveActionSha,
  resolveRepoIdentity,
  repoExists,
  lsRemoteReachable,
  clearActionCache,
  cachedActionSha,
  getActionCacheDir
} from './action-fetcher';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';

describe('Action Fetcher', () => {
  // Never touch the developer's real ~/.secureci cache.
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-fetcher-home-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe('parseActionReference', () => {
    it('should parse a simple action reference', () => {
      const ref = parseActionReference('actions/checkout@v3');

      expect(ref).not.toBeNull();
      expect(ref?.owner).toBe('actions');
      expect(ref?.repo).toBe('checkout');
      expect(ref?.ref).toBe('v3');
      expect(ref?.path).toBeUndefined();
    });

    it('should parse an action reference with a path', () => {
      const ref = parseActionReference('owner/repo/path/to/action@main');

      expect(ref).not.toBeNull();
      expect(ref?.owner).toBe('owner');
      expect(ref?.repo).toBe('repo');
      expect(ref?.ref).toBe('main');
      expect(ref?.path).toBe('path/to/action');
    });

    it('should parse an action reference with a commit SHA', () => {
      const ref = parseActionReference('actions/setup-node@abc123def456');

      expect(ref).not.toBeNull();
      expect(ref?.owner).toBe('actions');
      expect(ref?.repo).toBe('setup-node');
      expect(ref?.ref).toBe('abc123def456');
    });

    it('should return null for invalid format', () => {
      expect(parseActionReference('invalid')).toBeNull();
      expect(parseActionReference('no-at-sign')).toBeNull();
      expect(parseActionReference('@just-ref')).toBeNull();
    });
  });

  describe('fetchAction', () => {
    it('should return null for invalid action reference', async () => {
      const result = await fetchAction('invalid-reference');
      expect(result).toBeNull();
    });

    it('should fetch a simple composite action', async () => {
      // This test requires network access and may be slow
      // Skip in CI environments or when network is unavailable
      if (process.env.CI || !process.env.RUN_NETWORK_TESTS) {
        return;
      }

      const result = await fetchAction(
        'actions/hello-world-composite-action@v1'
      );

      expect(result).not.toBeNull();
      if (result) {
        expect(fs.existsSync(result)).toBe(true);
        expect(result).toMatch(/action\.ya?ml$/);
      }
    }, 30000); // 30 second timeout for network operation

    it('should use cached action on second fetch', async () => {
      // This test requires network access
      if (process.env.CI || !process.env.RUN_NETWORK_TESTS) {
        return;
      }

      const firstFetch = await fetchAction(
        'actions/hello-world-composite-action@v1'
      );
      const secondFetch = await fetchAction(
        'actions/hello-world-composite-action@v1'
      );

      expect(firstFetch).toBe(secondFetch);
    }, 30000);
  });

  describe('clearActionCache', () => {
    it('should clear the action cache', () => {
      // Create a test cache directory
      const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
      const cacheDir = path.join(homeDir, '.secureci', 'actions-cache');

      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      // Create a test file
      const testFile = path.join(cacheDir, 'test.txt');
      fs.writeFileSync(testFile, 'test');

      // Clear cache
      clearActionCache();

      // Verify cache is cleared
      expect(fs.existsSync(testFile)).toBe(false);
    });
  });

  describe('fetching against a local server (#35)', () => {
    let server: http.Server;
    let baseUrl: string;
    let requests: Array<{ url: string; auth?: string; host?: string }>;
    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    const saved: Record<string, string | undefined> = {};
    const SHA1 = 'a'.repeat(40);
    const SHA2 = 'b'.repeat(40);

    function tarball(marker = 'one'): Buffer {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-tarball-'));
      const repoDir = path.join(src, 'org-act-1234567');
      fs.mkdirSync(path.join(repoDir, 'sub'), { recursive: true });
      fs.mkdirSync(path.join(repoDir, '.github', 'workflows'), {
        recursive: true
      });
      const action = `name: ${marker}\ndescription: d\nruns:\n  using: composite\n  steps: []\n`;
      fs.writeFileSync(path.join(repoDir, 'action.yml'), action);
      fs.writeFileSync(path.join(repoDir, 'sub', 'action.yaml'), action);
      fs.writeFileSync(
        path.join(repoDir, '.github', 'workflows', 'reuse.yml'),
        'name: reuse\n'
      );
      const out = path.join(src, 'a.tar.gz');
      execFileSync('tar', ['-czf', out, '-C', src, 'org-act-1234567']);
      const data = fs.readFileSync(out);
      fs.rmSync(src, { recursive: true, force: true });
      return data;
    }

    /** A fake GitHub: API commit lookup and tarballs per SHA. */
    function github(
      shaFor: Record<string, string>,
      tarballs: Record<string, Buffer>
    ) {
      return (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = req.url ?? '';
        const commit = url.match(/^\/api\/repos\/org\/act\/commits\/(.+)$/);
        if (commit) {
          const sha = shaFor[decodeURIComponent(commit[1])];
          res.writeHead(sha ? 200 : 404);
          res.end(sha ?? 'Not Found');
          return;
        }
        const tar = url.match(/^\/api\/repos\/org\/act\/tarball\/(.+)$/);
        if (tar && tarballs[tar[1]]) {
          res.writeHead(200);
          res.end(tarballs[tar[1]]);
          return;
        }
        res.writeHead(404);
        res.end('Not Found');
      };
    }

    beforeEach(async () => {
      requests = [];
      server = http.createServer((req, res) => {
        requests.push({
          url: req.url ?? '',
          auth: req.headers.authorization,
          host: req.headers.host
        });
        handler(req, res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const key of [
        'GITHUB_SERVER_URL',
        'GITHUB_API_URL',
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'no_proxy',
        'NO_PROXY'
      ]) {
        saved[key] = process.env[key];
      }
      // git ls-remote must reach the local server directly.
      process.env.no_proxy = process.env.NO_PROXY = '127.0.0.1,localhost';
      process.env.GITHUB_SERVER_URL = baseUrl;
      process.env.GITHUB_API_URL = `${baseUrl}/api`;
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
    });

    afterEach(async () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const repoCache = () =>
      path.join(tempHome, '.secureci', 'actions-cache', 'org', 'act');

    it('resolveActionSha returns a full-SHA ref unchanged, without a request', async () => {
      handler = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      expect(await resolveActionSha(`org/act@${SHA1}`, { token: 'tok' })).toBe(
        SHA1
      );
      expect(requests).toEqual([]);
    });

    it('resolveActionSha resolves a tag to a commit via the API token', async () => {
      handler = github({ v1: SHA1 }, {});
      expect(await resolveActionSha('org/act@v1', { token: 'tok' })).toBe(SHA1);
      expect(requests[0].url).toBe('/api/repos/org/act/commits/v1');
      expect(requests[0].auth).toBe('Bearer tok');
    });

    it('resolveRepoIdentity reads the repository and owner ids', async () => {
      handler = (req, res) => {
        if (req.url === '/api/repos/org/act') {
          res.writeHead(200);
          res.end(JSON.stringify({ id: 42, owner: { id: 7 } }));
          return;
        }
        res.writeHead(404);
        res.end();
      };
      expect(await resolveRepoIdentity('org', 'act', { token: 'tok' })).toEqual(
        { ownerId: 7, repoId: 42 }
      );
      expect(requests[0].auth).toBe('Bearer tok');
      expect(await resolveRepoIdentity('org', 'act', { token: null })).toEqual({
        ownerId: 7,
        repoId: 42
      });
      expect(requests[1].auth).toBeUndefined();
      expect(
        await resolveRepoIdentity('org', 'missing', { token: null })
      ).toBeUndefined();
    });

    it('resolveRepoIdentity retries without a rejected token', async () => {
      handler = (req, res) => {
        if (req.headers.authorization) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ id: 1, owner: { id: 2 } }));
      };
      expect(await resolveRepoIdentity('org', 'act', { token: 'bad' })).toEqual(
        { ownerId: 2, repoId: 1 }
      );
      expect(requests).toHaveLength(2);
    });

    it('repoExists asks the API with a token: 200 yes, 404 no', async () => {
      handler = (req, res) => {
        res.writeHead(req.url === '/api/repos/org/act' ? 200 : 404);
        res.end('{}');
      };
      expect(await repoExists('org', 'act', { token: 'tok' })).toBe(true);
      expect(await repoExists('org', 'gone', { token: 'tok' })).toBe(false);
      expect(requests.map((r) => r.auth)).toEqual(['Bearer tok', 'Bearer tok']);
    });

    it('resolveRepoIdentity ignores a response without numeric ids', async () => {
      handler = (_req, res) => {
        res.writeHead(200);
        res.end(JSON.stringify({ id: 'x' }));
      };
      expect(
        await resolveRepoIdentity('org', 'act', { token: null })
      ).toBeUndefined();
    });

    it('resolveActionSha returns undefined for a non-action reference', async () => {
      expect(await resolveActionSha('not-an-action', { token: null })).toBe(
        undefined
      );
    });

    it('resolves a ref to a SHA with the token, and caches the repo by SHA', async () => {
      handler = github({ v1: SHA1 }, { [SHA1]: tarball() });

      const result = await fetchAction('org/act@v1', { token: 'tok' });

      expect(result).toBe(path.join(repoCache(), SHA1, 'action.yml'));
      expect(requests.map((r) => r.url)).toEqual([
        '/api/repos/org/act/commits/v1',
        `/api/repos/org/act/tarball/${SHA1}`
      ]);
      expect(requests.every((r) => r.auth === 'Bearer tok')).toBe(true);
    });

    it('re-downloads when a moving ref points at a new commit, and only then', async () => {
      const shaFor: Record<string, string> = { main: SHA1 };
      handler = github(shaFor, {
        [SHA1]: tarball('one'),
        [SHA2]: tarball('two')
      });

      const first = await fetchAction('org/act@main', { token: 'tok' });
      const again = await fetchAction('org/act@main', { token: 'tok' });
      expect(again).toBe(first);
      expect(requests.filter((r) => r.url.includes('/tarball/'))).toHaveLength(
        1
      );

      shaFor.main = SHA2;
      const moved = await fetchAction('org/act@main', { token: 'tok' });
      expect(moved).toBe(path.join(repoCache(), SHA2, 'action.yml'));
      expect(fs.readFileSync(moved as string, 'utf8')).toContain('name: two');
    });

    it('continues without the token when GitHub rejects it', async () => {
      const data = tarball();
      handler = (req, res) => {
        if (req.headers.authorization) {
          res.writeHead(401);
          res.end('Bad credentials');
          return;
        }
        if (req.url === '/org/act/archive/v1.tar.gz') {
          res.writeHead(200);
          res.end(data);
          return;
        }
        res.writeHead(404);
        res.end();
      };

      expect(
        await fetchAction('org/act@v1', { token: 'expired' })
      ).not.toBeNull();
    });

    it('does not look up a full commit SHA', async () => {
      handler = github({}, { [SHA1]: tarball() });
      expect(await fetchAction(`org/act@${SHA1}`, { token: 'tok' })).toBe(
        path.join(repoCache(), SHA1, 'action.yml')
      );
      expect(requests.map((r) => r.url)).toEqual([
        `/api/repos/org/act/tarball/${SHA1}`
      ]);
    });

    it('finds action.yaml in a subdirectory, and other files in the repo', async () => {
      handler = github({ v1: SHA1 }, { [SHA1]: tarball() });
      expect(await fetchAction('org/act/sub@v1', { token: 'tok' })).toBe(
        path.join(repoCache(), SHA1, 'sub', 'action.yaml')
      );
      expect(
        await fetchRepoFile('org/act/.github/workflows/reuse.yml@v1', {
          token: 'tok'
        })
      ).toBe(path.join(repoCache(), SHA1, '.github', 'workflows', 'reuse.yml'));
      expect(
        await fetchRepoFile('org/act/missing.yml@v1', { token: 'tok' })
      ).toBeNull();
    });

    it('drops the Authorization header on a redirect to another host', async () => {
      const port = (server.address() as AddressInfo).port;
      const data = tarball();
      handler = (req, res) => {
        if (req.url?.startsWith('/api/repos/org/act/tarball/')) {
          res.writeHead(302, {
            Location: `http://localhost:${port}/codeload/x.tar.gz`
          });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end(data);
      };

      expect(
        await fetchAction(`org/act@${SHA1}`, { token: 'tok' })
      ).not.toBeNull();
      const codeload = requests.find((r) => r.url === '/codeload/x.tar.gz');
      expect(codeload?.host).toBe(`localhost:${port}`);
      expect(codeload?.auth).toBeUndefined();
    });

    it('falls back to the last cached commit when the ref cannot be resolved', async () => {
      handler = github({ v1: SHA1 }, { [SHA1]: tarball() });
      const first = await fetchAction('org/act@v1', { token: 'tok' });

      handler = (_req, res) => {
        res.writeHead(500);
        res.end();
      };
      expect(await fetchAction('org/act@v1', { token: 'tok' })).toBe(first);
    });

    it('offline: uses the cache without any request, and fails if nothing is cached', async () => {
      handler = github({ v1: SHA1 }, { [SHA1]: tarball() });
      const first = await fetchAction('org/act@v1', { token: 'tok' });
      requests = [];

      expect(await fetchAction('org/act@v1', { offline: true })).toBe(first);
      expect(await fetchAction('org/act@v2', { offline: true })).toBeNull();
      expect(requests).toEqual([]);
    });

    it('without a token, downloads the archive by ref when git cannot resolve it', async () => {
      const data = tarball();
      handler = (req, res) => {
        if (req.url === '/org/act/archive/v1.tar.gz') {
          res.writeHead(200);
          res.end(data);
          return;
        }
        res.writeHead(404);
        res.end();
      };

      const result = await fetchAction('org/act@v1', { token: null });
      expect(result).not.toBeNull();
      expect(requests.every((r) => r.auth === undefined)).toBe(true);
    });

    it('returns null on 404 and leaves no partial cache directory', async () => {
      handler = (_req, res) => {
        res.writeHead(404);
        res.end('Not Found');
      };

      expect(await fetchAction(`org/act@${SHA1}`, { token: null })).toBeNull();
      expect(fs.existsSync(path.join(repoCache(), SHA1))).toBe(false);
    });

    it('gives up on a redirect loop', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { Location: `${baseUrl}/loop` });
        res.end();
      };

      expect(await fetchAction(`org/act@${SHA1}`, { token: null })).toBeNull();
    });

    it('times out a stalled download', async () => {
      handler = () => {
        // Never respond
      };

      const started = Date.now();
      expect(
        await fetchAction(`org/act@${SHA1}`, { token: null, timeoutMs: 200 })
      ).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
      expect(fs.existsSync(path.join(repoCache(), SHA1))).toBe(false);
    });
  });

  describe('cachedActionSha', () => {
    const SHA = 'a'.repeat(40);
    function seed(refs: Record<string, string>, commits: string[]): void {
      const dir = path.join(getActionCacheDir(), 'org', 'act');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'refs.json'), JSON.stringify(refs));
      for (const sha of commits) fs.mkdirSync(path.join(dir, sha));
    }

    it('returns the cached commit for a tag, without any network', () => {
      seed({ v1: SHA }, [SHA]);
      expect(cachedActionSha('org/act@v1')).toBe(SHA);
      expect(cachedActionSha('Org/Act/sub/dir@v1')).toBe(SHA);
    });

    it('is undefined for a ref that is not cached, or whose commit is gone', () => {
      seed({ v1: SHA }, []);
      expect(cachedActionSha('org/act@v1')).toBeUndefined();
      expect(cachedActionSha('org/act@v2')).toBeUndefined();
      expect(cachedActionSha('org/other@v1')).toBeUndefined();
      expect(cachedActionSha('not-a-reference')).toBeUndefined();
    });

    it('returns an already-pinned SHA as is (lower-cased)', () => {
      expect(cachedActionSha(`org/act@${'B'.repeat(40)}`)).toBe('b'.repeat(40));
    });
  });

  describe('lsRemoteReachable', () => {
    it('is true for a repository and false for a missing one', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-reach-'));
      try {
        execFileSync('git', ['init', '-q', dir]);
        expect(await lsRemoteReachable(dir)).toBe(true);
        expect(await lsRemoteReachable(path.join(dir, 'missing'))).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('resolving refs with git ls-remote', () => {
    it('resolves branches and (peeled) tags of a repository', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-lsremote-'));
      const work = path.join(dir, 'work');
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim();
      fs.mkdirSync(work);
      git('init', '-q', '-b', 'main');
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'one'
      );
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'tag',
        '-a',
        'v1',
        '-m',
        'v1'
      );
      const head = git('rev-parse', 'HEAD');

      try {
        expect(await lsRemoteSha(work, 'main')).toBe(head);
        expect(await lsRemoteSha(work, 'v1')).toBe(head);
        expect(await lsRemoteSha(work, 'nope')).toBeUndefined();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
