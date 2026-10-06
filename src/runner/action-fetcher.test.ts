import {
  parseActionReference,
  fetchAction,
  clearActionCache
} from './action-fetcher';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AddressInfo } from 'net';

describe('Action Fetcher', () => {
  // Never touch the developer's real ~/.ghact cache.
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-fetcher-home-'));
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
      const cacheDir = path.join(homeDir, '.ghact', 'actions-cache');

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

  describe('fetchAction against a local server', () => {
    let server: http.Server;
    let baseUrl: string;
    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    let originalServerUrl: string | undefined;

    function tarball(): Buffer {
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-tarball-'));
      const repoDir = path.join(src, 'repo-v1');
      fs.mkdirSync(repoDir);
      fs.writeFileSync(
        path.join(repoDir, 'action.yml'),
        'name: t\ndescription: d\nruns:\n  using: composite\n  steps: []\n'
      );
      const out = path.join(src, 'a.tar.gz');
      execFileSync('tar', ['-czf', out, '-C', src, 'repo-v1']);
      const data = fs.readFileSync(out);
      fs.rmSync(src, { recursive: true, force: true });
      return data;
    }

    beforeEach(async () => {
      server = http.createServer((req, res) => handler(req, res));
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      originalServerUrl = process.env.GITHUB_SERVER_URL;
      process.env.GITHUB_SERVER_URL = baseUrl;
    });

    afterEach(async () => {
      if (originalServerUrl === undefined) delete process.env.GITHUB_SERVER_URL;
      else process.env.GITHUB_SERVER_URL = originalServerUrl;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const cacheDirFor = () =>
      path.join(tempHome, '.ghact', 'actions-cache', 'org', 'act', 'v1');

    it('downloads, extracts and caches an action', async () => {
      const data = tarball();
      handler = (req, res) => {
        expect(req.url).toBe('/org/act/archive/v1.tar.gz');
        res.writeHead(200);
        res.end(data);
      };

      const result = await fetchAction('org/act@v1');

      expect(result).toBe(path.join(cacheDirFor(), 'action.yml'));
      expect(fs.existsSync(result as string)).toBe(true);
    });

    it('follows redirects', async () => {
      const data = tarball();
      handler = (req, res) => {
        if (req.url === '/org/act/archive/v1.tar.gz') {
          res.writeHead(302, { Location: `${baseUrl}/codeload/v1.tar.gz` });
          res.end('redirecting');
          return;
        }
        res.writeHead(200);
        res.end(data);
      };

      expect(await fetchAction('org/act@v1')).not.toBeNull();
    });

    it('returns null on 404 and leaves no partial cache directory', async () => {
      handler = (_req, res) => {
        res.writeHead(404);
        res.end('Not Found');
      };

      expect(await fetchAction('org/act@v1')).toBeNull();
      expect(fs.existsSync(cacheDirFor())).toBe(false);
      expect(
        fs.existsSync(path.join(tempHome, '.ghact', 'actions-cache', 'org'))
      ).toBe(false);
    });

    it('gives up on a redirect loop', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { Location: `${baseUrl}/loop` });
        res.end();
      };

      expect(await fetchAction('org/act@v1')).toBeNull();
    });

    it('times out a stalled download', async () => {
      handler = () => {
        // Never respond
      };

      const started = Date.now();
      expect(await fetchAction('org/act@v1', { timeoutMs: 200 })).toBeNull();
      expect(Date.now() - started).toBeLessThan(5000);
      expect(fs.existsSync(cacheDirFor())).toBe(false);
    });
  });
});
