import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { promisify } from 'util';
import { exec } from 'child_process';
import { logger } from '../utils/logger';

const execAsync = promisify(exec);

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
  const cacheDir = path.join(homeDir, '.actly', 'actions-cache');

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
 * Download a file from a URL
 */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    https
      .get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          // Handle redirects
          if (response.headers.location) {
            file.close();
            fs.unlinkSync(dest);
            downloadFile(response.headers.location, dest)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        file.close();
        if (fs.existsSync(dest)) {
          fs.unlinkSync(dest);
        }
        reject(err);
      });
  });
}

/**
 * Fetch an action from GitHub and cache it locally
 */
export async function fetchAction(uses: string): Promise<string | null> {
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

  try {
    // Create action directory
    if (!fs.existsSync(actionDir)) {
      fs.mkdirSync(actionDir, { recursive: true });
    }

    // Try to download using GitHub's tarball API
    const tarballUrl = `https://github.com/${ref.owner}/${ref.repo}/archive/${ref.ref}.tar.gz`;
    const tarballPath = path.join(actionDir, 'source.tar.gz');

    logger.debug(`Downloading from: ${tarballUrl}`);
    await downloadFile(tarballUrl, tarballPath);

    // Extract tarball
    const extractDir = path.join(actionDir, 'extracted');
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    await execAsync(`tar -xzf ${tarballPath} -C ${extractDir}`);

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
