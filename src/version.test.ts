import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readVersion } from './version';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-version-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readVersion', () => {
  it('prefers the version embedded at bundle time (standalone binary)', () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ version: '1.0.0' })
    );
    expect(readVersion({ embedded: '9.9.9', packageDir: dir })).toBe('9.9.9');
  });

  it('reads package.json next to dist/ otherwise (npm install)', () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ version: '1.2.3' })
    );
    expect(readVersion({ embedded: undefined, packageDir: dir })).toBe('1.2.3');
  });

  it('falls back to 0.0.0 when neither is available', () => {
    expect(readVersion({ embedded: undefined, packageDir: tmpDir() })).toBe(
      '0.0.0'
    );
  });

  it("defaults to this package's own version", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
    );
    expect(readVersion()).toBe(pkg.version);
  });
});
