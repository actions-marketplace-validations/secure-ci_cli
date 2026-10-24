import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'child_process';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// `validate` and `inventory` query the GitHub Advisory Database (#47).
// Point the API at a closed local port so no test reaches the real one
// unless it sets GITHUB_API_URL itself.
process.env.GITHUB_API_URL = 'http://127.0.0.1:9';

// Black-box integration tests: invoke the built CLI binary as a subprocess,
// since cli.ts calls `program.parse()`/`process.exit()` at module scope and
// isn't structured for in-process unit testing (see vitest.config.mts, which
// deliberately excludes src/cli.ts from coverage for the same reason).
describe('secureci validate --contract', () => {
  const cliPath = path.join(__dirname, '..', 'dist', 'cli.js');
  let tempDir: string;
  let workflow: string;
  let action: string;

  function write(name: string, content: string): string {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, content);
    return file;
  }

  function run(args: string[]): {
    status: number;
    stdout: string;
    stderr: string;
  } {
    try {
      const stdout = execFileSync('node', [cliPath, ...args], {
        encoding: 'utf-8'
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  beforeAll(() => {
    execFileSync('npx', ['tsc'], { cwd: path.join(__dirname, '..') });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-cli-contract-'));

    workflow = write(
      'caller.yml',
      [
        'name: Caller Pipeline',
        'on: push',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: org/security-scan@v1.3.0',
        '      - run: echo "build"',
        '      - uses: org/deploy@v2'
      ].join('\n')
    );

    action = write(
      'action.yml',
      [
        'name: My Action',
        'description: does a thing',
        'runs:',
        '  using: node20',
        '  main: index.js'
      ].join('\n')
    );
  }, 60_000);

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('passes when the workflow satisfies the contract', () => {
    const contract = write(
      'good-contract.yml',
      [
        'required:',
        '  - uses: org/security-scan',
        '    min-version: v1.2.0',
        '  - uses: org/deploy',
        'forbidden:',
        '  - uses: org/legacy-deploy'
      ].join('\n')
    );

    const result = run(['validate', workflow, '--contract', contract]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validation passed');
  });

  it('prints warnings at warn level even when a file fails validation', () => {
    const file = write(
      'failing-with-warning.yml',
      [
        'name: Mixed',
        'on: pull_request_target',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo "${{ github.event.pull_request.title }}"'
      ].join('\n')
    );

    const result = run(['validate', file, '--offline']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[ERROR]   [ERROR] jobs.a.steps[0].run');
    expect(result.stderr).toContain(
      '[WARN]   [WARNING] on.pull_request_target'
    );
    expect(result.stderr).not.toContain('[ERROR]   [WARNING]');
  });

  it('fails with a clear message when a required action is missing', () => {
    const contract = write(
      'missing-contract.yml',
      'required:\n  - uses: org/never-used\n'
    );

    const result = run(['validate', workflow, '--contract', contract]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Required action "org/never-used" was not found'
    );
  });

  it('fails when required actions are out of order under strict ordering', () => {
    const contract = write(
      'strict-contract.yml',
      'ordering: strict\nrequired:\n  - uses: org/deploy\n  - uses: org/security-scan\n'
    );

    const result = run(['validate', workflow, '--contract', contract]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ordering: strict');
  });

  it('fails when a forbidden action is present', () => {
    const contract = write(
      'forbidden-contract.yml',
      'forbidden:\n  - uses: org/security-scan\n'
    );

    const result = run(['validate', workflow, '--contract', contract]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Forbidden action "org/security-scan"');
  });

  it('turns the permissions warning into a single contract error (#45)', () => {
    const contract = write(
      'permissions-contract.yml',
      'permissions:\n  required: true\n'
    );

    const result = run([
      'validate',
      workflow,
      '--contract',
      contract,
      '--format',
      'json'
    ]);

    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.errors).toEqual([
      expect.objectContaining({ path: 'permissions', severity: 'error' })
    ]);
  });

  it('fails when --contract is used against an action file', () => {
    const contract = write(
      'action-contract.yml',
      'required:\n  - uses: org/x\n'
    );

    const result = run(['validate', action, '--contract', contract]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only apply to workflow files');
  });

  it('fails with a clear error when the contract file does not exist', () => {
    const result = run([
      'validate',
      workflow,
      '--contract',
      path.join(tempDir, 'nonexistent.yml')
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Contract file not found');
  });

  it('still runs syntax validation alongside the contract', () => {
    // Valid enough to parse (has name + jobs), but missing the required
    // "on" trigger, so the pre-existing syntax validator should still fail
    // it even though the (empty) contract itself is satisfied.
    const missingTrigger = write(
      'missing-trigger.yml',
      [
        'name: Bad Workflow',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo hi'
      ].join('\n')
    );
    const contract = write('noop-contract.yml', '{}\n');

    const result = run(['validate', missingTrigger, '--contract', contract]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Validating workflow');
    expect(result.stderr).toContain('Workflow trigger (on) is required');
  });
});

describe('secureci commands', () => {
  const root = path.join(__dirname, '..');
  const cliPath = path.join(root, 'dist', 'cli.js');
  let tempDir: string;

  function run(
    args: string[],
    cwd = root,
    env: NodeJS.ProcessEnv = process.env
  ): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync('node', [cliPath, ...args], {
        encoding: 'utf-8',
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return { status: 0, stdout, stderr: '' };
    } catch (error) {
      const e = error as { status: number; stdout: string; stderr: string };
      return { status: e.status, stdout: e.stdout, stderr: e.stderr };
    }
  }

  beforeAll(() => {
    execFileSync('npx', ['tsc'], { cwd: root });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-cli-'));
    fs.mkdirSync(path.join(tempDir, '.github', 'workflows'), {
      recursive: true
    });
    fs.writeFileSync(
      path.join(tempDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: Hello CI',
        'on: push',
        'jobs:',
        '  hello:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo "hello ${{ inputs.who }}"'
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tempDir, 'secret.yml'),
      [
        'name: Secret',
        'on: push',
        'jobs:',
        '  check:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: test "$T" = "from-env" && echo secret matched',
        '        env:',
        '          T: ${{ secrets.MY_TOKEN }}'
      ].join('\n')
    );
  }, 60_000);

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports the version from package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf-8')
    );
    const result = run(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it('names itself secureci and lists its commands in help', () => {
    const result = run(['--help']);
    expect(result.stdout).toContain('Usage: secureci');
    for (const command of [
      'run',
      'validate',
      'list',
      'init',
      'config',
      'cache',
      'pin'
    ]) {
      expect(result.stdout).toMatch(new RegExp(`\\n\\s+${command}\\b`));
    }
  });

  it('prints help and exits non-zero when no command is given', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('Usage: secureci');
  });

  it('runs a workflow with secureci run', () => {
    const result = run(
      [
        'run',
        '.github/workflows/ci.yml',
        '--container-runtime',
        'host',
        '--input',
        'who=world'
      ],
      tempDir
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('hello world');
    // Signposts that this really executed, and names the alternatives.
    expect(result.stdout + result.stderr).toMatch(/not a dry run/i);
    expect(result.stdout + result.stderr).toContain('secureci validate');
  });

  it('reads a bare --secret NAME from the environment', () => {
    const args = [
      'run',
      'secret.yml',
      '--container-runtime',
      'host',
      '--secret',
      'MY_TOKEN'
    ];
    const ok = run(args, tempDir, { ...process.env, MY_TOKEN: 'from-env' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('secret matched');

    const env = { ...process.env };
    delete env.MY_TOKEN;
    const missing = run(args, tempDir, env);
    expect(missing.status).not.toBe(0);
    expect(missing.stdout + missing.stderr).toContain(
      'environment variable MY_TOKEN is not set'
    );
  });

  it('keeps every value of repeated --input/--secret/--env/--var flags', () => {
    fs.writeFileSync(
      path.join(tempDir, 'repeat.yml'),
      [
        'name: Repeat',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: test "${{ secrets.S1 }}${{ secrets.S2 }}${{ secrets.S3 }}|$E1$E2$E3|${{ inputs.i1 }}${{ inputs.i2 }}|${{ vars.v1 }}${{ vars.v2 }}" = "abc|xyz|12|34" && echo all values arrived'
      ].join('\n')
    );
    const result = run(
      [
        'run',
        'repeat.yml',
        '--container-runtime',
        'host',
        '--secret',
        'S1=a',
        '--secret',
        'S2=b',
        'S3',
        '--env',
        'E1=x',
        '--env',
        'E2=y',
        'E3',
        '--input',
        'i1=1',
        '--input',
        'i2=2',
        '--var',
        'v1=3',
        '--var',
        'v2=4'
      ],
      tempDir,
      { ...process.env, S3: 'c', E3: 'z' }
    );
    expect(result.stdout + result.stderr).toContain('all values arrived');
  });

  describe('--env-file, --secret-file, --input-file and --var-file', () => {
    let dir: string;
    let home: string;

    function writeFile(name: string, content: string, mode = 0o600): string {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      fs.chmodSync(file, mode);
      return name;
    }

    beforeAll(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-cli-files-'));
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-cli-home-'));
      fs.writeFileSync(
        path.join(dir, 'files.yml'),
        [
          'name: Files',
          'on: workflow_dispatch',
          'jobs:',
          '  a:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: |',
          '          echo "E1=$E1 E2=$E2 E3=$E3"',
          '          echo "I=${{ inputs.who }} V=${{ vars.colour }} V2=${{ vars.size }}"',
          '          echo "S=${{ secrets.TOKEN }}"',
          '          test "$ML" = "$(printf \'line one\\nline two\')" && echo multi-line ok',
          '        env:',
          '          ML: ${{ secrets.MULTI }}'
        ].join('\n')
      );
    });

    afterAll(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    const runIn = (args: string[]): ReturnType<typeof run> =>
      run(['run', 'files.yml', '--container-runtime', 'host', ...args], dir, {
        ...process.env,
        HOME: home
      });

    it('feeds file values to steps, files in order, flags on top, secrets masked', () => {
      writeFile('a.env', 'export E1=a1\nE2="a2 # kept"\nE3=a3 # comment\n');
      writeFile('b.env', 'E3=b3\r\n');
      writeFile(
        '.secrets',
        'TOKEN="tok-from-file-123"\nMULTI="line one\nline two"\n'
      );
      writeFile('inputs.env', "who='file who'\n");
      writeFile('vars.env', 'colour=blue\nsize=small\n');

      const result = runIn([
        '--env-file',
        'a.env',
        '--env-file',
        'b.env',
        '--env',
        'E1=flag1',
        '--secret-file',
        '.secrets',
        '--input-file',
        'inputs.env',
        '--var-file',
        'vars.env',
        '--var',
        'size=large'
      ]);
      const out = result.stdout + result.stderr;
      expect(result.status).toBe(0);
      expect(out).toContain('E1=flag1 E2=a2 # kept E3=b3');
      expect(out).toContain('I=file who V=blue V2=large');
      expect(out).toContain('S=***');
      expect(out).not.toContain('tok-from-file-123');
      expect(out).toContain('multi-line ok');
      expect(out).not.toMatch(/readable by other users/);
    });

    it('fails clearly on a missing file', () => {
      const result = runIn(['--secret-file', 'missing.secrets']);
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(
        '--secret-file: file not found: missing.secrets'
      );
    });

    it('reports an invalid line with file:line and without its value', () => {
      writeFile('bad.secrets', 'GOOD=1\nsupersecretvalue\n');
      const result = runIn(['--secret-file', 'bad.secrets']);
      const out = result.stdout + result.stderr;
      expect(result.status).not.toBe(0);
      expect(out).toContain('bad.secrets:2: expected KEY=value');
      expect(out).not.toContain('supersecretvalue');
    });

    it('warns when a secret file is readable by other users', () => {
      writeFile('loose.secrets', 'TOKEN=loose-secret-value\n', 0o644);
      // spawnSync: the warning goes to stderr, which run() drops on success.
      const result = spawnSync(
        'node',
        [
          cliPath,
          'run',
          'files.yml',
          '--container-runtime',
          'host',
          '--secret-file',
          'loose.secrets'
        ],
        { cwd: dir, encoding: 'utf-8', env: { ...process.env, HOME: home } }
      );
      const out = result.stdout + result.stderr;
      expect(out).toContain('loose.secrets is readable by other users');
      expect(out).not.toContain('loose-secret-value');
    });

    it('uses config defaults unless a file flag is given', () => {
      writeFile('config.env', 'E1=from-config\n');
      writeFile('flag.env', 'E1=from-flag\n');
      const env = { ...process.env, HOME: home };
      expect(
        run(['config', 'set', 'env-file', 'config.env'], dir, env).status
      ).toBe(0);
      try {
        expect(runIn([]).stdout).toContain('E1=from-config');
        expect(runIn(['--env-file', 'flag.env']).stdout).toContain(
          'E1=from-flag'
        );
      } finally {
        run(['config', 'unset', 'env-file'], dir, env);
      }
      expect(run(['config', 'set', 'secret-file', ''], dir, env).status).toBe(
        1
      );
    });
  });

  it('dry-runs a workflow with secureci run --dry-run', () => {
    const result = run(
      ['run', '.github/workflows/ci.yml', '--dry-run'],
      tempDir
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run completed successfully');
    expect(result.stdout).not.toContain('hello world');
    // No "really executing" banner on the dry-run path.
    expect(result.stdout + result.stderr).not.toMatch(/not a dry run/i);
  });

  describe('run --matrix (#50)', () => {
    const matrixWf = () => {
      const file = path.join(tempDir, 'matrix.yml');
      fs.writeFileSync(
        file,
        [
          'name: Matrix',
          'on: push',
          'jobs:',
          '  test:',
          '    runs-on: ubuntu-latest',
          '    strategy:',
          '      matrix:',
          '        node: [18, 20]',
          '        image: ["node:18-alpine", "node:20-alpine"]',
          '    steps:',
          '      - run: echo "combo ${{ matrix.node }} ${{ matrix.image }}"',
          '  lint:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: echo lint'
        ].join('\n')
      );
      return file;
    };

    it('dry-runs only the selected combinations (split on the first colon)', () => {
      const result = run(
        [
          'run',
          matrixWf(),
          '--dry-run',
          '--job',
          'test',
          '--matrix',
          'node:20',
          '--matrix',
          'image:node:20-alpine'
        ],
        tempDir
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('node: 20, image: node:20-alpine');
      expect(result.stdout).not.toContain('node: 18');
      expect(result.stdout).not.toContain('Job: lint');
    });

    it('runs only the selected combinations', () => {
      const result = run(
        [
          'run',
          matrixWf(),
          '--container-runtime',
          'host',
          '--job',
          'test',
          '--matrix',
          'node:18',
          '--matrix',
          'image:node:18-alpine'
        ],
        tempDir
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('combo 18 node:18-alpine');
      expect(result.stdout).not.toContain('combo 20');
    });

    it('exits non-zero, listing the combinations, when none matches', () => {
      for (const extra of [['--dry-run'], ['--container-runtime', 'host']]) {
        const result = run(
          ['run', matrixWf(), ...extra, '--matrix', 'node:16'],
          tempDir
        );
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'No matrix combination of job "test" matches --matrix node:16'
        );
        expect(result.stderr).toContain('node: 20, image: node:20-alpine');
      }
    });

    it('rejects a --matrix argument without a colon', () => {
      const result = run(
        ['run', matrixWf(), '--dry-run', '--matrix', 'node=20'],
        tempDir
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Invalid --matrix argument "node=20": expected key:value'
      );
    });
  });

  it('prints and clears the action cache with secureci cache', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-cache-home-'));
    const env = { ...process.env, HOME: home };
    const cacheDir = path.join(home, '.secureci', 'actions-cache');
    fs.mkdirSync(path.join(cacheDir, 'org', 'act'), { recursive: true });

    expect(run(['cache', 'path'], tempDir, env).stdout).toContain(cacheDir);
    expect(run(['cache', 'clear'], tempDir, env).status).toBe(0);
    expect(fs.existsSync(cacheDir)).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('validate --format json and sarif are machine-readable', () => {
    const good = path.join(tempDir, '.github', 'workflows', 'ci.yml');
    const json = run(['validate', good, '--format', 'json']);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    // The workflow declares no permissions: a warning, which doesn't fail
    // validation (#45).
    expect(parsed).toMatchObject({
      valid: true,
      errors: [{ path: 'permissions', severity: 'warning' }]
    });
    // Only the JSON object is printed, nothing else.
    expect(json.stdout.trim().startsWith('{')).toBe(true);

    const goodSarif = run(['validate', good, '--format', 'sarif']);
    expect(goodSarif.status).toBe(0);
    expect(JSON.parse(goodSarif.stdout).runs[0].results).toEqual([
      expect.objectContaining({
        ruleId: 'secureci/permissions',
        level: 'warning'
      })
    ]);

    const bad = path.join(tempDir, 'bad.yml');
    fs.writeFileSync(
      bad,
      [
        'name: Bad',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo hi',
        '        if: nope()'
      ].join('\n')
    );
    const sarif = run(['validate', bad, '--format', 'sarif']);
    expect(sarif.status).not.toBe(0);
    const log = JSON.parse(sarif.stdout);
    expect(log.version).toBe('2.1.0');
    expect(log.runs[0].results[0].message.text).toContain(
      "Unrecognized function: 'nope'"
    );
  });

  it('inventory lists resolved actions and tracks drift via a lockfile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-inv-cli-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    const wf = path.join(dir, '.github', 'workflows', 'ci.yml');
    fs.writeFileSync(
      wf,
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: org/scan@1111111111111111111111111111111111111111',
        '      - uses: org/deploy@2222222222222222222222222222222222222222'
      ].join('\n')
    );

    // --dry-run prints the resolved inventory as JSON and writes nothing.
    // --offline: only already-pinned refs resolve (no network).
    const inv = JSON.parse(
      run(['inventory', wf, '--offline', '--dry-run'], dir).stdout
    );
    expect(inv.actions.map((a: { uses: string }) => a.uses)).toEqual([
      'org/deploy@2222222222222222222222222222222222222222',
      'org/scan@1111111111111111111111111111111111111111'
    ]);
    expect(inv.actions[0].resolvedSha).toBe(
      '2222222222222222222222222222222222222222'
    );
    const lock = path.join(dir, 'secureci.lock');
    expect(fs.existsSync(lock)).toBe(false);

    // --check with no lockfile yet fails and tells you how to create one.
    const noLock = run(['inventory', wf, '--offline', '--check'], dir);
    expect(noLock.status).not.toBe(0);
    expect(noLock.stdout + noLock.stderr).toContain('No secureci.lock found');

    // Bare `inventory` with no lockfile bootstraps ./secureci.lock at the repo
    // root (no path needed); a following bare run drift-checks and passes.
    expect(run(['inventory', wf, '--offline'], dir).status).toBe(0);
    expect(fs.existsSync(lock)).toBe(true);
    expect(run(['inventory', wf, '--offline'], dir).status).toBe(0);
    expect(run(['inventory', wf, '--offline', '--check'], dir).status).toBe(0);

    // Simulate a moving tag: the recorded commit no longer matches what
    // the ref resolves to. --compare (alias of --check) reports drift and fails.
    const lockData = JSON.parse(fs.readFileSync(lock, 'utf-8'));
    const key = Object.keys(lockData.actions)[0];
    expect(lockData.version).toBe(2);
    lockData.actions[key].commit = '9'.repeat(40);
    fs.writeFileSync(lock, JSON.stringify(lockData));
    const drift = run(['inventory', wf, '--offline', '--compare'], dir);
    expect(drift.status).not.toBe(0);
    expect(drift.stdout + drift.stderr).toContain('Drift:');

    // --update-lock and --check together is an error.
    const both = run(
      ['inventory', wf, '--offline', '--update-lock', '--check'],
      dir
    );
    expect(both.status).not.toBe(0);
    expect(both.stdout + both.stderr).toMatch(
      /either --update-lock or --check/
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("inventory checks GitHub's actions.lock when no secureci.lock exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-ghlock-cli-'));
    const wfDir = path.join(dir, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const wf = path.join(wfDir, 'ci.yml');
    const scan = 'org/scan@' + '1'.repeat(40);
    fs.writeFileSync(
      wf,
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - uses: ${scan}`
      ].join('\n')
    );
    const ghLock = path.join(wfDir, 'actions.lock');
    const writeGhLock = (deps: Record<string, string>) =>
      fs.writeFileSync(
        ghLock,
        [
          "version: 'v0.0.2'",
          'dependencies:',
          ...Object.entries(deps).flatMap(([key, sha]) => [
            `  '${key}':`,
            "    ref: 'v1'",
            `    commit: 'sha1-${sha}'`,
            '    owner_id: 1',
            '    repo_id: 1'
          ]),
          // A transitive dependency SecureCI doesn't scan: never "unused".
          "  'org/helper@v1':",
          "    ref: 'v1'",
          `    commit: 'sha1-${'3'.repeat(40)}'`,
          '    owner_id: 1',
          '    repo_id: 2'
        ].join('\n')
      );
    const secureciLock = path.join(dir, 'secureci.lock');
    const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

    // Matching actions.lock: bare `inventory` checks it and passes, without
    // creating secureci.lock.
    writeGhLock({ [scan]: '1'.repeat(40) });
    const ok = run(['inventory', wf, '--offline'], dir);
    expect(ok.status).toBe(0);
    expect(out(ok)).toContain('actions.lock');
    expect(out(ok)).not.toContain('no longer used');
    expect(fs.existsSync(secureciLock)).toBe(false);
    expect(run(['inventory', wf, '--offline', '--check'], dir).status).toBe(0);

    // A locked commit that no longer matches is drift.
    writeGhLock({ [scan]: '9'.repeat(40) });
    const drift = run(['inventory', wf, '--offline', '--check'], dir);
    expect(drift.status).not.toBe(0);
    expect(out(drift)).toContain('Drift:');
    expect(out(drift)).toContain('gh actions-lock');

    // An action missing from actions.lock fails too.
    writeGhLock({});
    const missing = run(['inventory', wf, '--offline'], dir);
    expect(missing.status).not.toBe(0);
    expect(out(missing)).toContain(`New action not in actions.lock: ${scan}`);

    // secureci.lock stays first-class: once written, it wins over a stale
    // actions.lock.
    expect(
      run(['inventory', wf, '--offline', '--update-lock'], dir).status
    ).toBe(0);
    expect(fs.existsSync(secureciLock)).toBe(true);
    const preferred = run(['inventory', wf, '--offline', '--check'], dir);
    expect(preferred.status).toBe(0);
    expect(out(preferred)).toContain('secureci.lock');

    // An actions.lock format this version doesn't understand is a clear error.
    fs.rmSync(secureciLock);
    fs.writeFileSync(ghLock, "version: 'v9.9.9'\ndependencies: {}\n");
    const future = run(['inventory', wf, '--offline'], dir);
    expect(future.status).not.toBe(0);
    expect(out(future)).toContain('Unsupported actions.lock version');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inventory locks transitive dependencies and still reads a v1 lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-trans-cli-'));
    const wfDir = path.join(dir, 'repo', '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const repo = path.join(dir, 'repo');
    const wrap = 'org/wrap@' + '1'.repeat(40);
    const leaf = 'org/leaf@' + '2'.repeat(40);
    // Seed the action cache for the pinned composite action (offline).
    const home = path.join(dir, 'home');
    const cached = path.join(
      home,
      '.secureci',
      'actions-cache',
      'org',
      'wrap',
      '1'.repeat(40)
    );
    fs.mkdirSync(cached, { recursive: true });
    fs.writeFileSync(
      path.join(cached, 'action.yml'),
      [
        'name: wrap',
        'description: d',
        'runs:',
        '  using: composite',
        '  steps:',
        `    - uses: ${leaf}`
      ].join('\n')
    );
    const env = { ...process.env, HOME: home };
    const wf = path.join(wfDir, 'ci.yml');
    fs.writeFileSync(
      wf,
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - uses: ${wrap}`
      ].join('\n')
    );
    const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

    const inv = JSON.parse(
      run(['inventory', wf, '--offline', '--dry-run'], repo, env).stdout
    );
    const leafEntry = inv.actions.find(
      (a: { uses: string }) => a.uses === leaf
    );
    expect(leafEntry.via).toEqual([wrap]);

    const write = run(
      ['inventory', wf, '--offline', '--update-lock'],
      repo,
      env
    );
    expect(write.status).toBe(0);
    expect(out(write)).toContain('2 action(s)');
    expect(out(write)).toContain('1 used by other actions');
    const lock = JSON.parse(
      fs.readFileSync(path.join(repo, 'secureci.lock'), 'utf-8')
    );
    expect(lock).toEqual({
      version: 2,
      actions: {
        [leaf]: { commit: '2'.repeat(40), via: [wrap] },
        [wrap]: { commit: '1'.repeat(40) }
      }
    });

    // A v1 lock (from 0.4.0 and earlier) is still checked: missing the
    // transitive entry, it reports it as new.
    fs.writeFileSync(
      path.join(repo, 'secureci.lock'),
      JSON.stringify({ version: 1, actions: { [wrap]: '1'.repeat(40) } })
    );
    const v1 = run(['inventory', wf, '--offline', '--check'], repo, env);
    expect(v1.status).not.toBe(0);
    expect(out(v1)).toContain(`New action not in secureci.lock: ${leaf}`);

    // An uncached dependency (offline) is a warning, not a crash.
    fs.rmSync(path.join(home, '.secureci'), { recursive: true, force: true });
    const missing = spawnSync(
      'node',
      [cliPath, 'inventory', wf, '--offline', '--dry-run'],
      { cwd: repo, env, encoding: 'utf-8' }
    );
    expect(missing.status).toBe(0);
    expect(JSON.parse(missing.stdout).actions).toHaveLength(1);
    expect(missing.stderr).toContain(`Could not read ${wrap}`);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inventory --check fails when a locked repository was re-created', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-ident-cli-'));
    const wfDir = path.join(dir, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const scan = 'org/scan@' + '1'.repeat(40);
    const wf = path.join(wfDir, 'ci.yml');
    fs.writeFileSync(
      wf,
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - uses: ${scan}`
      ].join('\n')
    );
    // A fake GitHub API: org/scan is now repository 99, owner 7. It has no
    // tarball, so the transitive walk just warns.
    const server = http.createServer((req, res) => {
      if (req.url === '/api/repos/org/scan') {
        res.writeHead(200);
        res.end(JSON.stringify({ id: 99, owner: { id: 7 } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = {
      ...process.env,
      HOME: path.join(dir, 'home'),
      GITHUB_SERVER_URL: base,
      GITHUB_API_URL: `${base}/api`,
      GITHUB_TOKEN: 'test-token',
      no_proxy: '127.0.0.1,localhost',
      NO_PROXY: '127.0.0.1,localhost'
    };
    const runAsync = (args: string[]) =>
      new Promise<{ status: number; out: string }>((resolve) => {
        execFile(
          'node',
          [cliPath, ...args],
          { cwd: dir, env, encoding: 'utf-8' },
          (error, stdout, stderr) =>
            resolve({
              status: error ? ((error as { code?: number }).code ?? 1) : 0,
              out: stdout + stderr
            })
        );
      });

    try {
      // Writing records the identity.
      expect((await runAsync(['inventory', wf, '--update-lock'])).status).toBe(
        0
      );
      const lockFile = path.join(dir, 'secureci.lock');
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
      expect(lock.actions[scan]).toEqual({
        commit: '1'.repeat(40),
        owner_id: 7,
        repo_id: 99
      });
      expect((await runAsync(['inventory', wf, '--check'])).status).toBe(0);

      // Same name and commit, different repository: fail.
      lock.actions[scan].repo_id = 42;
      fs.writeFileSync(lockFile, JSON.stringify(lock));
      const changed = await runAsync(['inventory', wf, '--check']);
      expect(changed.status).not.toBe(0);
      expect(changed.out).toContain('Repository changed');
      expect(changed.out).toContain('repo_id is now 99 (was 42)');

      // --offline can't look it up, so it doesn't check identity.
      expect(
        (await runAsync(['inventory', wf, '--offline', '--check'])).status
      ).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inventory --check fails online when a locked action no longer resolves, and shows progress', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-gone-cli-'));
    const wfDir = path.join(dir, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const tag = 'org/scan@v1';
    const pinned = 'org/gone@' + '2'.repeat(40);
    const wf = path.join(wfDir, 'ci.yml');
    fs.writeFileSync(
      wf,
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - uses: ${tag}`,
        `      - uses: ${pinned}`
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'secureci.lock'),
      JSON.stringify({
        version: 2,
        actions: {
          [tag]: { commit: '1'.repeat(40) },
          [pinned]: { commit: '2'.repeat(40) }
        }
      })
    );
    // A fake GitHub where org/scan@v1 resolves until `gone` is set, and
    // org/gone doesn't exist. No tarballs: the transitive walk only warns.
    let gone = false;
    const server = http.createServer((req, res) => {
      if (!gone && req.url === '/api/repos/org/scan/commits/v1') {
        res.writeHead(200);
        res.end('1'.repeat(40));
        return;
      }
      if (!gone && req.url === '/api/repos/org/scan') {
        res.writeHead(200);
        res.end('{}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = {
      ...process.env,
      HOME: path.join(dir, 'home'),
      GITHUB_SERVER_URL: base,
      GITHUB_API_URL: `${base}/api`,
      GITHUB_TOKEN: 'test-token',
      no_proxy: '127.0.0.1,localhost',
      NO_PROXY: '127.0.0.1,localhost'
    };
    const runAsync = (args: string[]) =>
      new Promise<{ status: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            'node',
            [cliPath, ...args],
            { cwd: dir, env, encoding: 'utf-8' },
            (error, stdout, stderr) =>
              resolve({
                status: error ? ((error as { code?: number }).code ?? 1) : 0,
                stdout,
                stderr
              })
          );
        }
      );

    try {
      // The pinned action's repository is gone: fail, though its commit
      // "resolves" without the network.
      const first = await runAsync(['inventory', wf, '--check']);
      expect(first.status).not.toBe(0);
      expect(first.stderr).toContain(`Repository gone: ${pinned}`);
      // Not a terminal: a notice, then a line per item, on stderr.
      expect(first.stderr).toContain('Resolving 2 action(s) over the network');
      expect(first.stderr).toContain(`Resolving tags [1/1] ${tag}`);
      expect(first.stderr).toContain('Checking repositories [1/1] org/gone');
      expect(first.stdout).not.toContain('Resolving tags');

      // Now the tag no longer resolves either: also a failure, naming the
      // locked commit; it isn't reported as "no longer used".
      gone = true;
      const second = await runAsync(['inventory', wf, '--check']);
      expect(second.status).not.toBe(0);
      expect(second.stderr).toContain(
        `Could not resolve ${tag} (locked at ${'1'.repeat(12)})`
      );
      expect(second.stdout + second.stderr).not.toContain('no longer used');

      // --offline can't resolve tags at all: a warning, not a failure, and
      // no network notice.
      const offline = await runAsync(['inventory', wf, '--offline', '--check']);
      expect(offline.status).toBe(0);
      expect(offline.stderr).toContain(
        `Not checked offline (tags need the network): ${tag}`
      );
      expect(offline.stderr).not.toContain('over the network');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin rewrites tags to cached commit SHAs offline, honours pins.allow, and --check fails until everything is pinned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-pin-cli-'));
    const wfDir = path.join(dir, '.github', 'workflows');
    const actionDir = path.join(dir, '.github', 'actions', 'local');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.mkdirSync(actionDir, { recursive: true });
    const wf = path.join(wfDir, 'ci.yml');
    const original = [
      'name: CI',
      'on: push',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      # checkout first',
      "      - uses: 'actions/checkout@v4' # v3",
      '      - uses: org/scan@v1',
      '      - uses: trusted/tool@v2',
      '      - uses: ./.github/actions/local',
      '      - uses: docker://alpine:3.20',
      ''
    ].join('\n');
    fs.writeFileSync(wf, original);
    const action = path.join(actionDir, 'action.yml');
    fs.writeFileSync(
      action,
      [
        'name: Local',
        'description: wraps a tool',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: org/tool@v2',
        ''
      ].join('\n')
    );
    const contract = path.join(dir, 'contract.yml');
    fs.writeFileSync(contract, 'pins:\n  required: true\n  allow: [trusted]\n');

    // Seed the action cache, as an earlier `run`/`inventory` would have:
    // actions/checkout@v4 and org/tool@v2 resolve offline; org/scan@v1
    // doesn't.
    const home = path.join(dir, 'home');
    const checkout = 'c'.repeat(40);
    const tool = 'd'.repeat(40);
    for (const [repo, ref, sha] of [
      ['actions/checkout', 'v4', checkout],
      ['org/tool', 'v2', tool]
    ]) {
      const cache = path.join(home, '.secureci', 'actions-cache', repo);
      fs.mkdirSync(path.join(cache, sha), { recursive: true });
      fs.writeFileSync(
        path.join(cache, 'refs.json'),
        JSON.stringify({ [ref]: sha })
      );
    }
    const env = { ...process.env, HOME: home };
    const pin = (...args: string[]) => {
      const r = run(['pin', ...args], dir, env);
      return { status: r.status, out: r.stdout + r.stderr };
    };

    try {
      // --check changes nothing, lists what would change and fails.
      const check = pin('--offline', '--check', '--contract', contract);
      expect(check.status).not.toBe(0);
      expect(check.out).toContain(
        `.github/workflows/ci.yml:8 actions/checkout@v4 -> ${checkout.slice(0, 12)} (v4)`
      );
      expect(check.out).toContain(
        `.github/actions/local/action.yml:6 org/tool@v2 -> ${tool.slice(0, 12)} (v2)`
      );
      expect(check.out).toMatch(/ci\.yml:9 org\/scan@v1 could not be resolved/);
      expect(check.out).toContain('2 reference(s) would be pinned');
      expect(fs.readFileSync(wf, 'utf-8')).toBe(original);

      // Pinning rewrites only the resolvable references, in place.
      const pinned = pin('--offline', '--contract', contract);
      expect(pinned.out).toContain('Pinned 2 reference(s) in 2 file(s)');
      expect(fs.readFileSync(wf, 'utf-8')).toBe(
        original.replace(
          "'actions/checkout@v4' # v3",
          `'actions/checkout@${checkout}' # v4`
        )
      );
      expect(fs.readFileSync(action, 'utf-8')).toContain(
        `    - uses: org/tool@${tool} # v2\n`
      );

      // org/scan@v1 still can't be resolved, so --check still fails.
      expect(
        pin('--offline', '--check', '--contract', contract).status
      ).not.toBe(0);
      // Without the contract, trusted/tool@v2 must be pinned too.
      fs.writeFileSync(
        wf,
        fs
          .readFileSync(wf, 'utf-8')
          .replace('org/scan@v1', `org/scan@${'e'.repeat(40)}`)
      );
      const noContract = pin(
        '.github/workflows/ci.yml',
        '--offline',
        '--check'
      );
      expect(noContract.status).not.toBe(0);
      expect(noContract.out).toContain('trusted/tool@v2 could not be resolved');
      const clean = pin(
        '.github/workflows/ci.yml',
        '--offline',
        '--check',
        '--contract',
        contract
      );
      expect(clean.status).toBe(0);
      expect(clean.out).toContain('Nothing to pin');

      // --update-lock refreshes secureci.lock from the pinned workflows.
      expect(pin('--offline', '--update-lock', '--check').status).not.toBe(0);
      expect(
        pin('--offline', '--update-lock', '--contract', contract).status
      ).toBe(0);
      const lock = JSON.parse(
        fs.readFileSync(path.join(dir, 'secureci.lock'), 'utf-8')
      );
      expect(Object.keys(lock.actions)).toContain(
        `actions/checkout@${checkout}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pin resolves tags over the network (here a fake GitHub API)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-pin-net-'));
    const wfDir = path.join(dir, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const wf = path.join(wfDir, 'ci.yml');
    fs.writeFileSync(
      wf,
      [
        'on: push',
        'jobs:',
        '  call:',
        '    uses: org/workflows/.github/workflows/build.yml@v1',
        ''
      ].join('\n')
    );
    const sha = 'f'.repeat(40);
    const server = http.createServer((req, res) => {
      if (req.url === '/api/repos/org/workflows/commits/v1') {
        res.writeHead(200);
        res.end(sha);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = {
      ...process.env,
      HOME: path.join(dir, 'home'),
      GITHUB_SERVER_URL: base,
      GITHUB_API_URL: `${base}/api`,
      GITHUB_TOKEN: 'test-token',
      no_proxy: '127.0.0.1,localhost',
      NO_PROXY: '127.0.0.1,localhost'
    };
    try {
      const result = await new Promise<{ status: number; out: string }>(
        (resolve) =>
          execFile(
            'node',
            [cliPath, 'pin'],
            { cwd: dir, env, encoding: 'utf-8' },
            (error, stdout, stderr) =>
              resolve({
                status: error ? ((error as { code?: number }).code ?? 1) : 0,
                out: stdout + stderr
              })
          )
      );
      expect(result.status).toBe(0);
      expect(fs.readFileSync(wf, 'utf-8')).toContain(
        `    uses: org/workflows/.github/workflows/build.yml@${sha} # v1\n`
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validate and inventory flag actions with known security advisories (#47)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-adv-cli-'));
    const fixtures = path.join(root, 'test', 'fixtures', 'advisories');
    const tjSha = '4'.repeat(40);
    const untagged = 'org/other@' + '5'.repeat(40);
    const wf = path.join(dir, 'ci.yml');
    fs.writeFileSync(
      wf,
      [
        'name: CI',
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: tj-actions/changed-files@v45.0.7'
      ].join('\n')
    );
    const pinnedWf = path.join(dir, 'pinned.yml');
    fs.writeFileSync(
      pinnedWf,
      [
        'name: Pinned',
        'on: push',
        'permissions: {}',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        `      - uses: ${untagged}`
      ].join('\n')
    );
    // A fake GitHub API: advisories by ?affects=, and tag -> commit.
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/api/advisories') {
        const affects = url.searchParams.get('affects');
        const body =
          affects === 'tj-actions/changed-files'
            ? fs.readFileSync(
                path.join(fixtures, 'tj-actions-changed-files.json'),
                'utf8'
              )
            : affects === 'org/other'
              ? JSON.stringify([
                  {
                    ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
                    severity: 'critical',
                    summary: 'Bad',
                    vulnerabilities: [
                      {
                        package: { ecosystem: 'actions', name: 'org/other' },
                        vulnerable_version_range: '< 2.0.0',
                        first_patched_version: '2.0.0'
                      }
                    ]
                  }
                ])
              : '[]';
        res.writeHead(200);
        res.end(body);
        return;
      }
      if (
        url.pathname === '/api/repos/tj-actions/changed-files/commits/v45.0.7'
      ) {
        res.writeHead(200);
        res.end(tjSha);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const home = path.join(dir, 'home');
    const env = {
      ...process.env,
      HOME: home,
      GITHUB_SERVER_URL: base,
      GITHUB_API_URL: `${base}/api`,
      GITHUB_TOKEN: 'test-token',
      no_proxy: '127.0.0.1,localhost',
      NO_PROXY: '127.0.0.1,localhost'
    };
    const runAsync = (args: string[], runEnv: NodeJS.ProcessEnv = env) =>
      new Promise<{ status: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            'node',
            [cliPath, ...args],
            { cwd: dir, env: runEnv, encoding: 'utf-8' },
            (error, stdout, stderr) =>
              resolve({
                status: error ? ((error as { code?: number }).code ?? 1) : 0,
                stdout,
                stderr
              })
          );
        }
      );

    try {
      // validate: the high advisory is an error (fails), with its SARIF rule.
      const sarif = await runAsync(['validate', wf, '--format', 'sarif']);
      expect(sarif.status).not.toBe(0);
      const results = JSON.parse(sarif.stdout).runs[0].results;
      expect(results).toEqual([
        expect.objectContaining({
          ruleId: 'secureci/vulnerable-action',
          level: 'error',
          message: {
            text: expect.stringContaining(
              'jobs.a.steps[1]: tj-actions/changed-files@v45.0.7 has a known security advisory: GHSA-mrrh-fwg8-r2c3 (CVE-2025-30066, high)'
            )
          }
        })
      ]);
      expect(results[0].message.text).toContain(
        'first patched version: 46.0.1'
      );
      // One query per repository, cached under ~/.secureci/advisories.
      expect(
        requests.filter((r) => r.startsWith('/api/advisories')).length
      ).toBe(2);
      expect(
        fs.existsSync(
          path.join(
            home,
            '.secureci',
            'advisories',
            'tj-actions',
            'changed-files.json'
          )
        )
      ).toBe(true);

      // The cache answers the next run (and --offline), without the API.
      requests.length = 0;
      const text = await runAsync(['validate', wf]);
      expect(text.status).not.toBe(0);
      expect(text.stderr).toContain('GHSA-mrrh-fwg8-r2c3');
      expect(requests).toEqual([]);
      const cachedOffline = await runAsync(['validate', wf, '--offline']);
      expect(cachedOffline.status).not.toBe(0);

      // A contract can raise the bar: fail-on: critical lets this pass.
      const contract = path.join(dir, 'contract.yml');
      fs.writeFileSync(contract, 'advisories:\n  fail-on: critical\n');
      const relaxed = await runAsync([
        'validate',
        wf,
        '--contract',
        contract,
        '--format',
        'json'
      ]);
      expect(relaxed.status).toBe(0);
      expect(JSON.parse(relaxed.stdout).errors).toEqual([
        expect.objectContaining({ severity: 'warning' })
      ]);

      // --offline with nothing cached: skipped with a warning, not a failure.
      const fresh = await runAsync(['validate', wf, '--offline'], {
        ...env,
        HOME: path.join(dir, 'empty-home')
      });
      expect(fresh.status).toBe(0);
      expect(fresh.stderr).toContain(
        'Security advisories not checked for actions/checkout, tj-actions/changed-files (offline and not cached)'
      );

      // inventory --dry-run: the tag resolves, and an untagged SHA pin of
      // a repository with advisories is an "unknown version", not a finding.
      requests.length = 0;
      const inv = await runAsync(['inventory', wf, pinnedWf, '--dry-run']);
      expect(inv.status).toBe(0);
      const parsed = JSON.parse(inv.stdout);
      expect(parsed.advisories).toEqual([
        expect.objectContaining({
          uses: 'tj-actions/changed-files@v45.0.7',
          ghsaId: 'GHSA-mrrh-fwg8-r2c3',
          severity: 'high',
          firstPatched: '46.0.1'
        })
      ]);
      expect(parsed.advisoryUnknownVersions).toEqual([
        { uses: untagged, advisories: ['GHSA-xxxx-yyyy-zzzz'] }
      ]);

      // Human output: the finding, and the unknown version as info.
      const human = await runAsync(['inventory', wf, pinnedWf]);
      expect(human.status).toBe(0);
      expect(human.stderr).toContain(
        '[ERROR] tj-actions/changed-files@v45.0.7 has a known security advisory: GHSA-mrrh-fwg8-r2c3'
      );
      // v45.0.7 is past the medium advisory's range (< 41.0.0).
      expect(human.stderr).not.toContain('GHSA-mcph-m25j-8j63');
      expect(human.stdout).toContain(`${untagged}: unknown version`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validate --contract reads owner/repo/path@sha from another repository', () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'secureci-remote-contract-')
    );
    const sha = 'c'.repeat(40);
    // Seed the action cache the fetcher reads for a SHA-pinned ref, under a
    // temporary HOME, so no network is needed.
    const home = path.join(dir, 'home');
    const cached = path.join(
      home,
      '.secureci',
      'actions-cache',
      'my-org',
      'standards',
      sha,
      'contracts'
    );
    fs.mkdirSync(cached, { recursive: true });
    fs.writeFileSync(
      path.join(cached, 'standard.yml'),
      'required:\n  - uses: org/security-scan\n'
    );
    const wf = path.join(dir, 'ci.yml');
    fs.writeFileSync(
      wf,
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: org/deploy@v1'
      ].join('\n')
    );
    const env = { ...process.env, HOME: home, GITHUB_TOKEN: '', GH_TOKEN: '' };
    const uses = `my-org/standards/contracts/standard.yml@${sha}`;

    const res = run(
      ['validate', wf, '--contract', uses, '--format', 'json'],
      dir,
      env
    );
    // The remote contract is enforced: the required scan is missing.
    expect(res.status).not.toBe(0);
    const report = JSON.parse(res.stdout);
    expect(JSON.stringify(report.errors)).toContain('org/security-scan');
    // ...and the report records exactly which contract version was used.
    expect(report.contract).toEqual({
      source: uses,
      ref: sha,
      commit: sha,
      pinned: true
    });
    // A pinned ref doesn't warn.
    expect(res.stderr).not.toContain('moving ref');

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows effective values, marking built-in defaults, in config list', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-cfg-home-'));
    const env = { ...process.env, HOME: home };
    run(['config', 'set', 'container-memory', '512m'], tempDir, env);
    const out = run(['config', 'list'], tempDir, env).stdout;
    expect(out).toContain('container-runtime=docker (default)');
    expect(out).toContain('container-memory=512m');
    expect(out).toContain('container-image=(unset)');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('uses consistent, capitalised help text', () => {
    const help = run(['--help']).stdout + run(['run', '--help']).stdout;
    expect(help).not.toMatch(
      /display help for command|output the version number/
    );
    expect(help).toContain('Show help');
  });

  it('lists workflows with secureci list', () => {
    const result = run(['list'], tempDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ci.yml: Hello CI');
  });

  it('generates a valid workflow with secureci init workflow and refuses to clobber it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-init-'));
    const out = path.join(dir, '.github', 'workflows', 'secureci.yml');

    // Bare `init` is ambiguous, so it shows help (listing the workflow
    // subcommand) and writes nothing.
    const bare = run(['init'], dir);
    expect(bare.stdout + bare.stderr).toContain('workflow');
    expect(fs.existsSync(out)).toBe(false);

    const first = run(['init', 'workflow'], dir);
    expect(first.status).toBe(0);
    expect(fs.existsSync(out)).toBe(true);
    // The action ref is this CLI's own release tag (package.json version).
    const { version } = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
    );
    expect(fs.readFileSync(out, 'utf-8')).toContain(
      `uses: secure-ci/cli@v${version}\n`
    );

    // The generated workflow passes our own validator.
    expect(run(['validate', out], dir).status).toBe(0);

    // A second run won't overwrite without --force.
    const second = run(['init', 'workflow'], dir);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('already exists');

    // --no-upload keeps contents: read only and the file still validates.
    const forced = run(['init', 'workflow', '--no-upload', '--force'], dir);
    expect(forced.status).toBe(0);
    const content = fs.readFileSync(out, 'utf-8');
    expect(content).not.toContain('security-events');
    expect(content).toContain('upload-sarif: false');
    expect(run(['validate', out], dir).status).toBe(0);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
