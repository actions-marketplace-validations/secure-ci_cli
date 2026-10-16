import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { promisify } from 'util';
import { execFile, execFileSync } from 'child_process';
import { logger } from '../utils/logger';

const execFileAsync = promisify(execFile);

/** Default connect/idle timeout for action downloads. */
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

export interface FetchActionOptions {
  /**
   * Token for GitHub downloads; null for none. Default: discovered (see
   * githubToken).
   */
  token?: string | null;
  /** Use only what is cached; never touch the network. */
  offline?: boolean;
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

/** The cache directory for downloaded actions and repositories. */
export function getActionCacheDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(homeDir, '.secureci', 'actions-cache');
}

let discoveredToken: string | null | undefined;

/**
 * A GitHub token for downloading actions: $GITHUB_TOKEN, $GH_TOKEN, else
 * `gh auth token`. Only ever sent to the GitHub API/server, never passed
 * to actions, and masked in logs.
 */
export function githubToken(): string | null {
  if (discoveredToken !== undefined) return discoveredToken;
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!token) {
    try {
      token = execFileSync('gh', ['auth', 'token'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000
      }).trim();
    } catch {
      token = '';
    }
  }
  discoveredToken = token || null;
  if (token) logger.registerSecrets({ 'github-token': token });
  return discoveredToken;
}

/** Test-only: forget the discovered token. */
export function _resetGithubTokenForTests(): void {
  discoveredToken = undefined;
}

function serverUrl(): string {
  return (process.env.GITHUB_SERVER_URL || 'https://github.com').replace(
    /\/+$/,
    ''
  );
}

function apiUrl(): string {
  if (process.env.GITHUB_API_URL) {
    return process.env.GITHUB_API_URL.replace(/\/+$/, '');
  }
  const server = serverUrl();
  return server === 'https://github.com'
    ? 'https://api.github.com'
    : `${server}/api/v3`;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * The commit a branch or tag points at, via `git ls-remote` (anonymous, so
 * no API rate limit). Annotated tags resolve to their commit.
 */
export async function lsRemoteSha(
  url: string,
  ref: string
): Promise<string | undefined> {
  let output: string;
  try {
    ({ stdout: output } = await execFileAsync(
      'git',
      [
        'ls-remote',
        url,
        `refs/tags/${ref}`,
        `refs/tags/${ref}^{}`,
        `refs/heads/${ref}`
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      }
    ));
  } catch {
    return undefined;
  }
  const refs = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name) refs.set(name, sha);
  }
  return (
    refs.get(`refs/tags/${ref}^{}`) ??
    refs.get(`refs/tags/${ref}`) ??
    refs.get(`refs/heads/${ref}`)
  );
}

/** GET a small text response (the API commit lookup). */
function getText(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(url, { headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () =>
        response.statusCode === 200
          ? resolve(body)
          : reject(
              Object.assign(new Error(`HTTP ${response.statusCode}`), {
                status: response.statusCode
              })
            )
      );
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error(`Timed out after ${timeoutMs}ms: ${url}`))
    );
    request.on('error', reject);
  });
}

/**
 * The commit SHA for `ref`, or undefined if it can't be resolved now.
 * `unauthorized` is set when GitHub rejected the token.
 */
async function resolveSha(
  ref: ActionReference,
  token: string | null,
  timeoutMs: number
): Promise<{ sha?: string; unauthorized?: boolean }> {
  if (FULL_SHA.test(ref.ref)) return { sha: ref.ref.toLowerCase() };
  if (token) {
    try {
      const sha = (
        await getText(
          `${apiUrl()}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.ref)}`,
          {
            ...requestHeaders(token),
            Accept: 'application/vnd.github.sha'
          },
          timeoutMs
        )
      ).trim();
      return { sha: FULL_SHA.test(sha) ? sha.toLowerCase() : undefined };
    } catch (error) {
      return { unauthorized: (error as { status?: number }).status === 401 };
    }
  }
  return {
    sha: await lsRemoteSha(
      `${serverUrl()}/${ref.owner}/${ref.repo}.git`,
      ref.ref
    )
  };
}

/**
 * Download a URL to a file, following up to MAX_REDIRECTS redirects. The
 * Authorization header is only sent to the original host (GitHub's API
 * redirects tarballs to a pre-signed codeload URL). Every response that
 * isn't piped to the file is drained, so the socket is released, and the
 * request is aborted if it stalls for `timeoutMs`.
 */
function downloadFile(
  url: string,
  dest: string,
  timeoutMs: number,
  headers: Record<string, string>,
  redirectsLeft = MAX_REDIRECTS
): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    const request = client.get(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          reject(new Error(`Redirect (${status}) without a Location header`));
        } else if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects downloading ${url}`));
        } else {
          const next = new URL(location, url);
          const nextHeaders = { ...headers };
          if (next.host !== new URL(url).host) {
            delete nextHeaders.Authorization;
          }
          downloadFile(
            next.toString(),
            dest,
            timeoutMs,
            nextHeaders,
            redirectsLeft - 1
          ).then(resolve, reject);
        }
        return;
      }

      if (status !== 200) {
        response.resume();
        const hint =
          status === 404
            ? headers.Authorization
              ? ' (check the action name and ref, and that your token can read the repository)'
              : ' (check the action name and ref; for a private repository, set GITHUB_TOKEN or log in with `gh auth login`)'
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

function requestHeaders(token: string | null): Record<string, string> {
  return {
    'User-Agent': 'secureci-cli',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

/** Where a repository's commits are cached, and its ref -> SHA index. */
function repoCacheDir(ref: ActionReference): string {
  return path.join(
    getActionCacheDir(),
    ref.owner.toLowerCase(),
    ref.repo.toLowerCase()
  );
}

function readRefIndex(dir: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'refs.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeRefIndex(dir: string, refs: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, 'refs.json'), JSON.stringify(refs, null, 2));
}

/**
 * Download (or reuse from the cache) the repository tree of an action
 * reference, keyed by commit SHA: a tag or SHA is fetched once, and a
 * moving ref (`@main`) is re-resolved on every run, so new commits are
 * picked up. If the ref can't be resolved (offline, rate-limited), the
 * last commit cached for it is used. Returns the repository root.
 */
async function fetchRepository(
  ref: ActionReference,
  uses: string,
  options: FetchActionOptions
): Promise<string | null> {
  const dir = repoCacheDir(ref);
  const refs = readRefIndex(dir);
  const cachedSha = FULL_SHA.test(ref.ref)
    ? ref.ref.toLowerCase()
    : refs[ref.ref];
  const cached = (sha: string | undefined) =>
    sha && fs.existsSync(path.join(dir, sha)) ? path.join(dir, sha) : null;

  if (options.offline) {
    const root = cached(cachedSha);
    if (!root) {
      logger.error(`Action ${uses} is not cached (offline mode)`);
    }
    return root;
  }

  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  let token = options.token === undefined ? githubToken() : options.token;
  const resolved = await resolveSha(ref, token, timeoutMs);
  let sha = resolved.sha;
  if (resolved.unauthorized) {
    // An expired or revoked token shouldn't break public actions.
    logger.warn(
      'GitHub rejected the token (401); continuing without it for this run'
    );
    if (options.token === undefined) discoveredToken = null;
    token = null;
    ({ sha } = await resolveSha(ref, token, timeoutMs));
  }
  if (sha && cached(sha)) {
    logger.debug(`Using cached action: ${uses} (${sha.slice(0, 7)})`);
    return cached(sha);
  }
  if (!sha && cached(cachedSha)) {
    logger.warn(
      `Could not resolve ${uses}; using the cached commit ${(cachedSha as string).slice(0, 7)}`
    );
    return cached(cachedSha);
  }

  logger.info(`Fetching action: ${uses}`);
  // Without a SHA (e.g. no token and no git), download by ref name into a
  // slot that is replaced on every run rather than trusted later.
  const key = sha ?? `unresolved-${ref.ref.replace(/[^\w.-]/g, '_')}`;
  const target = path.join(dir, key);
  const createdDir = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(dir, '.download-'));
  try {
    const url = token
      ? `${apiUrl()}/repos/${ref.owner}/${ref.repo}/tarball/${sha ?? ref.ref}`
      : `${serverUrl()}/${ref.owner}/${ref.repo}/archive/${sha ?? ref.ref}.tar.gz`;
    const tarballPath = path.join(tmp, 'source.tar.gz');
    logger.debug(`Downloading from: ${url}`);
    await downloadFile(url, tarballPath, timeoutMs, requestHeaders(token));

    const extractDir = path.join(tmp, 'extracted');
    fs.mkdirSync(extractDir);
    await execFileAsync('tar', ['-xzf', tarballPath, '-C', extractDir]);
    // GitHub tarballs hold a single top-level directory.
    const [top] = fs.readdirSync(extractDir);
    if (!top) throw new Error('No files extracted from tarball');

    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(extractDir, top), target);
    if (sha) {
      writeRefIndex(dir, { ...readRefIndex(dir), [ref.ref]: sha });
    }
    logger.success(`Action fetched successfully: ${uses}`);
    return target;
  } catch (error) {
    logger.error(
      `Failed to fetch action ${uses}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    if (createdDir) {
      // Don't leave an empty cache entry behind.
      fs.rmSync(path.join(getActionCacheDir(), ref.owner.toLowerCase()), {
        recursive: true,
        force: true
      });
    }
    return null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** `root/sub`, or null if `sub` escapes `root`. */
function within(root: string, sub = ''): string | null {
  const resolved = path.resolve(root, sub);
  return resolved === root || resolved.startsWith(root + path.sep)
    ? resolved
    : null;
}

/**
 * Download a remote GitHub action, using the local cache when possible,
 * and return the path to its action.yml / action.yaml.
 */
export async function fetchAction(
  uses: string,
  options: FetchActionOptions = {}
): Promise<string | null> {
  const ref = parseActionReference(uses);
  if (!ref) return null;

  const root = await fetchRepository(ref, uses, options);
  if (!root) return null;

  const actionDir = within(root, ref.path);
  for (const name of ['action.yml', 'action.yaml']) {
    const file = actionDir && path.join(actionDir, name);
    if (file && fs.existsSync(file)) return file;
  }
  logger.error(`No action.yml or action.yaml found in ${uses}`);
  return null;
}

/**
 * Download the repository of `owner/repo/path/to/file@ref` (e.g. a remote
 * reusable workflow) and return the path to that file, or null.
 */
export async function fetchRepoFile(
  uses: string,
  options: FetchActionOptions = {}
): Promise<string | null> {
  const ref = parseActionReference(uses);
  if (!ref?.path) return null;

  const root = await fetchRepository(ref, uses, options);
  const file = root && within(root, ref.path);
  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  if (root) logger.error(`File not found in ${uses}`);
  return null;
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

/**
 * Resolve a `uses:` action reference to its current commit SHA, for the
 * inventory and lockfile. Returns undefined if the ref can't be resolved
 * (not an action reference, offline, or the lookup failed). Uses a token
 * when one is available (githubToken), else anonymous `git ls-remote`.
 */
export async function resolveActionSha(
  uses: string,
  options: { token?: string | null; timeoutMs?: number } = {}
): Promise<string | undefined> {
  const ref = parseActionReference(uses);
  if (!ref) return undefined;
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const token = options.token === undefined ? githubToken() : options.token;
  const first = await resolveSha(ref, token, timeoutMs);
  if (first.sha) return first.sha;
  // A rejected token shouldn't block resolution: retry anonymously.
  if (first.unauthorized) {
    return (await resolveSha(ref, null, timeoutMs)).sha;
  }
  return undefined;
}

/**
 * GitHub's numeric ids for a repository and its owner, from the REST API,
 * or undefined if they can't be looked up (offline, rate-limited, gone).
 * The ids survive a rename but not a delete-and-recreate, so a changed id
 * means a different repository now answers to the same name.
 */
export async function resolveRepoIdentity(
  owner: string,
  repo: string,
  options: { token?: string | null; timeoutMs?: number } = {}
): Promise<{ ownerId: number; repoId: number } | undefined> {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const token = options.token === undefined ? githubToken() : options.token;
  const lookup = async (auth: string | null) => {
    try {
      const body = JSON.parse(
        await getText(
          `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          { ...requestHeaders(auth), Accept: 'application/vnd.github+json' },
          timeoutMs
        )
      ) as { id?: unknown; owner?: { id?: unknown } };
      const repoId = body.id;
      const ownerId = body.owner?.id;
      return typeof repoId === 'number' && typeof ownerId === 'number'
        ? { identity: { ownerId, repoId } }
        : {};
    } catch (error) {
      return { unauthorized: (error as { status?: number }).status === 401 };
    }
  };
  const first = await lookup(token);
  if (first.identity) return first.identity;
  // A rejected token shouldn't block the lookup: retry anonymously.
  if (token && first.unauthorized) return (await lookup(null)).identity;
  return undefined;
}

/** Whether `git ls-remote` can read the repository at `url`. */
export async function lsRemoteReachable(url: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['ls-remote', url, 'HEAD'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `owner/repo` can still be read: via the API when a token is
 * available (404 means no), otherwise (or if the API can't answer) via
 * anonymous `git ls-remote`. False also when the network is down.
 */
export async function repoExists(
  owner: string,
  repo: string,
  options: { token?: string | null; timeoutMs?: number } = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const token = options.token === undefined ? githubToken() : options.token;
  if (token) {
    try {
      await getText(
        `${apiUrl()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        { ...requestHeaders(token), Accept: 'application/vnd.github+json' },
        timeoutMs
      );
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return false;
      // 401, rate limit or network: fall back to anonymous git.
    }
  }
  return lsRemoteReachable(`${serverUrl()}/${owner}/${repo}.git`);
}
