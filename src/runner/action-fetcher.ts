import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

/** Default connect/idle timeout for action downloads. */
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

export interface FetchActionOptions {
  /** Abort a download that makes no progress for this long. */
  timeoutMs?: number;
}

export interface ActionReference {
  owner: string;
  repo: string;
  ref: string; // Can be tag, branch, or commit SHA
  path?: string; // For actions in subdirectories
}

/**
 * Parse an action reference like "actions/checkout@v3" or "owner/repo/path@ref"
 */
export function parseActionReference(uses: string): ActionReference | null {
  // Format: owner/repo[@ref] or owner/repo/path[@ref]
  const match = uses.match(/^([^/]+)\/([^/@]+)(?:\/([^@]+))?@(.+)$/);

  if (!match) {
    logger.warn(`Invalid action reference format: ${uses}`);
    return null;
  }

  const [, owner, repo, actionPath, ref] = match;

  return {
    owner,
    repo,
    ref,
    path: actionPath || undefined
  };
}

/**
 * Get the cache directory for actions
 */
function getActionCacheDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  const cacheDir = path.join(homeDir, '.ghact', 'actions-cache');

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  return cacheDir;
}

/**
 * Get the local path for a cached action
 */
function getActionPath(ref: ActionReference): string {
  const cacheDir = getActionCacheDir();
  const actionDir = ref.path
    ? path.join(cacheDir, ref.owner, ref.repo, ref.path, ref.ref)
    : path.join(cacheDir, ref.owner, ref.repo, ref.ref);

  return actionDir;
}

/**
 * Download a URL to a file, following up to MAX_REDIRECTS redirects.
 * Every response that isn't piped to the file is drained, so the socket is
 * released (an unconsumed response keeps the process from exiting), and
 * the request is aborted if it stalls for `timeoutMs`.
 */
function downloadFile(
  url: string,
  dest: string,
  timeoutMs: number,
  redirectsLeft = MAX_REDIRECTS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(url, (response) => {
      const status = response.statusCode ?? 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          reject(new Error(`Redirect (${status}) without a Location header`));
        } else if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects downloading ${url}`));
        } else {
          downloadFile(
            new URL(location, url).toString(),
            dest,
            timeoutMs,
            redirectsLeft - 1
          ).then(resolve, reject);
        }
        return;
      }

      if (status !== 200) {
        response.resume();
        const hint =
          status === 404
            ? ' (check the action name and ref; private repositories are not supported yet)'
            : '';
        reject(new Error(`Failed to download: ${status}${hint}`));
        return;
      }

      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
      response.on('error', reject);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error(`Download timed out after ${timeoutMs}ms: ${url}`)
      );
    });
    request.on('error', reject);
  });
}

/**
 * Fetch an action from GitHub and cache it locally
 */
export async function fetchAction(
  uses: string,
  options: FetchActionOptions = {}
): Promise<string | null> {
  const ref = parseActionReference(uses);

  if (!ref) {
    return null;
  }

  const actionDir = getActionPath(ref);

  // Check if already cached
  const actionYmlPath = path.join(actionDir, 'action.yml');
  const actionYamlPath = path.join(actionDir, 'action.yaml');

  if (fs.existsSync(actionYmlPath)) {
    logger.debug(`Using cached action: ${uses}`);
    return actionYmlPath;
  }

  if (fs.existsSync(actionYamlPath)) {
    logger.debug(`Using cached action: ${uses}`);
    return actionYamlPath;
  }

  logger.info(`Fetching action: ${uses}`);

  // The topmost directory this fetch creates, removed again on failure.
  let createdRoot: string | undefined;
  for (let dir = actionDir; !fs.existsSync(dir); dir = path.dirname(dir)) {
    createdRoot = dir;
  }
  try {
    // Create action directory
    if (!fs.existsSync(actionDir)) {
      fs.mkdirSync(actionDir, { recursive: true });
    }

    // Try to download using GitHub's tarball API
    // GITHUB_SERVER_URL allows GitHub Enterprise Server (and tests).
    const serverUrl = (
      process.env.GITHUB_SERVER_URL || 'https://github.com'
    ).replace(/\/+$/, '');
    const tarballUrl = `${serverUrl}/${ref.owner}/${ref.repo}/archive/${ref.ref}.tar.gz`;
    const tarballPath = path.join(actionDir, 'source.tar.gz');

    logger.debug(`Downloading from: ${tarballUrl}`);
    await downloadFile(
      tarballUrl,
      tarballPath,
      options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS
    );

    // Extract tarball
    const extractDir = path.join(actionDir, 'extracted');
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir]);

    // Find the action.yml or action.yaml file
    // GitHub tarballs create a directory like repo-ref/
    const extractedDirs = fs.readdirSync(extractDir);
    if (extractedDirs.length === 0) {
      throw new Error('No files extracted from tarball');
    }

    const repoDir = path.join(extractDir, extractedDirs[0]);
    const sourcePath = ref.path ? path.join(repoDir, ref.path) : repoDir;

    // Copy action.yml or action.yaml to the action directory
    const sourceActionYml = path.join(sourcePath, 'action.yml');
    const sourceActionYaml = path.join(sourcePath, 'action.yaml');

    if (fs.existsSync(sourceActionYml)) {
      // Copy entire action directory contents to preserve any referenced scripts
      copyDir(sourcePath, actionDir);
      logger.success(`Action fetched successfully: ${uses}`);
      return actionYmlPath;
    } else if (fs.existsSync(sourceActionYaml)) {
      copyDir(sourcePath, actionDir);
      logger.success(`Action fetched successfully: ${uses}`);
      return actionYamlPath;
    } else {
      throw new Error('No action.yml or action.yaml found in the action');
    }
  } catch (error) {
    logger.error(
      `Failed to fetch action ${uses}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    // Don't leave a half-populated cache entry behind.
    if (createdRoot) {
      fs.rmSync(createdRoot, { recursive: true, force: true });
    }
    return null;
  }
}

/**
 * Copy directory recursively
 */
function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Skip the extracted directory to avoid recursion
      if (entry.name === 'extracted') {
        continue;
      }
      copyDir(srcPath, destPath);
    } else {
      // Skip the tarball file
      if (entry.name === 'source.tar.gz') {
        continue;
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clear the action cache
 */
export function clearActionCache(): void {
  const cacheDir = getActionCacheDir();

  if (fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    logger.info('Action cache cleared');
  }
}
