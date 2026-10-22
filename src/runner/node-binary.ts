import * as fs from 'fs';
import * as path from 'path';

export const NODE_ON_PATH_REQUIRED =
  'JavaScript actions need Node.js on PATH when using the standalone binary. Install Node.js (or add a setup-node step), or install the CLI with npm.';

/**
 * Whether the CLI is running as a Node.js single executable application
 * (the standalone binary). `node:sea` only exists on Node 20.12+/21.7+;
 * older versions can't be a SEA, so a missing module means "no".
 */
export function isSea(
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  load: () => { isSea(): boolean } = () => require('node:sea')
): boolean {
  try {
    return load().isSea();
  } catch {
    return false;
  }
}

/**
 * The first executable `name` in `pathEnv` (like `command -v`). On Windows
 * the separator is `;` and each PATHEXT extension is tried too. `exclude`
 * skips one file (the standalone binary itself).
 */
export function findOnPath(
  name: string,
  pathEnv: string | undefined,
  {
    platform = process.platform,
    pathExt = process.env.PATHEXT,
    exclude
  }: { platform?: NodeJS.Platform; pathExt?: string; exclude?: string } = {}
): string | undefined {
  if (!pathEnv) return undefined;
  const windows = platform === 'win32';
  const exts = windows
    ? ['', ...(pathExt || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  for (const dir of pathEnv.split(windows ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (exclude && path.resolve(candidate) === path.resolve(exclude)) {
        continue;
      }
      if (isExecutableFile(candidate, windows)) return candidate;
    }
  }
  return undefined;
}

function isExecutableFile(file: string, windows: boolean): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!windows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `node` that runs JavaScript actions on the host. Normally the CLI's
 * own Node binary; inside the standalone binary `process.execPath` is the
 * CLI itself, so use `node` from the step's PATH instead (which also picks
 * up a Node.js that setup-node added to the job's PATH).
 */
export function hostNodeBinary({
  sea = isSea(),
  execPath = process.execPath,
  pathEnv,
  platform = process.platform
}: {
  sea?: boolean;
  execPath?: string;
  pathEnv: string | undefined;
  platform?: NodeJS.Platform;
}): { path: string } | { error: string } {
  if (!sea) return { path: execPath };
  const node = findOnPath('node', pathEnv, { platform, exclude: execPath });
  return node ? { path: node } : { error: NODE_ON_PATH_REQUIRED };
}
