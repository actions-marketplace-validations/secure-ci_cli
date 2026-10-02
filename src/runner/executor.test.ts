const resolveContainerRuntimeMock = jest.fn();

jest.mock('./container-runtime', () => {
  const actual = jest.requireActual('./container-runtime');
  return {
    ...actual,
    resolveContainerRuntime: (...args: unknown[]) =>
      resolveContainerRuntimeMock(...args)
  };
});

import { executeWorkflow } from './executor';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('Executor', () => {
  const fixturesDir = path.join(__dirname, '../../test/fixtures');
  const tempTestDir = path.join(os.tmpdir(), 'actly-test');

  beforeEach(() => {
    resolveContainerRuntimeMock.mockReset();
    resolveContainerRuntimeMock.mockResolvedValue(null);
  });

  describe('executeWorkflow', () => {
    it('should execute a simple workflow with run commands', async () => {
      const workflowPath = path.join(fixturesDir, 'echo-workflow.yml');

      const result = await executeWorkflow(workflowPath, {
        inputs: { 'test-input': 'Hello from test' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs.length).toBeGreaterThan(0);
    });

    it('should handle workflow execution with inputs', async () => {
      const workflowPath = path.join(fixturesDir, 'echo-workflow.yml');

      const result = await executeWorkflow(workflowPath, {
        inputs: { 'test-input': 'Test message' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].success).toBe(true);
    });

    it('should handle workflow execution with secrets', async () => {
      const workflowPath = path.join(fixturesDir, 'echo-workflow.yml');

      const result = await executeWorkflow(workflowPath, {
        inputs: { 'test-input': 'test value' }, // Still need inputs for the workflow
        secrets: { TOKEN: 'secret-value' }
      });

      expect(result.success).toBe(true);
    });

    it('should mask secret values in log output', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const secretWorkflowPath = path.join(tempDir, 'secret-workflow.yml');
      fs.writeFileSync(
        secretWorkflowPath,
        `
name: Secret Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "token is super-secret-value-123"
`
      );

      const logSpy = jest
        .spyOn(console, 'log')
        .mockImplementation(() => undefined);

      try {
        const result = await executeWorkflow(secretWorkflowPath, {
          secrets: { TOKEN: 'super-secret-value-123' }
        });

        expect(result.success).toBe(true);
        const loggedStrings = logSpy.mock.calls
          .flat()
          .filter((v): v is string => typeof v === 'string');
        expect(
          loggedStrings.some((s) => s.includes('super-secret-value-123'))
        ).toBe(false);
        expect(loggedStrings.some((s) => s.includes('***'))).toBe(true);
      } finally {
        logSpy.mockRestore();
        fs.unlinkSync(secretWorkflowPath);
      }
    });

    it('should route run: steps through a container runtime when configured', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const containerWorkflowPath = path.join(
        tempDir,
        'container-workflow.yml'
      );
      fs.writeFileSync(
        containerWorkflowPath,
        `
name: Container Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "hi"
`
      );

      const fakeExecute = jest.fn().mockResolvedValue({
        success: true,
        stdout: 'hi\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 5
      });
      resolveContainerRuntimeMock.mockResolvedValue({
        name: 'docker',
        isAvailable: jest.fn().mockResolvedValue(true),
        execute: fakeExecute
      });

      const result = await executeWorkflow(containerWorkflowPath, {
        containerRuntime: 'docker',
        containerImage: 'node:20'
      });

      expect(result.success).toBe(true);
      expect(resolveContainerRuntimeMock).toHaveBeenCalledWith('docker');
      expect(fakeExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          image: 'node:20',
          command: 'echo "hi"',
          networkDisabled: true
        })
      );

      fs.unlinkSync(containerWorkflowPath);
    });

    it('should fall back to host execution when no container runtime is available', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const fallbackWorkflowPath = path.join(
        tempDir,
        'container-fallback-workflow.yml'
      );
      fs.writeFileSync(
        fallbackWorkflowPath,
        `
name: Container Fallback Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "hi"
`
      );

      resolveContainerRuntimeMock.mockResolvedValue(null);

      const result = await executeWorkflow(fallbackWorkflowPath, {
        containerRuntime: 'auto'
      });

      expect(result.success).toBe(true);

      fs.unlinkSync(fallbackWorkflowPath);
    });

    it('should execute specific job when job option is provided', async () => {
      const workflowPath = path.join(fixturesDir, 'echo-workflow.yml');

      const result = await executeWorkflow(workflowPath, {
        job: 'echo-test',
        inputs: { 'test-input': 'test value' }
      });

      expect(result.jobs.length).toBe(1);
    });

    it('should handle step failure and stop execution', async () => {
      // Create a temporary workflow with a failing step
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const failWorkflowPath = path.join(tempDir, 'fail-workflow.yml');
      fs.writeFileSync(
        failWorkflowPath,
        `
name: Fail Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Success step
        run: echo "This works"
      - name: Fail step
        run: exit 1
      - name: Should not run
        run: echo "This should not run"
`
      );

      const result = await executeWorkflow(failWorkflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs[0].success).toBe(false);
      expect(result.jobs[0].steps.length).toBe(2);

      // Cleanup
      fs.unlinkSync(failWorkflowPath);
    });

    it('should continue on error when continue-on-error is set', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const continueWorkflowPath = path.join(tempDir, 'continue-workflow.yml');
      fs.writeFileSync(
        continueWorkflowPath,
        `
name: Continue Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Fail but continue
        run: exit 1
        continue-on-error: true
      - name: Should still run
        run: echo "This runs"
`
      );

      const result = await executeWorkflow(continueWorkflowPath);

      expect(result.jobs[0].steps.length).toBe(2);

      // Cleanup
      fs.unlinkSync(continueWorkflowPath);
    });

    it('should handle composite action execution', async () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');

      const result = await executeWorkflow(actionPath, {
        inputs: { 'who-to-greet': 'Test User' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].job).toBe('action');
    });

    it('should skip a step whose if condition evaluates to false', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const ifWorkflowPath = path.join(tempDir, 'if-skip-workflow.yml');
      fs.writeFileSync(
        ifWorkflowPath,
        `
name: If Skip Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Should skip
        if: \${{ false }}
        run: echo "should not run"
      - name: Should run
        run: echo "runs"
`
      );

      const result = await executeWorkflow(ifWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps.length).toBe(2);
      expect(result.jobs[0].steps[0].outcome).toBe('skipped');
      expect(result.jobs[0].steps[0].success).toBe(true);
      expect(result.jobs[0].steps[1].outcome).not.toBe('skipped');

      fs.unlinkSync(ifWorkflowPath);
    });

    it('should skip an entire job whose if condition evaluates to false', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const ifJobWorkflowPath = path.join(
        tempDir,
        'if-skip-job-workflow.yml'
      );
      fs.writeFileSync(
        ifJobWorkflowPath,
        `
name: If Skip Job Workflow
on: push
jobs:
  skipped-job:
    if: \${{ false }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "should not run"
  active-job:
    runs-on: ubuntu-latest
    steps:
      - run: echo "runs"
`
      );

      const result = await executeWorkflow(ifJobWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].job).toBe('active-job');

      fs.unlinkSync(ifJobWorkflowPath);
    });

    it('should skip a job whose needs dependency failed', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const needsWorkflowPath = path.join(tempDir, 'needs-workflow.yml');
      fs.writeFileSync(
        needsWorkflowPath,
        `
name: Needs Workflow
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo "should not run"
`
      );

      const result = await executeWorkflow(needsWorkflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].job).toBe('build');
      expect(result.jobs[0].success).toBe(false);

      fs.unlinkSync(needsWorkflowPath);
    });

    it('should run jobs in dependency order regardless of declaration order', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const orderWorkflowPath = path.join(tempDir, 'order-workflow.yml');
      fs.writeFileSync(
        orderWorkflowPath,
        `
name: Order Workflow
on: push
jobs:
  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploying"
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "building"
`
      );

      const result = await executeWorkflow(orderWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs.map((j) => j.job)).toEqual(['build', 'deploy']);

      fs.unlinkSync(orderWorkflowPath);
    });

    it('should replace input placeholders in run commands', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const inputWorkflowPath = path.join(tempDir, 'input-workflow.yml');
      fs.writeFileSync(
        inputWorkflowPath,
        `
name: Input Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Echo input
        run: echo "Message is \${{ inputs.message }}"
`
      );

      const result = await executeWorkflow(inputWorkflowPath, {
        inputs: { message: 'Hello World' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('Hello World');

      // Cleanup
      fs.unlinkSync(inputWorkflowPath);
    });

    it('should replace secret placeholders in run commands', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const secretWorkflowPath = path.join(tempDir, 'secret-workflow.yml');
      fs.writeFileSync(
        secretWorkflowPath,
        `
name: Secret Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Use secret
        run: echo "Token is \${{ secrets.TOKEN }}"
`
      );

      const result = await executeWorkflow(secretWorkflowPath, {
        secrets: { TOKEN: 'secret123' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('secret123');

      // Cleanup
      fs.unlinkSync(secretWorkflowPath);
    });

    it('should handle working directory in steps', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const workdirPath = path.join(tempDir, 'subdir');
      if (!fs.existsSync(workdirPath)) {
        fs.mkdirSync(workdirPath, { recursive: true });
      }

      const wdWorkflowPath = path.join(tempDir, 'wd-workflow.yml');
      fs.writeFileSync(
        wdWorkflowPath,
        `
name: Working Directory Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Check directory
        run: pwd
        working-directory: ${workdirPath}
`
      );

      const result = await executeWorkflow(wdWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('subdir');

      // Cleanup
      fs.unlinkSync(wdWorkflowPath);
      fs.rmdirSync(workdirPath);
    });

    it('should record execution duration', async () => {
      const workflowPath = path.join(fixturesDir, 'echo-workflow.yml');

      const result = await executeWorkflow(workflowPath);

      expect(result.duration).toBeGreaterThan(0);
      expect(result.jobs[0].duration).toBeGreaterThan(0);
      expect(result.jobs[0].steps[0].duration).toBeGreaterThan(0);
    });

    it('should handle errors gracefully', async () => {
      const result = await executeWorkflow('/nonexistent/path.yml');

      expect(result.success).toBe(false);
      expect(result.jobs).toEqual([]);
    });
  });

  describe('Remote Action Support', () => {
    it('should attempt to fetch and execute remote actions', async () => {
      // This test requires network access to fetch real remote actions
      if (process.env.CI || !process.env.RUN_NETWORK_TESTS) {
        return;
      }

      // Create a simple workflow that uses remote actions but doesn't run npm test
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const remoteActionWorkflowPath = path.join(
        tempDir,
        'remote-action-workflow.yml'
      );
      fs.writeFileSync(
        remoteActionWorkflowPath,
        `
name: Remote Action Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3
      - name: Setup Node
        uses: actions/setup-node@v3
      - name: Echo
        run: echo "Done"
`
      );

      const result = await executeWorkflow(remoteActionWorkflowPath);

      // Remote actions will be fetched and attempted
      // They may fail because they need GitHub context, but fetching should work
      // The workflow may stop early if actions fail
      expect(result.jobs.length).toBeGreaterThan(0);
      expect(result.jobs[0].steps.length).toBeGreaterThan(0);

      // Cleanup
      fs.unlinkSync(remoteActionWorkflowPath);
    }, 30000); // Increase timeout for remote fetching

    it('should execute composite actions from remote', async () => {
      // Skip this test unless network tests are enabled
      if (process.env.CI || !process.env.RUN_NETWORK_TESTS) {
        return;
      }

      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const compositeActionWorkflowPath = path.join(
        tempDir,
        'composite-action-workflow.yml'
      );
      fs.writeFileSync(
        compositeActionWorkflowPath,
        `
name: Composite Action Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Use composite action
        uses: actions/hello-world-composite-action@v1
        with:
          who-to-greet: 'GitHub'
`
      );

      const result = await executeWorkflow(compositeActionWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps.length).toBe(1);
      expect(result.jobs[0].steps[0].success).toBe(true);

      // Cleanup
      fs.unlinkSync(compositeActionWorkflowPath);
    }, 60000); // 60 second timeout for network and execution
  });
});
