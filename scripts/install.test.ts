import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// install.sh is POSIX sh; these tests run it against a fake release served
// from file:// with stubbed `uname` and `gh`, so no network is needed.
const SCRIPT = path.resolve(__dirname, '..', 'install.sh');
const ASSETS = [
  'secureci-linux-x64',
  'secureci-linux-arm64',
  'secureci-darwin-x64',
  'secureci-darwin-arm64'
];

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake binary: a shell script that prints which asset and version it is. */
function fakeBinary(asset: string, version: string): string {
  return `#!/bin/sh\necho "${version} ${asset}"\n`;
}

/** Write a release (assets + SHA256SUMS) into `dir`. */
function writeRelease(
  dir: string,
  version: string,
  tamper?: string,
  omit?: string
): void {
  fs.mkdirSync(dir, { recursive: true });
  const sums: string[] = [];
  for (const asset of ASSETS) {
    const content = fakeBinary(asset, version);
    fs.writeFileSync(
      path.join(dir, asset),
      asset === tamper ? content + 'evil\n' : content
    );
    if (asset !== omit)
      sums.push(
        `${createHash('sha256').update(content).digest('hex')}  ${asset}`
      );
  }
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.join('\n') + '\n');
}

interface Setup {
  os?: string;
  arch?: string;
  ghAuth?: number;
  ghVerify?: number;
  tamper?: string;
  omit?: string;
  env?: Record<string, string>;
}

function run(setup: Setup = {}) {
  const releases = tmp('secureci-releases-');
  writeRelease(
    path.join(releases, 'latest', 'download'),
    '9.9.9',
    setup.tamper,
    setup.omit
  );
  writeRelease(path.join(releases, 'download', 'v1.2.3'), '1.2.3');

  const bin = tmp('secureci-fakebin-');
  fs.writeFileSync(
    path.join(bin, 'uname'),
    `#!/bin/sh\ncase "$1" in -s) echo "${setup.os ?? 'Linux'}" ;; -m) echo "${setup.arch ?? 'x86_64'}" ;; *) echo unknown ;; esac\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\ncase "$1 $2" in\n  "auth status") exit ${setup.ghAuth ?? 1} ;;\n  "attestation verify") exit ${setup.ghVerify ?? 0} ;;\nesac\nexit 2\n`,
    { mode: 0o755 }
  );

  const home = tmp('secureci-home-');
  const installDir = path.join(home, 'bin');
  const result = spawnSync('sh', [SCRIPT], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      SECURECI_DOWNLOAD_BASE: `file://${releases}`,
      SECURECI_INSTALL_DIR: installDir,
      ...setup.env
    }
  });
  const installed = path.join(installDir, 'secureci');
  const output = result.stdout + result.stderr;
  return { status: result.status, output, installed, home };
}

describe('install.sh', () => {
  it('installs the latest Linux x64 binary, verified against SHA256SUMS', () => {
    const r = run();
    expect(r.status, r.output).toBe(0);
    expect(fs.readFileSync(r.installed, 'utf8')).toBe(
      fakeBinary('secureci-linux-x64', '9.9.9')
    );
    expect(fs.statSync(r.installed).mode & 0o111).not.toBe(0);
    expect(r.output).toContain('9.9.9 secureci-linux-x64');
  });

  it.each([
    ['Linux', 'aarch64', 'secureci-linux-arm64'],
    ['Linux', 'arm64', 'secureci-linux-arm64'],
    ['Linux', 'amd64', 'secureci-linux-x64'],
    ['Darwin', 'arm64', 'secureci-darwin-arm64'],
    ['Darwin', 'x86_64', 'secureci-darwin-x64']
  ])('picks the asset for %s %s', (osName, arch, asset) => {
    const r = run({ os: osName, arch });
    expect(r.status, r.output).toBe(0);
    expect(fs.readFileSync(r.installed, 'utf8')).toBe(
      fakeBinary(asset, '9.9.9')
    );
  });

  it('installs a specific version with SECURECI_VERSION (with or without a leading v)', () => {
    for (const version of ['1.2.3', 'v1.2.3']) {
      const r = run({ env: { SECURECI_VERSION: version } });
      expect(r.status, r.output).toBe(0);
      expect(fs.readFileSync(r.installed, 'utf8')).toBe(
        fakeBinary('secureci-linux-x64', '1.2.3')
      );
    }
  });

  it('defaults to ~/.local/bin', () => {
    const r = run({ env: { SECURECI_INSTALL_DIR: '' } });
    expect(r.status, r.output).toBe(0);
    expect(fs.existsSync(path.join(r.home, '.local', 'bin', 'secureci'))).toBe(
      true
    );
  });

  it('refuses a binary whose checksum does not match, and installs nothing', () => {
    const r = run({ tamper: 'secureci-linux-x64' });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/checksum mismatch/i);
    expect(fs.existsSync(r.installed)).toBe(false);
  });

  it('refuses a binary missing from SHA256SUMS', () => {
    const r = run({ omit: 'secureci-linux-x64' });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/not listed in SHA256SUMS/);
    expect(fs.existsSync(r.installed)).toBe(false);
  });

  it('points Windows users to the docs', () => {
    const r = run({ os: 'MINGW64_NT-10.0' });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/Windows/);
    expect(r.output).toContain(
      'https://secure-ci.dev/docs#standalone-binary-no-nodejs-needed'
    );
  });

  it('rejects an unsupported architecture', () => {
    const r = run({ arch: 'riscv64' });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/unsupported architecture: riscv64/i);
  });

  it('verifies build provenance when gh is signed in', () => {
    const r = run({ ghAuth: 0, ghVerify: 0 });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/provenance verified/i);
  });

  it('fails when gh is signed in and the attestation does not verify', () => {
    const r = run({ ghAuth: 0, ghVerify: 1 });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/attestation/i);
    expect(fs.existsSync(r.installed)).toBe(false);
  });

  it('installs without gh, and says how to verify provenance', () => {
    const r = run({ ghAuth: 1 });
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('gh attestation verify');
  });

  it('fails without gh when SECURECI_REQUIRE_ATTESTATION=1', () => {
    const r = run({ ghAuth: 1, env: { SECURECI_REQUIRE_ATTESTATION: '1' } });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(r.installed)).toBe(false);
  });
});
