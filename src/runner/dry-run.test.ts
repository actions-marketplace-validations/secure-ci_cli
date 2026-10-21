import { dryRun } from './dry-run';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Dry Run', () => {
  const fixturesDir = path.join(__dirname, '../../test/fixtures');

  describe('dryRun for workflows', () => {
    it('fails for an invalid if: expression, like a real run', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-dry-'));
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        'name: B\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo x\n        if: sucess()\n'
      );
      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.join(' '));
      };
      try {
        expect(dryRun(file).success).toBe(false);
        expect(errors.join('\n')).toContain(
          "jobs.a.steps[0].if: Unrecognized function: 'sucess'"
        );
      } finally {
        console.error = originalError;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('should display workflow structure without executing', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');

      // Mock console.log to capture output
      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        logs.push(args.join(' '));
      };

      const result = dryRun(workflowPath);

      console.log = originalLog;

      expect(result.success).toBe(true);
      expect(result.type).toBe('workflow');
      expect(result.jobs).toBeDefined();
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs![0].name).toBe('test');
    });

    it('should list all jobs and steps', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = dryRun(workflowPath);

      expect(result.jobs).toBeDefined();
      expect(result.jobs![0].steps).toHaveLength(4);
      expect(result.jobs![0].steps[0]).toContain('Checkout code');
    });

    it('should identify action uses', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = dryRun(workflowPath);

      expect(result.jobs).toBeDefined();
      expect(result.jobs![0].steps[0]).toContain('actions/checkout@v3');
    });

    it('should identify run commands', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = dryRun(workflowPath);

      expect(result.jobs).toBeDefined();
      expect(result.jobs![0].steps[2]).toContain('npm install');
    });

    it('should handle reusable workflow calls', () => {
      const workflowPath = path.join(fixturesDir, 'reusable-caller.yml');
      const result = dryRun(workflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs).toBeDefined();
      expect(result.jobs![0].steps[0]).toContain('reusable.yml');
    });
  });

  describe('matrix and --matrix (#50)', () => {
    let dir: string;
    let file: string;
    let warnings: string[];
    let logs: string[];
    const originalWarn = console.warn;
    const originalLog = console.log;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-dry-matrix-'));
      file = path.join(dir, 'wf.yml');
      warnings = [];
      logs = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(' '));
      };
      console.log = (...args: unknown[]) => {
        logs.push(args.join(' '));
      };
      fs.writeFileSync(
        file,
        [
          'name: M',
          'on: push',
          'jobs:',
          '  setup:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: echo setup',
          '  test:',
          '    runs-on: ubuntu-latest',
          '    strategy:',
          '      matrix:',
          '        node: [18, 20]',
          '        os: [linux, mac]',
          '        exclude:',
          '          - { node: 18, os: mac }',
          '    steps:',
          '      - run: echo test',
          '  shards:',
          '    needs: setup',
          '    runs-on: ubuntu-latest',
          '    strategy:',
          '      matrix: ${{ fromJSON(needs.setup.outputs.m) }}',
          '    steps:',
          '      - run: echo shard'
        ].join('\n')
      );
    });

    afterEach(() => {
      console.warn = originalWarn;
      console.log = originalLog;
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const job = (result: ReturnType<typeof dryRun>, name: string) =>
      result.jobs?.find((j) => j.name === name);

    it('lists the matrix combinations, after exclude', () => {
      const result = dryRun(file);
      expect(result.success).toBe(true);
      expect(job(result, 'test')?.matrix).toEqual([
        'node: 18, os: linux',
        'node: 20, os: linux',
        'node: 20, os: mac'
      ]);
      expect(job(result, 'setup')?.matrix).toBeUndefined();
      expect(logs.join('\n')).toContain('    node: 20, os: mac');
    });

    it('notes a matrix that is only known at run time, without expanding it', () => {
      const result = dryRun(file, { matrix: { shard: ['1'] } });
      expect(result.success).toBe(true);
      expect(job(result, 'shards')?.matrix).toBeUndefined();
      expect(logs.join('\n')).toContain('Matrix: resolved at run time');
      // The key may come from the run-time matrix: no unknown-key warning.
      expect(warnings).toEqual([]);
    });

    it('shows only the combinations --matrix selects', () => {
      const result = dryRun(file, { matrix: { node: ['20'], os: ['mac'] } });
      expect(result.success).toBe(true);
      expect(job(result, 'test')?.matrix).toEqual(['node: 20, os: mac']);
      expect(job(result, 'setup')?.steps).toHaveLength(1);
    });

    it('honours --job', () => {
      const result = dryRun(file, { job: 'test' });
      expect(result.jobs?.map((j) => j.name)).toEqual(['test']);
    });

    it('fails, warns and drops a job with no matching combination', () => {
      const result = dryRun(file, { matrix: { node: ['18'], os: ['mac'] } });
      expect(result.success).toBe(false);
      expect(job(result, 'test')).toBeUndefined();
      expect(warnings.join('\n')).toContain(
        'No matrix combination of job "test" matches --matrix node:18, os:mac; skipping it. Available combinations:\n  node: 18, os: linux'
      );
    });

    it('warns about a key no matrix job defines', () => {
      const result = dryRun(file, { job: 'test', matrix: { nod: ['20'] } });
      expect(result.success).toBe(true);
      expect(job(result, 'test')?.matrix).toHaveLength(3);
      expect(warnings.join('\n')).toContain(
        '--matrix nod: no matrix job defines this key; it was ignored'
      );
    });
  });

  describe('dryRun for actions', () => {
    it('should display action structure without executing', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = dryRun(actionPath);

      expect(result.success).toBe(true);
      expect(result.type).toBe('action');
    });

    it('should list inputs and outputs', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = dryRun(actionPath);

      expect(result.inputs).toBeDefined();
      expect(result.inputs!.length).toBeGreaterThan(0);
      expect(result.inputs![0]).toContain('who-to-greet');
      expect(result.outputs).toBeDefined();
      expect(result.outputs!.length).toBeGreaterThan(0);
      expect(result.outputs![0]).toContain('greeting');
    });

    it('should list composite action steps', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = dryRun(actionPath);

      expect(result.steps).toHaveLength(2);
    });
  });
});
