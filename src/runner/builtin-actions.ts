import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globToRegExp } from './hash-files';

/**
 * Local stand-ins for `actions/upload-artifact`, `actions/download-artifact`
 * and `actions/cache` (plus `cache/restore` and `cache/save`). The real
 * actions talk to GitHub's artifact and cache services, which don't exist
 * locally; these keep the same inputs, outputs and path rules, backed by
 * directories under ~/.secureci.
 */

export type BuiltinAction =
  | 'upload-artifact'
  | 'download-artifact'
  | 'cache'
  | 'cache-restore'
  | 'cache-save';

/** Which built-in, if any, handles a `uses:` reference. */
export function builtinActionFor(uses: string): BuiltinAction | undefined {
  const match = uses.match(
    /^actions\/(upload-artifact|download-artifact|cache(?:\/restore|\/save)?)@/i
  );
  if (!match) return undefined;
  return match[1].toLowerCase().replace('/', '-') as BuiltinAction;
}

/**
 * Where a step's files live. Paths are "logical": as the step sees them
 * (inside the job container in container mode). On the host they're the
 * real paths; in a container, the workspace is the mounted working copy
 * and anything else is copied in and out with the container client.
 */
export interface StepFileSystem {
  /** Logical workspace and home directories. */
  workspace: string;
  home: string;
  /** Path module for logical paths (posix inside a container). */
  path: typeof path.posix;
  /**
   * A host path with the content of a logical file or directory (copied
   * out of the container if needed), or null if it doesn't exist.
   */
  readable(logical: string): Promise<string | null>;
  /** Fill a logical directory (created if missing) via a host directory. */
  writeInto(logical: string, fill: (hostDir: string) => void): Promise<void>;
  /** Remove temporary copies. */
  cleanup(): void;
}

/** A step file system for steps running directly on the host. */
export function hostFileSystem(workspace: string): StepFileSystem {
  return {
    workspace,
    home: os.homedir(),
    path: path as unknown as typeof path.posix,
    readable: async (logical) => (fs.existsSync(logical) ? logical : null),
    writeInto: async (logical, fill) => {
      fs.mkdirSync(logical, { recursive: true });
      fill(logical);
    },
    cleanup: () => undefined
  };
}

/** What a container file system needs from the job container. */
export interface ContainerFileAccess {
  /** Mounted workspace inside the container, and its host directory. */
  workspace: string;
  hostWorkspace: string;
  home: string;
  copyFrom(containerPath: string, hostPath: string): Promise<boolean>;
  copyTo(hostPath: string, containerPath: string): Promise<boolean>;
  mkdir(containerPath: string): Promise<void>;
}

/** A step file system for steps running in a job container. */
export function containerFileSystem(
  access: ContainerFileAccess
): StepFileSystem {
  const p = path.posix;
  const temps: string[] = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-files-'));
    temps.push(dir);
    return dir;
  };
  const inWorkspace = (logical: string) =>
    logical === access.workspace || logical.startsWith(access.workspace + '/');
  const toHost = (logical: string) =>
    path.join(
      access.hostWorkspace,
      ...p.relative(access.workspace, logical).split('/')
    );

  return {
    workspace: access.workspace,
    home: access.home,
    path: p,
    readable: async (logical) => {
      if (inWorkspace(logical)) {
        const host = toHost(logical);
        return fs.existsSync(host) ? host : null;
      }
      const target = path.join(tempDir(), 'copy');
      return (await access.copyFrom(logical, target)) ? target : null;
    },
    writeInto: async (logical, fill) => {
      if (inWorkspace(logical)) {
        const host = toHost(logical);
        fs.mkdirSync(host, { recursive: true });
        fill(host);
        return;
      }
      const stage = tempDir();
      fill(stage);
      await access.mkdir(logical);
      if (!(await access.copyTo(`${stage}${path.sep}.`, logical))) {
        throw new Error(
          `Could not copy files into the container at ${logical}`
        );
      }
    },
    cleanup: () => {
      for (const dir of temps.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

/** A file found by collectFiles: where the step sees it, and where it is. */
interface FoundFile {
  logical: string;
  host: string;
}

function listFiles(hostRoot: string, base = ''): string[] {
  const stat = fs.statSync(hostRoot);
  if (stat.isFile()) return [base];
  const files: string[] = [];
  for (const entry of fs.readdirSync(hostRoot, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(hostRoot, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

/** Expand a leading `~` and resolve against the workspace. */
function resolveLogical(fsys: StepFileSystem, raw: string): string {
  const expanded =
    raw === '~' || raw.startsWith('~/')
      ? fsys.path.join(fsys.home, raw.slice(1))
      : raw;
  return fsys.path.resolve(fsys.workspace, expanded);
}

function commonAncestor(p: typeof path.posix, dirs: string[]): string {
  let common = dirs[0].split(p.sep);
  for (const dir of dirs.slice(1)) {
    const parts = dir.split(p.sep);
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) {
      i++;
    }
    common = common.slice(0, i);
  }
  return common.join(p.sep) || p.sep;
}

/**
 * Files matching multi-line path patterns, the way upload-artifact and
 * cache read them: each line is a file, a directory (all files under it)
 * or a glob (`*`, `**`, `?`); `!pattern` excludes. `root` is the least
 * common ancestor of the search paths, which file paths are relative to.
 */
export async function collectFiles(
  fsys: StepFileSystem,
  patterns: string,
  options: { includeHidden: boolean }
): Promise<{ root: string; files: FoundFile[] }> {
  const p = fsys.path;
  const lines = patterns
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const excludes = lines
    .filter((line) => line.startsWith('!'))
    .map((line) => globToRegExp(resolveLogical(fsys, line.slice(1).trim())));

  const searchPaths: string[] = [];
  const found = new Map<string, FoundFile>();
  for (const line of lines.filter((l) => !l.startsWith('!'))) {
    const pattern = resolveLogical(fsys, line);
    const globAt = pattern.search(/[*?[]/);
    const searchPath =
      globAt === -1
        ? pattern
        : pattern.slice(0, pattern.lastIndexOf('/', globAt)) || p.sep;
    const host = await fsys.readable(searchPath);
    if (!host) continue;
    const isFile = fs.statSync(host).isFile();
    searchPaths.push(isFile ? p.dirname(searchPath) : searchPath);
    const matcher = globAt === -1 ? undefined : globToRegExp(pattern);
    for (const rel of listFiles(host)) {
      const logical = rel ? p.join(searchPath, rel) : searchPath;
      if (matcher && !matcher.test(logical)) continue;
      found.set(logical, {
        logical,
        host: rel ? path.join(host, ...rel.split('/')) : host
      });
    }
  }

  const root = searchPaths.length
    ? commonAncestor(p, searchPaths)
    : fsys.workspace;
  const files = [...found.values()].filter(
    (file) =>
      !excludes.some((re) => re.test(file.logical)) &&
      (options.includeHidden ||
        !p
          .relative(root, file.logical)
          .split('/')
          .some((part) => part.startsWith('.')))
  );
  return { root, files };
}

function copyFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

function secureciDir(...parts: string[]): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  return path.join(home, '.secureci', ...parts);
}

/** Result of a built-in action: like a step result, minus the step. */
export interface BuiltinResult {
  success: boolean;
  output: string;
  outputs: Record<string, string>;
  error?: string;
  /** Shown as a warning (e.g. no files found). */
  warning?: string;
  /** A save to run at job end (actions/cache), if any. */
  post?: (fsys: StepFileSystem) => Promise<BuiltinResult>;
}

const ok = (
  output: string,
  outputs: Record<string, string> = {}
): BuiltinResult => ({
  success: true,
  output,
  outputs
});
const fail = (error: string): BuiltinResult => ({
  success: false,
  output: '',
  outputs: {},
  error
});

const isTrue = (value: string | undefined) =>
  value?.trim().toLowerCase() === 'true';

/** Artifacts are kept per run, for 7 days. */
const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function artifactsDir(runId: string): string {
  return secureciDir('artifacts', runId.replace(/[^\w.-]/g, '_'));
}

function pruneOldArtifacts(): void {
  const base = secureciDir('artifacts');
  let runs: string[];
  try {
    runs = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const run of runs) {
    const dir = path.join(base, run);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > ARTIFACT_RETENTION_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best effort
    }
  }
}

/**
 * GitHub's invalid artifact-name characters, plus anything that would let a
 * crafted name escape the per-run store (`/`, `\\`, `..`). The store path
 * is built from the name, so an unchecked name like `../../../.ssh` would
 * write onto the host even from a fully containerized job.
 */
function safeName(name: string): boolean {
  try {
    assertSafeArtifactName(name);
    return true;
  } catch {
    return false;
  }
}

function assertSafeArtifactName(name: string): void {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    /[\\/"<>|:*?\r\n]/.test(name)
  ) {
    throw new Error(
      `Invalid artifact name: "${name}". Artifact names cannot be empty or contain any of: \\ / " < > | : * ? or line breaks.`
    );
  }
}

/** `actions/upload-artifact`. */
export async function uploadArtifact(
  fsys: StepFileSystem,
  inputs: Record<string, string>,
  runId: string
): Promise<BuiltinResult> {
  const name = inputs.name || 'artifact';
  try {
    assertSafeArtifactName(name);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (!inputs.path) return fail('Input required and not supplied: path');
  const { root, files } = await collectFiles(fsys, inputs.path, {
    includeHidden: isTrue(inputs['include-hidden-files'])
  });

  if (files.length === 0) {
    const mode = (inputs['if-no-files-found'] || 'warn').toLowerCase();
    const message = `No files were found with the provided path: ${inputs.path.trim()}. No artifacts will be uploaded.`;
    if (mode === 'error') return fail(message);
    return { ...ok(''), ...(mode === 'ignore' ? {} : { warning: message }) };
  }

  pruneOldArtifacts();
  const target = path.join(artifactsDir(runId), name);
  if (fs.existsSync(target)) {
    if (!isTrue(inputs.overwrite)) {
      return fail(
        `An artifact with the name "${name}" already exists in this run; set overwrite: true to replace it`
      );
    }
    fs.rmSync(target, { recursive: true, force: true });
  }

  const digest = crypto.createHash('sha256');
  for (const file of files.sort((a, b) => a.logical.localeCompare(b.logical))) {
    const rel =
      fsys.path.relative(root, file.logical) ||
      fsys.path.basename(file.logical);
    copyFile(file.host, path.join(target, ...rel.split('/')));
    digest.update(rel).update(fs.readFileSync(file.host));
  }
  const id = String(
    parseInt(
      crypto.createHash('sha1').update(target).digest('hex').slice(0, 8),
      16
    )
  );
  return ok(
    `Uploaded ${files.length} file(s) as artifact "${name}" to ${target}`,
    {
      'artifact-id': id,
      'artifact-url': '',
      'artifact-digest': digest.digest('hex')
    }
  );
}

/** `actions/download-artifact`. */
export async function downloadArtifact(
  fsys: StepFileSystem,
  inputs: Record<string, string>,
  runId: string
): Promise<BuiltinResult> {
  const store = artifactsDir(runId);
  const available = fs.existsSync(store) ? fs.readdirSync(store).sort() : [];
  const dest = resolveLogical(fsys, inputs.path || '.');

  let names: string[];
  if (inputs.name) {
    try {
      assertSafeArtifactName(inputs.name);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (!available.includes(inputs.name)) {
      return fail(`Artifact not found for name: ${inputs.name}`);
    }
    names = [inputs.name];
  } else {
    const pattern = inputs.pattern ? globToRegExp(inputs.pattern) : undefined;
    names = available.filter(
      (name) => safeName(name) && (!pattern || pattern.test(name))
    );
  }

  // A single named artifact, or merge-multiple, goes straight into path;
  // otherwise each artifact gets its own <path>/<name> directory.
  const flat = !!inputs.name || isTrue(inputs['merge-multiple']);
  await fsys.writeInto(dest, (hostDest) => {
    for (const name of names) {
      copyTree(
        path.join(store, name),
        flat ? hostDest : path.join(hostDest, name)
      );
    }
  });
  return ok(
    `Downloaded ${names.length} artifact(s) to ${dest}${names.length ? `: ${names.join(', ')}` : ''}`,
    { 'download-path': dest }
  );
}

interface CacheEntry {
  dir: string;
  key: string;
  created: number;
}

function cacheScope(repository: string): string {
  return secureciDir(
    'step-cache',
    repository.replace(/[^\w.-]+/g, '_') || 'default'
  );
}

/** Caches are versioned by their paths, as on GitHub. */
function cacheVersion(paths: string): string {
  return crypto
    .createHash('sha256')
    .update(
      paths
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n')
    )
    .digest('hex');
}

function cacheEntryDir(scope: string, version: string, key: string): string {
  return path.join(
    scope,
    crypto.createHash('sha256').update(`${version}\0${key}`).digest('hex')
  );
}

function findCache(
  scope: string,
  version: string,
  key: string,
  restoreKeys: string[]
): CacheEntry | undefined {
  const exact = cacheEntryDir(scope, version, key);
  if (fs.existsSync(path.join(exact, 'meta.json'))) {
    return { dir: exact, key, created: 0 };
  }
  let entries: CacheEntry[] = [];
  try {
    entries = fs
      .readdirSync(scope)
      .map((name) => {
        try {
          const meta = JSON.parse(
            fs.readFileSync(path.join(scope, name, 'meta.json'), 'utf8')
          );
          return meta.version === version
            ? {
                dir: path.join(scope, name),
                key: meta.key,
                created: meta.created
              }
            : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((entry): entry is CacheEntry => !!entry);
  } catch {
    return undefined;
  }
  for (const prefix of restoreKeys) {
    const match = entries
      .filter((entry) => entry.key.startsWith(prefix))
      .sort((a, b) => b.created - a.created)[0];
    if (match) return match;
  }
  return undefined;
}

/** Where a cached file is stored: relative to the workspace, home, or /. */
function cachedLocation(fsys: StepFileSystem, logical: string): string {
  const p = fsys.path;
  for (const [area, base] of [
    ['workspace', fsys.workspace],
    ['home', fsys.home]
  ] as const) {
    const rel = p.relative(base, logical);
    if (rel && !rel.startsWith('..') && !p.isAbsolute(rel))
      return `${area}/${rel}`;
  }
  return `root/${logical.replace(/^\/+/, '')}`;
}

async function restoreCache(
  fsys: StepFileSystem,
  entryDir: string
): Promise<void> {
  const files = path.join(entryDir, 'files');
  for (const [area, base] of [
    ['workspace', fsys.workspace],
    ['home', fsys.home],
    ['root', '/']
  ] as const) {
    const from = path.join(files, area);
    if (fs.existsSync(from)) {
      await fsys.writeInto(base, (hostDir) => copyTree(from, hostDir));
    }
  }
}

async function saveCache(
  fsys: StepFileSystem,
  scope: string,
  key: string,
  paths: string
): Promise<BuiltinResult> {
  const version = cacheVersion(paths);
  const dir = cacheEntryDir(scope, version, key);
  if (fs.existsSync(path.join(dir, 'meta.json'))) {
    return ok(`Cache for key "${key}" already exists; not saving`);
  }
  const { files } = await collectFiles(fsys, paths, { includeHidden: true });
  if (files.length === 0) {
    return {
      ...ok(''),
      warning:
        'Path Validation Error: Path(s) specified in the action for caching do(es) not exist, hence no cache is being saved.'
    };
  }
  // Unique per save: jobs running at once may save the same key.
  const staging = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  for (const file of files) {
    copyFile(
      file.host,
      path.join(
        staging,
        'files',
        ...cachedLocation(fsys, file.logical).split('/')
      )
    );
  }
  fs.writeFileSync(
    path.join(staging, 'meta.json'),
    JSON.stringify({ key, version, created: Date.now() })
  );
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.renameSync(staging, dir);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    // Another job saved this key meanwhile; cache entries are immutable.
    if (fs.existsSync(path.join(dir, 'meta.json'))) {
      return ok(`Cache for key "${key}" already exists; not saving`);
    }
    throw error;
  }
  return ok(`Cache saved with key: ${key} (${files.length} file(s))`);
}

/** `actions/cache`, `actions/cache/restore` and `actions/cache/save`. */
export async function runCacheAction(
  kind: 'cache' | 'cache-restore' | 'cache-save',
  fsys: StepFileSystem,
  inputs: Record<string, string>,
  repository: string
): Promise<BuiltinResult> {
  const key = (inputs.key || '').trim();
  const paths = inputs.path || '';
  if (!key) return fail('Input required and not supplied: key');
  if (!paths.trim()) return fail('Input required and not supplied: path');
  const scope = cacheScope(repository);

  if (kind === 'cache-save') return saveCache(fsys, scope, key, paths);

  const restoreKeys = (inputs['restore-keys'] || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const found = findCache(scope, cacheVersion(paths), key, restoreKeys);
  const exact = found?.key === key;

  if (!found && isTrue(inputs['fail-on-cache-miss'])) {
    return fail(
      `Failed to restore cache entry. Exiting as fail-on-cache-miss is set. Input key: ${key}`
    );
  }
  if (found && !isTrue(inputs['lookup-only'])) {
    await restoreCache(fsys, found.dir);
  }

  const outputs: Record<string, string> = { 'cache-primary-key': key };
  if (found) {
    outputs['cache-hit'] = String(exact);
    outputs['cache-matched-key'] = found.key;
  }
  const result = ok(
    found
      ? `Cache ${isTrue(inputs['lookup-only']) ? 'found' : 'restored'} from key: ${found.key}`
      : `Cache not found for input keys: ${[key, ...restoreKeys].join(', ')}`,
    outputs
  );
  if (kind === 'cache' && !exact && !isTrue(inputs['lookup-only'])) {
    result.post = (postFs) => saveCache(postFs, scope, key, paths);
  }
  return result;
}
