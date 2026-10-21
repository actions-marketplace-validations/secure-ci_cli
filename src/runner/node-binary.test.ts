import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findOnPath,
  hostNodeBinary,
  isSea,
  NODE_ON_PATH_REQUIRED
} from './node-binary';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-node-bin-'));
  tmpDirs.push(dir);
  return dir;
}
function touch(file: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.chmodSync(file, mode);
  return file;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('isSea', () => {
  it('is false when the CLI runs under a regular node binary', () => {
    expect(isSea()).toBe(false);
  });

  it('asks node:sea when the module is available', () => {
    expect(isSea(() => ({ isSea: () => true }))).toBe(true);
    expect(isSea(() => ({ isSea: () => false }))).toBe(false);
  });

  it('is false on Node versions without node:sea', () => {
    expect(
      isSea(() => {
        throw new Error("Cannot find module 'node:sea'");
      })
    ).toBe(false);
  });
});

describe('findOnPath', () => {
  it('returns the first executable match in PATH order', () => {
    const a = tmpDir();
    const b = tmpDir();
    const second = touch(path.join(b, 'node'));
    touch(path.join(a, 'other'));
    expect(
      findOnPath('node', [a, b].join(path.delimiter), { platform: 'linux' })
    ).toBe(second);

    const first = touch(path.join(a, 'node'));
    expect(
      findOnPath('node', [a, b].join(path.delimiter), { platform: 'linux' })
    ).toBe(first);
  });

  it('skips directories and (on POSIX) non-executable files', () => {
    const a = tmpDir();
    const b = tmpDir();
    fs.mkdirSync(path.join(a, 'node'));
    const c = tmpDir();
    const found = touch(path.join(c, 'node'));
    const dirs = [a, b, c].join(path.delimiter);
    if (process.platform !== 'win32') {
      touch(path.join(b, 'node'), 0o644);
    }
    expect(findOnPath('node', dirs, { platform: 'linux' })).toBe(found);
  });

  it('tries PATHEXT extensions on Windows, with ; as the separator', () => {
    const a = tmpDir();
    const b = tmpDir();
    const exe = touch(path.join(b, 'node.EXE'));
    expect(
      findOnPath('node', `${a};${b}`, {
        platform: 'win32',
        pathExt: '.COM;.EXE;.CMD'
      })
    ).toBe(exe);
  });

  it('returns undefined when PATH is empty or has no match', () => {
    expect(findOnPath('node', undefined, { platform: 'linux' })).toBe(
      undefined
    );
    expect(findOnPath('node', '', { platform: 'linux' })).toBe(undefined);
    expect(findOnPath('node', tmpDir(), { platform: 'linux' })).toBe(undefined);
  });
});

describe('hostNodeBinary', () => {
  it("uses the CLI's own Node binary outside a standalone binary", () => {
    expect(
      hostNodeBinary({
        sea: false,
        execPath: '/opt/node/bin/node',
        pathEnv: ''
      })
    ).toEqual({ path: '/opt/node/bin/node' });
  });

  it('uses node from the step PATH inside a standalone binary', () => {
    const dir = tmpDir();
    const node = touch(path.join(dir, 'node'));
    expect(
      hostNodeBinary({
        sea: true,
        execPath: '/usr/local/bin/secureci',
        pathEnv: dir,
        platform: 'linux'
      })
    ).toEqual({ path: node });
  });

  it('never picks the standalone binary itself, even if it is named node', () => {
    const dir = tmpDir();
    const self = touch(path.join(dir, 'node'));
    expect(
      hostNodeBinary({
        sea: true,
        execPath: self,
        pathEnv: dir,
        platform: 'linux'
      })
    ).toEqual({ error: NODE_ON_PATH_REQUIRED });

    const other = tmpDir();
    const node = touch(path.join(other, 'node'));
    expect(
      hostNodeBinary({
        sea: true,
        execPath: self,
        pathEnv: [dir, other].join(path.delimiter),
        platform: 'linux'
      })
    ).toEqual({ path: node });
  });

  it('explains that Node.js is needed on PATH when none is found', () => {
    const result = hostNodeBinary({
      sea: true,
      execPath: '/usr/local/bin/secureci',
      pathEnv: tmpDir(),
      platform: 'linux'
    });
    expect(result).toEqual({ error: NODE_ON_PATH_REQUIRED });
    expect(NODE_ON_PATH_REQUIRED).toContain(
      'JavaScript actions need Node.js on PATH when using the standalone binary'
    );
  });
});
