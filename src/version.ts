import * as fs from 'fs';
import * as path from 'path';

/**
 * Set by the standalone-binary bundler (scripts/bundle.mjs), which defines it
 * at the top of the bundle. Undeclared (so `typeof` is 'undefined') in the
 * tsc build that npm installs.
 */
declare const __SECURECI_VERSION__: string | undefined;

const EMBEDDED_VERSION =
  typeof __SECURECI_VERSION__ === 'string' ? __SECURECI_VERSION__ : undefined;

/**
 * The CLI's version: embedded at bundle time in the standalone binary (where
 * package.json isn't on disk), else read from the package.json next to
 * `dist/`, else `0.0.0`.
 */
export function readVersion({
  embedded = EMBEDDED_VERSION,
  packageDir = path.join(__dirname, '..')
}: { embedded?: string; packageDir?: string } = {}): string {
  if (embedded) return embedded;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8')
    );
    return String(pkg.version);
  } catch {
    return '0.0.0';
  }
}
