import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
      'cache'
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
    expect(parsed).toMatchObject({ valid: true, errors: [] });
    // Only the JSON object is printed, nothing else.
    expect(json.stdout.trim().startsWith('{')).toBe(true);

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
    lockData.actions[key] = '9'.repeat(40);
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
