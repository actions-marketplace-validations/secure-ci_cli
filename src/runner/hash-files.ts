import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Convert a glob (`**`, `*`, `?`) to a regex over `/`-separated paths
 * relative to the workspace.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

function walk(dir: string, root: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, files);
    } else if (entry.isFile()) {
      files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/**
 * GitHub's `hashFiles(...patterns)`: SHA-256 over the concatenated SHA-256
 * digests of every matching file (sorted by path), or '' when nothing
 * matches. Patterns are relative to the workspace; `!pattern` excludes.
 */
export function hashFiles(workspace: string, patterns: string[]): string {
  const includes: RegExp[] = [];
  const excludes: RegExp[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/^\.\//, '');
    if (!pattern) continue;
    if (pattern.startsWith('!')) {
      excludes.push(globToRegExp(pattern.slice(1).replace(/^\.\//, '')));
    } else {
      includes.push(globToRegExp(pattern));
    }
  }

  const all: string[] = [];
  walk(workspace, workspace, all);
  const matched = all
    .filter(
      (file) =>
        includes.some((re) => re.test(file)) &&
        !excludes.some((re) => re.test(file))
    )
    .map((file) => path.join(workspace, file))
    .sort();

  if (matched.length === 0) return '';

  const combined = crypto.createHash('sha256');
  for (const file of matched) {
    combined.update(
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest()
    );
  }
  return combined.digest('hex');
}
