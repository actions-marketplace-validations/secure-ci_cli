import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { orgScanArgs, orgScanEnv, runOrgScan, OrgScanDeps } from './org-scan';
import { ORG_SCAN_SCRIPT } from './org-scan-script';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('ORG_SCAN_SCRIPT', () => {
  it('is org-scan.sh, embedded (run `node scripts/gen-org-scan-script.mjs` after editing it)', () => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '..', 'org-scan.sh'),
      'utf8'
    );
    expect(ORG_SCAN_SCRIPT).toBe(file);
  });
});

describe('orgScanArgs', () => {
  it('passes the org last, after the options that are set', () => {
    expect(orgScanArgs('acme', {})).toEqual(['acme']);
    expect(
      orgScanArgs('acme', {
        repos: 'repos.txt',
        out: 'scan',
        contract: 'contracts/std.yml',
        includeForks: true
      })
    ).toEqual([
      '--repos',
      'repos.txt',
      '--out',
      'scan',
      '--contract',
      'contracts/std.yml',
      '--include-forks',
      'acme'
    ]);
  });
});

describe('orgScanEnv', () => {
  it('points the script at the standalone binary itself', () => {
    expect(
      orgScanEnv({ sea: true, execPath: '/usr/local/bin/secureci' })
    ).toEqual({ SECURECI: '/usr/local/bin/secureci' });
  });

  it('points the script at node and the CLI entry when installed with npm', () => {
    expect(
      orgScanEnv({
        sea: false,
        execPath: '/usr/bin/node',
        entry: '/lib/node_modules/@secureci/cli/dist/cli.js'
      })
    ).toEqual({
      SECURECI: '/usr/bin/node',
      SECURECI_ENTRY: '/lib/node_modules/@secureci/cli/dist/cli.js'
    });
  });
});

/** A fake child process that exits with `code` (or fails with `error`). */
function fakeSpawn(result: { code?: number; error?: NodeJS.ErrnoException }) {
  const calls: Array<{
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    script: string;
    mode: number;
  }> = [];
  const spawn: OrgScanDeps['spawn'] = (command, args, options) => {
    const child = new EventEmitter();
    const stat = fs.statSync(args[0]);
    calls.push({
      command,
      args,
      env: options.env,
      script: fs.readFileSync(args[0], 'utf8'),
      mode: stat.mode & 0o777
    });
    setImmediate(() => {
      if (result.error) child.emit('error', result.error);
      else child.emit('close', result.code ?? 0);
    });
    return child;
  };
  return { spawn, calls };
}

function deps(spawn: OrgScanDeps['spawn']): OrgScanDeps {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'org-scan-cli-'));
  tmpDirs.push(tmp);
  return {
    spawn,
    tmpdir: () => tmp,
    sea: false,
    execPath: '/usr/bin/node',
    entry: '/opt/secureci/dist/cli.js',
    env: { PATH: '/usr/bin', GITHUB_TOKEN: 't' }
  };
}

describe('runOrgScan', () => {
  it('runs the embedded script with bash, then deletes it', async () => {
    const { spawn, calls } = fakeSpawn({ code: 0 });
    const d = deps(spawn);
    const code = await runOrgScan('acme', { repos: 'r.txt' }, d);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe('bash');
    expect(call.args.slice(1)).toEqual(['--repos', 'r.txt', 'acme']);
    expect(call.script).toBe(ORG_SCAN_SCRIPT);
    expect(call.mode).toBe(0o700);
    expect(call.env).toMatchObject({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 't',
      SECURECI: '/usr/bin/node',
      SECURECI_ENTRY: '/opt/secureci/dist/cli.js'
    });
    expect(fs.existsSync(call.args[0])).toBe(false);
  });

  it("returns the script's exit status", async () => {
    const { spawn } = fakeSpawn({ code: 2 });
    expect(await runOrgScan('acme', {}, deps(spawn))).toBe(2);
  });

  it('explains how to get bash when it is missing', async () => {
    const error = Object.assign(new Error('spawn bash ENOENT'), {
      code: 'ENOENT'
    });
    const { spawn, calls } = fakeSpawn({ error });
    await expect(runOrgScan('acme', {}, deps(spawn))).rejects.toThrow(
      /needs bash.*Git Bash or WSL/
    );
    expect(fs.existsSync(calls[0].args[0])).toBe(false);
  });
});
