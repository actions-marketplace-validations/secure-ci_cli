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
