import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Black-box integration tests: invoke the built CLI binary as a subprocess,
// since cli.ts calls `program.parse()`/`process.exit()` at module scope and
// isn't structured for in-process unit testing (see vitest.config.mts, which
// deliberately excludes src/cli.ts from coverage for the same reason).
describe('cli --contract', () => {
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actly-cli-contract-'));

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

    const result = run(['--contract', contract, workflow]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validation passed!');
  });

  it('fails with a clear message when a required action is missing', () => {
    const contract = write(
      'missing-contract.yml',
      'required:\n  - uses: org/never-used\n'
    );

    const result = run(['--contract', contract, workflow]);

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

    const result = run(['--contract', contract, workflow]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ordering: strict');
  });

  it('fails when a forbidden action is present', () => {
    const contract = write(
      'forbidden-contract.yml',
      'forbidden:\n  - uses: org/security-scan\n'
    );

    const result = run(['--contract', contract, workflow]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Forbidden action "org/security-scan"');
  });

  it('fails when --contract is used against an action file', () => {
    const contract = write(
      'action-contract.yml',
      'required:\n  - uses: org/x\n'
    );

    const result = run(['--contract', contract, action]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('only apply to workflow files');
  });

  it('fails with a clear error when the contract file does not exist', () => {
    const result = run([
      '--contract',
      path.join(tempDir, 'nonexistent.yml'),
      workflow
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Contract file not found');
  });

  it('implies --validate: passing --contract alone still runs syntax validation', () => {
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

    const result = run(['--contract', contract, missingTrigger]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Validating workflow');
    expect(result.stderr).toContain('Workflow trigger (on) is required');
  });
});
