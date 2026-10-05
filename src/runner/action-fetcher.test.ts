import {
  parseActionReference,
  fetchAction,
  clearActionCache
} from './action-fetcher';
import * as fs from 'fs';
import * as path from 'path';

describe('Action Fetcher', () => {
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
    beforeAll(() => {
      // Clean up cache before tests
      clearActionCache();
    });

    afterAll(() => {
      // Clean up cache after tests
      clearActionCache();
    });

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
});
