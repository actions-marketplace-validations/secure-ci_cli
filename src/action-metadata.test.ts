import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';

// The root action.yml is what GitHub Marketplace lists. Marketplace names must
// be unique: "Secure CI" (slug secure-ci) belongs to another publisher and
// "SecureCI" collides with an unrelated GitHub organization, so the listing
// uses a distinct name ("SecureCI GHA", slug secureci-gha).
const action = YAML.parse(
  fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8')
);

describe('action.yml', () => {
  it('uses the Marketplace listing name', () => {
    expect(action.name).toBe('SecureCI GHA');
  });

  it('offers an opt-in lockfile drift check', () => {
    expect(action.inputs.inventory).toMatchObject({
      required: false,
      default: ''
    });
  });

  it('fails the job when either check fails', () => {
    const fail = action.runs.steps.find(
      (s: { name?: string }) => s.name === 'Fail if any check failed'
    );
    expect(fail.if).toContain('steps.run.outputs.status');
    expect(fail.if).toContain('steps.run.outputs.inventory-status');
  });
});

// Runs the action's main bash step with a stub `npx` that records its
// arguments, so the wiring between inputs and CLI calls is tested end to end.
describe('action.yml run step', () => {
  let dir: string;
  const script = action.runs.steps.find(
    (s: { id?: string }) => s.id === 'run'
  ).run;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-action-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.github', 'workflows', 'ci.yml'),
      'on: push\n'
    );
    fs.mkdirSync(path.join(dir, 'bin'));
    // Fails `inventory` when STUB_INVENTORY_EXIT is set, to simulate drift.
    fs.writeFileSync(
      path.join(dir, 'bin', 'npx'),
      '#!/usr/bin/env bash\necho "$*" >> "$STUB_LOG"\n' +
        'if [[ "$*" == *" inventory "* ]]; then exit "${STUB_INVENTORY_EXIT:-0}"; fi\n',
      { mode: 0o755 }
    );
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(inventory: string, inventoryExit = 0) {
    const env = {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
      GITHUB_OUTPUT: path.join(dir, 'out'),
      STUB_LOG: path.join(dir, 'log'),
      STUB_INVENTORY_EXIT: String(inventoryExit),
      SECURECI_FILES: '',
      SECURECI_CONTRACT: '',
      SECURECI_RECURSE: 'local',
      SECURECI_FORMAT: 'sarif',
      SECURECI_OUTPUT: 'secureci-results.sarif',
      SECURECI_VERSION: 'latest',
      SECURECI_INVENTORY: inventory
    };
    execFileSync('bash', ['-c', script], { cwd: dir, env });
    return {
      calls: fs.existsSync(env.STUB_LOG)
        ? fs.readFileSync(env.STUB_LOG, 'utf8').trim().split('\n')
        : [],
      outputs: fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')
    };
  }

  it('runs only validate by default', () => {
    const { calls, outputs } = run('');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(' validate ');
    expect(outputs).toContain('inventory-status=0');
  });

  it('also runs inventory --check when inventory is "check"', () => {
    const { calls, outputs } = run('check');
    expect(calls[1]).toBe('--yes @secureci/cli@latest inventory --check');
    expect(outputs).toContain('inventory-status=0');
  });

  it('records drift without stopping the step, so SARIF still uploads', () => {
    const { outputs } = run('check', 1);
    expect(outputs).toContain('status=0');
    expect(outputs).toContain('inventory-status=1');
  });

  it('rejects an unknown inventory value', () => {
    expect(() => run('update')).toThrow();
  });

  // The final step fails the job unless both statuses are '0'; an unset
  // output reads as '', so the skip path must still report success.
  it('passes without running anything when there are no workflow files', () => {
    fs.rmSync(path.join(dir, '.github'), { recursive: true, force: true });
    const { calls, outputs } = run('check');
    expect(calls).toEqual([]);
    expect(outputs).toContain('status=0');
    expect(outputs).toContain('inventory-status=0');
  });
});
