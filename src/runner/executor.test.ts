import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolveContainerRuntimeMock = vi.fn();
const fetchActionMock = vi.fn();

vi.mock('./container-runtime', async () => {
  const actual = await vi.importActual('./container-runtime');
  return {
    ...actual,
    resolveContainerRuntime: (...args: unknown[]) =>
      resolveContainerRuntimeMock(...args)
  };
});

vi.mock('./action-fetcher', async () => {
  const actual =
    await vi.importActual<typeof import('./action-fetcher')>(
      './action-fetcher'
    );
  return {
    ...actual,
    fetchAction: (...args: [string]) => fetchActionMock(...args)
  };
});

import { executeWorkflow, parseRepositoryFromRemote } from './executor';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

type ExecCall = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

/** A fake ContainerRuntime whose job-container `exec` echoes the command. */
function fakeJobContainerRuntime(
  execImpl?: (
    id: string,
    opts: ExecCall
  ) => Partial<{ success: boolean; stdout: string; exitCode: number }>
) {
  return {
    name: 'docker' as const,
    isAvailable: vi.fn().mockResolvedValue(true),
    execute: vi.fn(),
    build: vi.fn(),
    start: vi.fn().mockResolvedValue({ success: true, id: 'ctr-1' }),
    exec: vi.fn().mockImplementation(async (id: string, opts: ExecCall) => ({
      success: true,
      stdout: `ran: ${opts.command ?? opts.args?.join(' ')}\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      ...(execImpl ? execImpl(id, opts) : {})
    })),
    stop: vi.fn().mockResolvedValue(undefined),
    stopSync: vi.fn()
  };
}

/** The exec calls that ran a step's script (not runtime probes). */
function stepExecCalls(fake: ReturnType<typeof fakeJobContainerRuntime>) {
  return fake.exec.mock.calls
    .map((c) => c[1] as ExecCall & { workingDir?: string })
    .filter((c) => /\/script\.[a-z0-9]*'?$/.test(c.command ?? ''));
}

describe('Executor', () => {
  const fixturesDir = path.join(__dirname, '../../test/fixtures');
  const tempTestDir = path.join(os.tmpdir(), 'secureci-test');

  // Keep tests hermetic when the suite itself runs in GitHub Actions (or in
  // the SecureCI CLI): the github context prefers $GITHUB_* / $RUNNER_* from the host.
  let savedRunnerEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedRunnerEnv = {};
    for (const key of Object.keys(process.env)) {
      if (/^(GITHUB|RUNNER)_/.test(key)) {
        savedRunnerEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
  });
  afterEach(() => {
    Object.assign(process.env, savedRunnerEnv);
  });

  beforeEach(async () => {
    resolveContainerRuntimeMock.mockReset();
    resolveContainerRuntimeMock.mockResolvedValue(null);

    // Default fetchAction to the real implementation; individual tests can
    // override with fetchActionMock.mockResolvedValueOnce(...).
    const actual =
      await vi.importActual<typeof import('./action-fetcher')>(
        './action-fetcher'
      );
    fetchActionMock.mockReset();
    fetchActionMock.mockImplementation((uses: string) =>
      actual.fetchAction(uses)
    );
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

    it('should expose workflow-level and job-level env vars to run commands', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const workflowPath = path.join(tempDir, 'env-propagation-workflow.yml');
      fs.writeFileSync(
        workflowPath,
        `
name: Env Propagation Workflow
on: push

env:
  WORKFLOW_VAR: from-workflow

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      JOB_VAR: from-job
    steps:
      - name: Print env vars
        run: echo "wf=$WORKFLOW_VAR job=$JOB_VAR"
`
      );

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain(
        'wf=from-workflow job=from-job'
      );

      fs.unlinkSync(workflowPath);
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

      const logSpy = vi
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

      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const result = await executeWorkflow(containerWorkflowPath, {
        containerRuntime: 'docker',
        containerImage: 'node:20'
      });

      expect(result.success).toBe(true);
      expect(resolveContainerRuntimeMock).toHaveBeenCalledWith('docker');
      expect(fake.start).toHaveBeenCalledTimes(1);
      expect(fake.start).toHaveBeenCalledWith(
        expect.objectContaining({
          image: 'node:20',
          workingDir: process.cwd(),
          networkDisabled: false
        })
      );
      expect(fake.exec).toHaveBeenCalledWith(
        'ctr-1',
        expect.objectContaining({
          command: expect.stringMatching(
            /-eo pipefail '\/secureci-exchange\/step-[^/]+\/script\.sh'$/
          ),
          workingDir: '/secureci-workspace',
          env: expect.objectContaining({
            GITHUB_WORKSPACE: '/secureci-workspace',
            GITHUB_OUTPUT: expect.stringMatching(/^\/secureci-exchange\//)
          })
        })
      );
      expect(fake.stop).toHaveBeenCalledWith('ctr-1');

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
      // The step after the failure is recorded as skipped, as on GitHub.
      expect(result.jobs[0].steps.length).toBe(3);
      expect(result.jobs[0].steps[2].outcome).toBe('skipped');
      expect(result.jobs[0].steps[2].output).not.toContain('should not run');

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

      const ifJobWorkflowPath = path.join(tempDir, 'if-skip-job-workflow.yml');
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

    it('should run a job once per matrix combination', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const matrixWorkflowPath = path.join(tempDir, 'matrix-workflow.yml');
      fs.writeFileSync(
        matrixWorkflowPath,
        `
name: Matrix Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [16, 18]
        os: [linux]
    steps:
      - name: Print matrix
        run: echo "node=\${{ matrix.node }} os=\${{ matrix.os }}"
`
      );

      const result = await executeWorkflow(matrixWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs.length).toBe(2);
      expect(result.jobs[0].job).toContain('node: 16');
      expect(result.jobs[1].job).toContain('node: 18');
      expect(result.jobs[0].steps[0].output).toContain('node=16 os=linux');
      expect(result.jobs[1].steps[0].output).toContain('node=18 os=linux');

      fs.unlinkSync(matrixWorkflowPath);
    });

    it('should stop remaining matrix combinations on failure when fail-fast is enabled', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const matrixFailWorkflowPath = path.join(
        tempDir,
        'matrix-fail-workflow.yml'
      );
      fs.writeFileSync(
        matrixFailWorkflowPath,
        `
name: Matrix Fail Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [16, 18]
    steps:
      - name: Fail on 16
        run: '[ "\${{ matrix.node }}" = "18" ] || exit 1'
`
      );

      const result = await executeWorkflow(matrixFailWorkflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].job).toContain('node: 16');

      fs.unlinkSync(matrixFailWorkflowPath);
    });

    it('should expose github context values in run commands', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const githubCtxWorkflowPath = path.join(
        tempDir,
        'github-context-workflow.yml'
      );
      fs.writeFileSync(
        githubCtxWorkflowPath,
        `
name: Github Context Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Print workflow name
        run: echo "workflow=\${{ github.workflow }} job=\${{ github.job }}"
`
      );

      const result = await executeWorkflow(githubCtxWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain(
        'workflow=Github Context Workflow job=test'
      );

      fs.unlinkSync(githubCtxWorkflowPath);
    });

    it('should execute a local reusable workflow call', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const reusableWorkflowPath = path.join(tempDir, 'reusable-target.yml');
      fs.writeFileSync(
        reusableWorkflowPath,
        `
name: Reusable Target
on:
  workflow_call:
    inputs:
      username:
        required: true
        type: string
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - name: Greet
        run: echo "Hello \${{ inputs.username }}"
`
      );

      const callerWorkflowPath = path.join(tempDir, 'reusable-caller.yml');
      fs.writeFileSync(
        callerWorkflowPath,
        `
name: Reusable Caller
on: push
jobs:
  call-reusable:
    uses: ./reusable-target.yml
    with:
      username: test-user
`
      );

      const result = await executeWorkflow(callerWorkflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].job).toBe('call-reusable');
      expect(result.jobs[0].steps[0].output).toContain('Hello test-user');

      fs.unlinkSync(reusableWorkflowPath);
      fs.unlinkSync(callerWorkflowPath);
    });

    it('should warn and skip remote reusable workflow calls', async () => {
      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const remoteCallerPath = path.join(tempDir, 'remote-reusable-caller.yml');
      fs.writeFileSync(
        remoteCallerPath,
        `
name: Remote Reusable Caller
on: push
jobs:
  call-remote:
    uses: some-org/some-repo/.github/workflows/reusable.yml@main
`
      );

      const result = await executeWorkflow(remoteCallerPath);

      expect(result.jobs.length).toBe(1);
      expect(result.jobs[0].job).toBe('call-remote');
      expect(result.jobs[0].success).toBe(true);
      expect(result.jobs[0].steps.length).toBe(0);

      fs.unlinkSync(remoteCallerPath);
    });

    it('should build and run a Docker-type action, substituting input expressions into args', async () => {
      const dockerActionPath = path.join(
        fixturesDir,
        'docker-action',
        'action.yml'
      );
      fetchActionMock.mockResolvedValueOnce(dockerActionPath);

      const buildMock = vi
        .fn()
        .mockResolvedValue({ success: true, stdout: '', stderr: '' });
      const executeMock = vi.fn().mockResolvedValue({
        success: true,
        stdout: 'hello docker\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 10
      });
      resolveContainerRuntimeMock.mockResolvedValue({
        ...fakeJobContainerRuntime(),
        build: buildMock,
        execute: executeMock
      });

      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const workflowPath = path.join(tempDir, 'docker-action-workflow.yml');
      fs.writeFileSync(
        workflowPath,
        `
name: Docker Action Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run docker action
        uses: test-org/docker-action@v1
        with:
          message: 'hello docker'
`
      );

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker'
      });

      expect(buildMock).toHaveBeenCalledTimes(1);
      expect(buildMock).toHaveBeenCalledWith(
        path.dirname(dockerActionPath),
        expect.stringMatching(/^secureci-action-/),
        'Dockerfile'
      );

      expect(executeMock).toHaveBeenCalledTimes(1);
      const executeArgs = executeMock.mock.calls[0][0];
      expect(executeArgs.args).toEqual(['hello docker']);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('hello docker');

      fs.unlinkSync(workflowPath);
    });

    it('should fail (not skip) a Docker action step when no container runtime is available', async () => {
      const dockerActionPath = path.join(
        fixturesDir,
        'docker-action',
        'action.yml'
      );
      fetchActionMock.mockResolvedValueOnce(dockerActionPath);
      resolveContainerRuntimeMock.mockResolvedValue(null);

      const tempDir = tempTestDir;
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      const workflowPath = path.join(
        tempDir,
        'docker-action-no-runtime-workflow.yml'
      );
      fs.writeFileSync(
        workflowPath,
        `
name: Docker Action No Runtime Workflow
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run docker action
        uses: test-org/docker-action@v1
        with:
          message: 'hello docker'
`
      );

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].success).toBe(false);
      expect(result.jobs[0].steps[0].error).toContain('No container runtime');

      fs.unlinkSync(workflowPath);
    });
  });

  describe('expression substitution in env: and with:', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-subst-'));
    });

    function writeWorkflow(content: string): string {
      const file = path.join(tempDir, 'workflow.yml');
      fs.writeFileSync(file, content);
      return file;
    }

    function writeAction(dir: string, files: Record<string, string>): string {
      const actionDir = path.join(tempDir, dir);
      fs.mkdirSync(actionDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(actionDir, name), content);
      }
      return path.join(actionDir, 'action.yml');
    }

    it('substitutes expressions in workflow, job and step env', async () => {
      const workflowPath = writeWorkflow(`
name: Env Subst
on: push
env:
  W: wf-\${{ inputs.q }}
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      J: job-\${{ env.W }}-\${{ matrix.n }}
    strategy:
      matrix:
        n: [1]
    steps:
      - id: first
        run: echo "val=out" >> $GITHUB_OUTPUT
      - run: echo "W=$W J=$J S=$S"
        env:
          S: step-\${{ env.J }}-\${{ steps.first.outputs.val }}
`);

      const result = await executeWorkflow(workflowPath, {
        inputs: { q: 'hello' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[1].output).toContain(
        'W=wf-hello J=job-wf-hello-1 S=step-job-wf-hello-1-out'
      );
    });

    it('passes secrets referenced from step env to the step', async () => {
      const workflowPath = writeWorkflow(`
name: Secret Env
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: printf '%s' "$TOKEN" | wc -c
        env:
          TOKEN: \${{ secrets.TOKEN }}
`);

      const result = await executeWorkflow(workflowPath, {
        secrets: { TOKEN: 'abc==' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output?.trim()).toBe('5');
    });

    it('stringifies non-string env values', async () => {
      const workflowPath = writeWorkflow(`
name: Number Env
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      PORT: 3000
      DEBUG: true
    steps:
      - run: echo "port=$PORT debug=$DEBUG"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.jobs[0].steps[0].output).toContain('port=3000 debug=true');
    });

    it('substitutes with: values for JavaScript actions', async () => {
      const actionPath = writeAction('js-action', {
        'action.yml': `
name: JS Echo
description: Echo an input
inputs:
  greeting:
    description: greeting
runs:
  using: node20
  main: index.js
`,
        'index.js': 'console.log("greeting=" + process.env.INPUT_GREETING);'
      });
      fetchActionMock.mockResolvedValueOnce(actionPath);

      const workflowPath = writeWorkflow(`
name: JS With
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/js-action@v1
        with:
          greeting: hi-\${{ inputs.who }}
`);

      const result = await executeWorkflow(workflowPath, {
        inputs: { who: 'there' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('greeting=hi-there');
    });

    it('substitutes with: values for composite actions', async () => {
      const actionPath = writeAction('composite-action', {
        'action.yml': `
name: Composite Echo
description: Echo an input
inputs:
  greeting:
    description: greeting
outputs:
  said:
    value: \${{ steps.say.outputs.said }}
runs:
  using: composite
  steps:
    - id: say
      shell: bash
      run: echo "said=\${{ inputs.greeting }}" >> $GITHUB_OUTPUT
`
      });
      fetchActionMock.mockResolvedValueOnce(actionPath);

      const workflowPath = writeWorkflow(`
name: Composite With
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/composite-action@v1
        with:
          greeting: hi-\${{ inputs.who }}
`);

      const result = await executeWorkflow(workflowPath, {
        inputs: { who: 'there' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].outputs).toEqual({ said: 'hi-there' });
    });

    it('does not leak workflow inputs into a composite action and applies input defaults', async () => {
      const actionPath = writeAction('composite-inputs', {
        'action.yml': `
name: Composite Inputs
description: Echo inputs
inputs:
  greeting:
    description: greeting
    default: hello-\${{ github.event_name }}
  q:
    description: shadowed by a workflow input of the same name
outputs:
  said:
    value: \${{ steps.say.outputs.said }}
runs:
  using: composite
  steps:
    - id: say
      shell: bash
      run: echo "said=\${{ inputs.greeting }}/\${{ inputs.q }}/$CALLER" >> $GITHUB_OUTPUT
`
      });
      fetchActionMock.mockResolvedValueOnce(actionPath);

      const workflowPath = writeWorkflow(`
name: Composite Inputs
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    env:
      CALLER: from-job
    steps:
      - uses: local/composite-inputs@v1
`);

      const result = await executeWorkflow(workflowPath, {
        inputs: { q: 'workflow-input' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].outputs).toEqual({
        said: 'hello-push//from-job'
      });
    });

    it('applies action input defaults for JavaScript actions', async () => {
      const actionPath = writeAction('js-defaults', {
        'action.yml': `
name: JS Defaults
description: Echo inputs
inputs:
  greeting:
    description: greeting
    default: hi
  who:
    description: who
    default: nobody
runs:
  using: node20
  main: index.js
`,
        'index.js':
          'console.log(process.env.INPUT_GREETING + "/" + process.env.INPUT_WHO);'
      });
      fetchActionMock.mockResolvedValueOnce(actionPath);

      const workflowPath = writeWorkflow(`
name: JS Defaults
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/js-defaults@v1
        with:
          who: world
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('hi/world');
    });
  });

  describe('runner environment (file commands, workflow commands, JS actions)', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-runner-'));
    });

    function writeWorkflow(content: string): string {
      const file = path.join(tempDir, 'workflow.yml');
      fs.writeFileSync(file, content);
      return file;
    }

    function writeAction(dir: string, files: Record<string, string>): string {
      const actionDir = path.join(tempDir, dir);
      fs.mkdirSync(actionDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(actionDir, name), content);
      }
      return path.join(actionDir, 'action.yml');
    }

    it('propagates $GITHUB_ENV and $GITHUB_PATH to later run: steps', async () => {
      const binDir = path.join(tempDir, 'bin');
      fs.mkdirSync(binDir);
      fs.writeFileSync(
        path.join(binDir, 'secureci-hello'),
        '#!/bin/sh\necho hi-from-path\n',
        {
          mode: 0o755
        }
      );

      const workflowPath = writeWorkflow(`
name: File Commands
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "FOO=bar" >> $GITHUB_ENV
          echo "${binDir}" >> $GITHUB_PATH
      - run: echo "foo=$FOO expr=\${{ env.FOO }} $(secureci-hello)"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[1].output).toContain(
        'foo=bar expr=bar hi-from-path'
      );
    });

    it('exports default GITHUB_* variables to run: steps', async () => {
      const workflowPath = writeWorkflow(`
name: Runner Vars
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "job=$GITHUB_JOB wf=$GITHUB_WORKFLOW ws=$GITHUB_WORKSPACE ci=$CI event=$(cat "$GITHUB_EVENT_PATH")"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.jobs[0].steps[0].output).toContain(
        `job=build wf=Runner Vars ws=${process.cwd()} ci=true event={}`
      );
    });

    it('masks values registered via ::add-mask:: in later log output', async () => {
      const workflowPath = writeWorkflow(`
name: Add Mask
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "::add-mask::dynamic-secret-987"
      - run: echo "value is dynamic-secret-987"
`);

      const logSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => undefined);
      try {
        const result = await executeWorkflow(workflowPath);
        expect(result.success).toBe(true);
        const logged = logSpy.mock.calls
          .flat()
          .filter((v): v is string => typeof v === 'string');
        expect(logged.some((l) => l.includes('dynamic-secret-987'))).toBe(
          false
        );
        expect(logged.some((l) => l.includes('value is ***'))).toBe(true);
      } finally {
        logSpy.mockRestore();
      }
    });

    it('runs JavaScript actions in the workspace with file commands wired up', async () => {
      const actionPath = writeAction('js-env', {
        'action.yml': `
name: JS Env
description: Inspect the runner env
runs:
  using: node20
  main: index.js
`,
        'index.js': `
const fs = require('fs');
console.log('cwd=' + process.cwd());
console.log('actionPath=' + process.env.GITHUB_ACTION_PATH);
console.log('job=' + process.env.GITHUB_JOB + ' caller=' + process.env.CALLER);
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'result=ok\\n');
fs.appendFileSync(process.env.GITHUB_ENV, 'FROM_JS=yes\\n');
console.log('::set-output name=legacy::old-style');
`
      });
      fetchActionMock.mockResolvedValueOnce(actionPath);

      const workflowPath = writeWorkflow(`
name: JS Runner Env
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      CALLER: from-job
    steps:
      - id: js
        uses: local/js-env@v1
      - run: echo "out=\${{ steps.js.outputs.result }} legacy=\${{ steps.js.outputs.legacy }} env=$FROM_JS"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      const jsOutput = result.jobs[0].steps[0].output;
      expect(jsOutput).toContain(`cwd=${process.cwd()}`);
      expect(jsOutput).toContain(`actionPath=${path.dirname(actionPath)}`);
      expect(jsOutput).toContain('job=build caller=from-job');
      expect(result.jobs[0].steps[0].outputs).toEqual({
        result: 'ok',
        legacy: 'old-style'
      });
      expect(result.jobs[0].steps[1].output).toContain(
        'out=ok legacy=old-style env=yes'
      );
    });

    it('names INPUT_* variables the way @actions/core reads them (hyphens kept)', async () => {
      const actionPath = writeAction('js-hyphen', {
        'action.yml': `
name: JS Hyphen
description: hyphenated input
inputs:
  who-to-greet:
    description: who
runs:
  using: node20
  main: index.js
`,
        'index.js': 'console.log("who=" + process.env["INPUT_WHO-TO-GREET"]);'
      });
      fetchActionMock.mockResolvedValueOnce(actionPath);

      const workflowPath = writeWorkflow(`
name: Hyphen
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/js-hyphen@v1
        with:
          who-to-greet: secureci
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.jobs[0].steps[0].output).toContain('who=secureci');
    });

    it('runs pre before main and post at job end, passing state via $GITHUB_STATE', async () => {
      const actionPath = writeAction('js-lifecycle', {
        'action.yml': `
name: JS Lifecycle
description: pre/main/post
runs:
  using: node20
  pre: pre.js
  main: main.js
  post: post.js
`,
        'pre.js': 'console.log("phase=pre");',
        'main.js': `
require('fs').appendFileSync(process.env.GITHUB_STATE, 'token=from-main\\n');
console.log('phase=main');
`,
        'post.js': 'console.log("phase=post state=" + process.env.STATE_token);'
      });
      fetchActionMock.mockResolvedValueOnce(actionPath);

      const workflowPath = writeWorkflow(`
name: Lifecycle
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/js-lifecycle@v1
      - run: echo "phase=later-step"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      const outputs = result.jobs[0].steps.map((s) => s.output || '');
      expect(outputs[0]).toMatch(/phase=pre[\s\S]*phase=main/);
      expect(outputs[1]).toContain('phase=later-step');
      expect(outputs[2]).toContain('phase=post state=from-main');
      expect(result.jobs[0].steps).toHaveLength(3);
    });

    it('runs post steps after a failure by default, and honours post-if', async () => {
      const actionPath = writeAction('js-post-if', {
        'action.yml': `
name: JS Post If
description: post-if
runs:
  using: node20
  main: main.js
  post: post.js
  post-if: success()
`,
        'main.js': 'console.log("main");',
        'post.js': 'console.log("conditional-post");'
      });
      const alwaysPath = writeAction('js-post-always', {
        'action.yml': `
name: JS Post Always
description: post always
runs:
  using: node20
  main: main.js
  post: post.js
`,
        'main.js': 'console.log("main");',
        'post.js': 'console.log("always-post");'
      });
      fetchActionMock
        .mockResolvedValueOnce(actionPath)
        .mockResolvedValueOnce(alwaysPath);

      const workflowPath = writeWorkflow(`
name: Post If
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/js-post-if@v1
      - uses: local/js-post-always@v1
      - run: exit 1
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
      const outputs = result.jobs[0].steps.map((s) => s.output || '');
      expect(outputs.some((o) => o.includes('always-post'))).toBe(true);
      expect(outputs.some((o) => o.includes('conditional-post'))).toBe(false);
    });
  });

  describe('job containers', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-jobctr-'));
    });

    function writeWorkflow(content: string): string {
      const file = path.join(tempDir, 'workflow.yml');
      fs.writeFileSync(file, content);
      return file;
    }

    it('starts one container per job, execs every step into it and removes it', async () => {
      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: One Container
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
      - run: echo two
        working-directory: sub
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo three
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker'
      });

      expect(result.success).toBe(true);
      expect(fake.start).toHaveBeenCalledTimes(2);
      const stepCalls = stepExecCalls(fake);
      expect(stepCalls).toHaveLength(3);
      expect(stepCalls[1]).toMatchObject({
        workingDir: '/secureci-workspace/sub'
      });
      expect(fake.start.mock.calls[0][0]).toMatchObject({
        image: 'catthehacker/ubuntu:act-latest'
      });
      expect(fake.stop).toHaveBeenCalledTimes(2);
    });

    it('honours jobs.<id>.container (string and object form)', async () => {
      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: Job Container
on: push
jobs:
  short:
    runs-on: ubuntu-latest
    container: node:20
    steps:
      - run: echo a
  long:
    runs-on: ubuntu-latest
    container:
      image: python:3.12
      env:
        FROM_CONTAINER: \${{ inputs.flavour }}
    steps:
      - run: echo b
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker',
        containerImage: 'ignored:latest',
        inputs: { flavour: 'spicy' }
      });

      expect(result.success).toBe(true);
      expect(fake.start.mock.calls[0][0]).toMatchObject({ image: 'node:20' });
      expect(fake.start.mock.calls[1][0]).toMatchObject({
        image: 'python:3.12',
        env: { FROM_CONTAINER: 'spicy' }
      });
    });

    describe('image resolution (#32)', () => {
      const imageWorkflow = `
name: Images
on: push
jobs:
  latest:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  jammy:
    runs-on: [self-hosted, ubuntu-22.04]
    steps: [{ run: echo }]
  custom:
    runs-on: my-runner
    steps: [{ run: echo }]
  mac:
    runs-on: macos-latest
    steps: [{ run: echo }]
  matrix:
    strategy:
      matrix:
        os: [ubuntu-24.04]
    runs-on: \${{ matrix.os }}
    steps: [{ run: echo }]
  pinned:
    runs-on: ubuntu-latest
    container: node:20
    steps: [{ run: echo }]
`;

      async function imagesFor(options: Record<string, unknown>) {
        const fake = fakeJobContainerRuntime();
        resolveContainerRuntimeMock.mockResolvedValue(fake);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          await executeWorkflow(writeWorkflow(imageWorkflow), {
            containerRuntime: 'docker',
            ...options
          });
          const output = [...warnSpy.mock.calls, ...logSpy.mock.calls]
            .flat()
            .join('\n');
          return {
            images: fake.start.mock.calls.map(
              (c) => (c[0] as { image: string }).image
            ),
            output
          };
        } finally {
          warnSpy.mockRestore();
          logSpy.mockRestore();
        }
      }

      it('maps runs-on labels to runner-like images by default', async () => {
        const { images, output } = await imagesFor({});
        expect(images).toEqual([
          'catthehacker/ubuntu:act-latest',
          'catthehacker/ubuntu:act-22.04',
          'catthehacker/ubuntu:act-22.04',
          'catthehacker/ubuntu:act-22.04',
          'catthehacker/ubuntu:act-24.04',
          'node:20'
        ]);
        expect(output).toContain('runs-on "my-runner" has no image mapping');
        expect(output).toMatch(/runs-on "macos-latest".*Linux container/);
      });

      it('lets runner-images override and extend the built-in mapping', async () => {
        const { images } = await imagesFor({
          runnerImages: { 'ubuntu-latest': 'node:22', 'my-runner': 'alpine:3' }
        });
        expect(images.slice(0, 3)).toEqual([
          'node:22',
          'catthehacker/ubuntu:act-22.04',
          'alpine:3'
        ]);
      });

      it('uses defaultContainerImage only for labels with no mapping', async () => {
        const { images } = await imagesFor({
          defaultContainerImage: 'debian:12'
        });
        expect(images).toEqual([
          'catthehacker/ubuntu:act-latest',
          'catthehacker/ubuntu:act-22.04',
          'debian:12',
          'debian:12',
          'catthehacker/ubuntu:act-24.04',
          'node:20'
        ]);
      });

      it('--container-image wins over runs-on, jobs.<id>.container over both', async () => {
        const { images } = await imagesFor({
          containerImage: 'flag:1',
          runnerImages: { 'ubuntu-latest': 'node:22' }
        });
        expect(images).toEqual([
          'flag:1',
          'flag:1',
          'flag:1',
          'flag:1',
          'flag:1',
          'node:20'
        ]);
      });
    });

    it('passes networkDisabled through when networking is turned off', async () => {
      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: No Network
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
`);

      await executeWorkflow(workflowPath, {
        containerRuntime: 'docker',
        networkDisabled: true
      });

      expect(fake.start.mock.calls[0][0]).toMatchObject({
        networkDisabled: true
      });
    });

    it('removes the container even when a step fails', async () => {
      const fake = fakeJobContainerRuntime(() => ({
        success: false,
        exitCode: 2
      }));
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: Failing
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: exit 2
      - run: echo never
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker'
      });

      expect(result.success).toBe(false);
      expect(stepExecCalls(fake)).toHaveLength(1);
      expect(fake.stop).toHaveBeenCalledWith('ctr-1');
    });

    it('fails the job when its container cannot be started', async () => {
      const fake = fakeJobContainerRuntime();
      fake.start.mockResolvedValue({ success: false, error: 'no such image' });
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: Bad Image
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    container: does-not-exist:latest
    steps:
      - run: echo a
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker'
      });

      expect(result.success).toBe(false);
      expect(fake.exec).not.toHaveBeenCalled();
      expect(fake.stop).not.toHaveBeenCalled();
    });

    it('runs JavaScript actions inside the job container', async () => {
      const actionDir = path.join(tempDir, 'js-action');
      fs.mkdirSync(actionDir);
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        `
name: JS In Container
description: test
inputs:
  who-to-greet:
    description: who
runs:
  using: node20
  main: dist/index.js
`
      );
      fs.mkdirSync(path.join(actionDir, 'dist'));
      fs.writeFileSync(path.join(actionDir, 'dist', 'index.js'), '');
      fetchActionMock.mockResolvedValueOnce(path.join(actionDir, 'action.yml'));

      const fake = fakeJobContainerRuntime((_id, opts) =>
        opts.command?.includes('command -v node')
          ? { stdout: '/usr/local/bin/node\n/usr/local/bin:/usr/bin:/bin\n' }
          : {}
      );
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: JS Container
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/js-action@v1
        with:
          who-to-greet: secureci
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker'
      });

      expect(result.success).toBe(true);
      const calls = fake.exec.mock.calls.map((c) => c[1] as ExecCall);
      const nodeCall = calls.find((c) => c.args);
      expect(nodeCall?.args?.[0]).toBe('/usr/local/bin/node');
      expect(nodeCall?.args?.[1]).toMatch(
        /^\/secureci-exchange\/actions\/[0-9a-f]+\/dist\/index\.js$/
      );
      expect(nodeCall?.env).toMatchObject({
        'INPUT_WHO-TO-GREET': 'secureci',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        GITHUB_ACTION_PATH: expect.stringMatching(
          /^\/secureci-exchange\/actions\//
        )
      });
    });

    it('fails a JavaScript action clearly when the image has no node', async () => {
      const actionDir = path.join(tempDir, 'js-action');
      fs.mkdirSync(actionDir);
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        `
name: JS No Node
description: test
runs:
  using: node20
  main: index.js
`
      );
      fs.writeFileSync(path.join(actionDir, 'index.js'), '');
      fetchActionMock.mockResolvedValueOnce(path.join(actionDir, 'action.yml'));

      const fake = fakeJobContainerRuntime((_id, opts) =>
        opts.command?.includes('command -v node')
          ? { success: false, exitCode: 1 }
          : {}
      );
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: JS No Node
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: local/js-action@v1
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker'
      });

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].error).toMatch(
        /needs `node` in the job container image \(catthehacker\/ubuntu:act-latest\)/
      );
    });

    it('warns and runs on the host when jobs.<id>.container is set but runtime is none', async () => {
      const workflowPath = writeWorkflow(`
name: Host
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    container: node:20
    steps:
      - run: echo on-host
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'none'
      });

      expect(result.success).toBe(true);
      expect(resolveContainerRuntimeMock).not.toHaveBeenCalled();
      expect(result.jobs[0].steps[0].output).toContain('on-host');
    });

    // Real-engine check: opt in with RUN_DOCKER_TESTS=1 (needs a running
    // docker daemon and network access to pull images).
    it.skipIf(!process.env.RUN_DOCKER_TESTS)(
      'keeps state between steps and runs JS actions in a real container',
      async () => {
        const actual = await vi.importActual<
          typeof import('./container-runtime')
        >('./container-runtime');
        resolveContainerRuntimeMock.mockImplementation(
          actual.resolveContainerRuntime
        );

        const actionDir = path.join(tempDir, 'js-action');
        fs.mkdirSync(actionDir);
        fs.writeFileSync(
          path.join(actionDir, 'action.yml'),
          `
name: JS Real
description: test
inputs:
  who-to-greet:
    description: who
runs:
  using: node20
  main: index.js
`
        );
        fs.writeFileSync(
          path.join(actionDir, 'index.js'),
          `
const fs = require('fs');
console.log('hello ' + process.env['INPUT_WHO-TO-GREET'] + ' from ' + process.version);
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'marker=' + fs.readFileSync('/root/marker', 'utf8').trim() + '\\n');
fs.appendFileSync(process.env.GITHUB_PATH, '/opt/secureci-bin\\n');
`
        );
        fetchActionMock.mockResolvedValueOnce(
          path.join(actionDir, 'action.yml')
        );

        const workflowPath = writeWorkflow(`
name: Real Container
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo persisted > /root/marker
          mkdir -p /opt/secureci-bin
          printf '#!/bin/sh\\necho from-path\\n' > /opt/secureci-bin/secureci-hi
          chmod +x /opt/secureci-bin/secureci-hi
      - id: js
        uses: local/js-action@v1
        with:
          who-to-greet: container
      - run: echo "marker=\${{ steps.js.outputs.marker }} $(secureci-hi) $(cat /root/marker)"
`);

        const result = await executeWorkflow(workflowPath, {
          containerRuntime: 'docker',
          containerImage: 'node:20-bookworm-slim'
        });

        expect(result.success).toBe(true);
        expect(result.jobs[0].steps[1].output).toContain(
          'hello container from v20'
        );
        expect(result.jobs[0].steps[2].output).toContain(
          'marker=persisted from-path persisted'
        );
      },
      180000
    );
  });

  describe('run: shell semantics', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-shell-'));
    });

    function writeWorkflow(content: string): string {
      const file = path.join(tempDir, 'workflow.yml');
      fs.writeFileSync(file, content);
      return file;
    }

    it('fails a step at the first failing command (bash -e)', async () => {
      const workflowPath = writeWorkflow(`
name: Errexit
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: |
          false
          echo "should not run"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].output ?? '').not.toContain(
        'should not run'
      );
    });

    it('fails a step when any command in a pipeline fails (pipefail)', async () => {
      const workflowPath = writeWorkflow(`
name: Pipefail
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: false | true
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
    });

    it('honours defaults.run.working-directory and shell at workflow and job level', async () => {
      fs.mkdirSync(path.join(process.cwd(), '.secureci-test-wd', 'wf'), {
        recursive: true
      });
      fs.mkdirSync(path.join(process.cwd(), '.secureci-test-wd', 'job'), {
        recursive: true
      });
      const workflowPath = writeWorkflow(`
name: Defaults
on: push
defaults:
  run:
    working-directory: .secureci-test-wd/wf
jobs:
  wf:
    runs-on: ubuntu-latest
    steps:
      - run: echo "dir=$(basename "$PWD") bash=\${BASH_VERSION:+yes}"
  job:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: .secureci-test-wd/job
        shell: sh
    steps:
      - run: echo "dir=$(basename "$PWD") bash=\${BASH_VERSION:+yes}"
      - run: echo "dir=$(basename "$PWD")"
        working-directory: .secureci-test-wd
`);

      try {
        const result = await executeWorkflow(workflowPath);

        expect(result.success).toBe(true);
        expect(result.jobs[0].steps[0].output).toContain('dir=wf bash=yes');
        expect(result.jobs[1].steps[0].output).toContain('dir=job bash=\n');
        expect(result.jobs[1].steps[1].output).toContain(
          'dir=.secureci-test-wd'
        );
      } finally {
        fs.rmSync(path.join(process.cwd(), '.secureci-test-wd'), {
          recursive: true,
          force: true
        });
      }
    });

    it('supports custom shell templates with {0}', async () => {
      const workflowPath = writeWorkflow(`
name: Custom Shell
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: console.log("from " + "node")
        shell: node {0}
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('from node');
    });

    it('runs container steps through the shell template with a script file', async () => {
      let script = '';
      const fake = fakeJobContainerRuntime((_id, opts) => {
        const match = opts.command?.match(/'\/secureci-exchange\/([^']+)'/);
        if (match) {
          // The script lives in the exchange dir mounted from the host.
          const hostExchange = fake.start.mock.calls[0][0].exchangeDir;
          script = fs.readFileSync(path.join(hostExchange, match[1]), 'utf-8');
        }
        return {};
      });
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const workflowPath = writeWorkflow(`
name: Container Shell
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo in-container
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker'
      });

      expect(result.success).toBe(true);
      const commands = fake.exec.mock.calls.map(
        (c) => (c[1] as ExecCall).command ?? ''
      );
      expect(commands).toContainEqual(
        expect.stringMatching(
          /^bash --noprofile --norc -eo pipefail '\/secureci-exchange\/step-[^/]+\/script\.sh'$/
        )
      );
      expect(script).toBe('echo in-container');
    });
  });

  describe('action resolution', () => {
    let tempDir: string;
    const localDir = path.join(process.cwd(), '.secureci-test-actions');

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-resolve-'));
    });

    afterEach(() => {
      fs.rmSync(localDir, { recursive: true, force: true });
    });

    function writeWorkflow(content: string): string {
      const file = path.join(tempDir, 'workflow.yml');
      fs.writeFileSync(file, content);
      return file;
    }

    it('fails the step when a remote action cannot be fetched', async () => {
      fetchActionMock.mockResolvedValueOnce(null);
      const workflowPath = writeWorkflow(`
name: Missing Action
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: does-not-exist/nope@v1
      - run: echo never
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps).toHaveLength(2);
      expect(result.jobs[0].steps[1].outcome).toBe('skipped');
      expect(result.jobs[0].steps[0].error).toMatch(
        /Could not resolve action "does-not-exist\/nope@v1"/
      );
    });

    it('fails the step for an unknown runs.using', async () => {
      fs.mkdirSync(path.join(tempDir, 'weird'));
      fs.writeFileSync(
        path.join(tempDir, 'weird', 'action.yml'),
        'name: Weird\ndescription: d\nruns:\n  using: node99x\n  main: x.js\n'
      );
      fetchActionMock.mockResolvedValueOnce(
        path.join(tempDir, 'weird', 'action.yml')
      );
      const workflowPath = writeWorkflow(`
name: Weird
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: org/weird@v1
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].error).toMatch(
        /Unsupported action type "node99x"/
      );
    });

    it('runs local ./ actions relative to the workspace (action.yml or action.yaml)', async () => {
      fs.mkdirSync(path.join(localDir, 'one'), { recursive: true });
      fs.mkdirSync(path.join(localDir, 'two'), { recursive: true });
      const composite = (msg: string) =>
        `name: Local\ndescription: d\nruns:\n  using: composite\n  steps:\n    - id: say\n      shell: bash\n      run: echo "msg=${msg}" >> $GITHUB_OUTPUT\noutputs:\n  msg:\n    value: \${{ steps.say.outputs.msg }}\n`;
      fs.writeFileSync(
        path.join(localDir, 'one', 'action.yml'),
        composite('one')
      );
      fs.writeFileSync(
        path.join(localDir, 'two', 'action.yaml'),
        composite('two')
      );

      const workflowPath = writeWorkflow(`
name: Local Actions
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.secureci-test-actions/one
      - uses: ./.secureci-test-actions/two
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      expect(fetchActionMock).not.toHaveBeenCalled();
      expect(result.jobs[0].steps[0].outputs).toEqual({ msg: 'one' });
      expect(result.jobs[0].steps[1].outputs).toEqual({ msg: 'two' });
    });

    it('fails clearly when a local action does not exist', async () => {
      const workflowPath = writeWorkflow(`
name: Missing Local
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.secureci-test-actions/nope
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].error).toMatch(
        /Could not resolve action "\.\/\.secureci-test-actions\/nope"/
      );
    });

    it('runs docker:// steps with with.args and with.entrypoint', async () => {
      const executeMock = vi.fn().mockResolvedValue({
        success: true,
        stdout: 'docker-step-ran\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 1
      });
      resolveContainerRuntimeMock.mockResolvedValue({
        ...fakeJobContainerRuntime(),
        execute: executeMock
      });

      const workflowPath = writeWorkflow(`
name: Docker Step
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:3.20
        with:
          entrypoint: /bin/sh
          args: -c "echo \${{ inputs.word }}"
`);

      const result = await executeWorkflow(workflowPath, {
        containerRuntime: 'docker',
        inputs: { word: 'docker-step-ran' }
      });

      expect(result.success).toBe(true);
      expect(fetchActionMock).not.toHaveBeenCalled();
      expect(executeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          image: 'alpine:3.20',
          entrypoint: '/bin/sh',
          args: ['-c', 'echo docker-step-ran']
        })
      );
    });
  });

  describe('needs, job outputs and status functions', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-needs-'));
    });

    function writeWorkflow(content: string): string {
      const file = path.join(tempDir, 'workflow.yml');
      fs.writeFileSync(file, content);
      return file;
    }

    it('exposes jobs.<id>.outputs and result to dependents via needs', async () => {
      const workflowPath = writeWorkflow(`
name: Needs Outputs
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> $GITHUB_OUTPUT
  deploy:
    needs: build
    if: needs.build.outputs.version == '1.2.3'
    runs-on: ubuntu-latest
    steps:
      - run: echo "deploying \${{ needs.build.outputs.version }} (\${{ needs.build.result }})"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].outputs).toEqual({ version: '1.2.3' });
      expect(result.jobs[1].steps[0].output).toContain(
        'deploying 1.2.3 (success)'
      );
    });

    it('runs always()/failure() steps after a failure and skips the rest', async () => {
      const workflowPath = writeWorkflow(`
name: Step Status
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
      - run: echo plain
      - if: failure()
        run: echo "on-failure job.status=\${{ job.status }}"
      - if: always()
        run: echo on-always
      - if: success()
        run: echo on-success
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(false);
      const steps = result.jobs[0].steps;
      expect(
        steps.map((s) => s.outcome ?? (s.success ? 'success' : 'failure'))
      ).toEqual(['failure', 'skipped', 'success', 'success', 'skipped']);
      expect(steps[2].output).toContain('on-failure job.status=failure');
      expect(steps[3].output).toContain('on-always');
    });

    it('applies status functions to jobs whose dependencies failed or were skipped', async () => {
      const workflowPath = writeWorkflow(`
name: Job Status
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  never:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo never
  plain:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo plain
  notify:
    needs: build
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - run: echo "build was \${{ needs.build.result }}"
  cleanup:
    needs: [build, never]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: echo "never was \${{ needs.never.result }}"
  after-skipped:
    needs: never
    runs-on: ubuntu-latest
    steps:
      - run: echo after-skipped
`);

      const result = await executeWorkflow(workflowPath);

      const ran = result.jobs.map((j) => j.job);
      expect(ran).toEqual(['build', 'notify', 'cleanup']);
      expect(result.jobs[1].steps[0].output).toContain('build was failure');
      expect(result.jobs[2].steps[0].output).toContain('never was skipped');
    });

    it('distinguishes steps.<id>.outcome from conclusion under continue-on-error', async () => {
      const workflowPath = writeWorkflow(`
name: Conclusion
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - id: lint
        continue-on-error: true
        run: exit 1
      - run: echo "outcome=\${{ steps.lint.outcome }} conclusion=\${{ steps.lint.conclusion }}"
`);

      const result = await executeWorkflow(workflowPath);

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[1].output).toContain(
        'outcome=failure conclusion=success'
      );
    });

    it('provides vars, runner and strategy contexts', async () => {
      const workflowPath = writeWorkflow(`
name: Contexts
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - run: echo "region=\${{ vars.REGION }} os=\${{ runner.os }} idx=\${{ strategy.job-index }}/\${{ strategy.job-total }}"
`);

      const result = await executeWorkflow(workflowPath, {
        vars: { REGION: 'eu-west-1' }
      });

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toMatch(
        /region=eu-west-1 os=(Linux|macOS|Windows) idx=0\/2/
      );
      expect(result.jobs[1].steps[0].output).toContain('idx=1/2');
    });
  });

  describe('event payload and github context', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-event-'));
    });

    function writeWorkflow(content: string): string {
      const file = path.join(tempDir, 'workflow.yml');
      fs.writeFileSync(file, content);
      return file;
    }

    it('loads --event-path into github.event and $GITHUB_EVENT_PATH', async () => {
      const eventPath = path.join(tempDir, 'event.json');
      const payload = {
        pull_request: { number: 42, head: { ref: 'feature' } },
        repository: { full_name: 'octo/repo', owner: { login: 'octo' } }
      };
      fs.writeFileSync(eventPath, JSON.stringify(payload));

      const workflowPath = writeWorkflow(`
name: Event
on: pull_request
jobs:
  a:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - run: |
          echo "pr=\${{ github.event.pull_request.number }} head=\${{ github.event.pull_request.head.ref }} repo=\${{ github.repository }} owner=\${{ github.repository_owner }}"
          echo "file=$(cat "$GITHUB_EVENT_PATH")"
`);

      const result = await executeWorkflow(workflowPath, {
        eventPath,
        eventName: 'pull_request'
      });

      expect(result.success).toBe(true);
      const output = result.jobs[0].steps[0].output ?? '';
      expect(output).toContain('pr=42 head=feature repo=octo/repo owner=octo');
      expect(output).toContain(`file=${JSON.stringify(payload)}`);
    });

    it('fails clearly when the event payload is not valid JSON', async () => {
      const eventPath = path.join(tempDir, 'event.json');
      fs.writeFileSync(eventPath, '{ not json');
      const workflowPath = writeWorkflow(`
name: Bad Event
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo never
`);

      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        const result = await executeWorkflow(workflowPath, { eventPath });
        expect(result.success).toBe(false);
        expect(result.jobs).toHaveLength(0);
        const logged = errorSpy.mock.calls.flat().join('\n');
        expect(logged).toMatch(/Invalid event payload .*event\.json/);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('defaults to a workflow_dispatch event carrying the inputs', async () => {
      const workflowPath = writeWorkflow(`
name: Dispatch
on:
  workflow_dispatch:
    inputs:
      env:
        default: staging
      debug:
        type: boolean
        default: false
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "event=\${{ github.event_name }} env=\${{ inputs.env }} debug=\${{ inputs.debug }} payload=\${{ github.event.inputs.env }}"
`);

      const defaults = await executeWorkflow(workflowPath);
      expect(defaults.jobs[0].steps[0].output).toContain(
        'event=workflow_dispatch env=staging debug=false payload=staging'
      );

      const overridden = await executeWorkflow(workflowPath, {
        inputs: { env: 'prod' }
      });
      expect(overridden.jobs[0].steps[0].output).toContain(
        'env=prod debug=false payload=prod'
      );
    });

    it('parses owner/repo from common git remote URL forms', () => {
      expect(parseRepositoryFromRemote('git@github.com:octo/repo.git')).toBe(
        'octo/repo'
      );
      expect(
        parseRepositoryFromRemote('https://github.com/octo/repo.git')
      ).toBe('octo/repo');
      expect(
        parseRepositoryFromRemote('https://user@ghe.example.com/octo/repo')
      ).toBe('octo/repo');
      expect(
        parseRepositoryFromRemote('ssh://git@github.com/octo/repo.git')
      ).toBe('octo/repo');
      expect(parseRepositoryFromRemote('/local/path/repo')).toBeUndefined();
    });
  });

  describe('actions/checkout of the current repository', () => {
    let workDir: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-checkout-'));
      fs.mkdirSync(path.join(workDir, '.git'));
      fs.writeFileSync(path.join(workDir, '.git', 'config'), 'original\n');
      fs.writeFileSync(path.join(workDir, 'local.txt'), 'uncommitted change');
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workDir);
      process.env.GITHUB_REPOSITORY = 'Octo/Proj';
      process.env.GITHUB_SHA = 'abc123';
      process.env.GITHUB_REF = 'refs/heads/main';
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      delete process.env.GITHUB_REPOSITORY;
      delete process.env.GITHUB_SHA;
      delete process.env.GITHUB_REF;
      fs.rmSync(workDir, { recursive: true, force: true });
    });

    function writeWorkflow(steps: string): string {
      const file = path.join(workDir, 'wf.yml');
      fs.writeFileSync(
        file,
        `name: Checkout\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`
      );
      return file;
    }

    it('uses the local working copy instead of cloning', async () => {
      const result = await executeWorkflow(
        writeWorkflow(
          [
            '      - id: co',
            '        uses: actions/checkout@v4',
            '      - run: cat local.txt',
            '      - run: echo "commit=${{ steps.co.outputs.commit }} ref=${{ steps.co.outputs.ref }}"'
          ].join('\n')
        )
      );

      expect(fetchActionMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      const steps = result.jobs[0].steps;
      expect(steps[0].output).toContain('Using local working copy');
      expect(steps[1].output).toContain('uncommitted change');
      expect(steps[2].output).toContain('commit=abc123 ref=refs/heads/main');
      expect(
        fs.readFileSync(path.join(workDir, '.git', 'config'), 'utf8')
      ).toBe('original\n');
    });

    it('treats repository: <this repo> (any case) as the local working copy', async () => {
      const result = await executeWorkflow(
        writeWorkflow(
          [
            '      - uses: actions/checkout@v4',
            '        with:',
            '          repository: octo/proj',
            '      - uses: actions/checkout@v3',
            '        with:',
            '          repository: ${{ github.repository }}'
          ].join('\n')
        )
      );

      expect(fetchActionMock).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('runs the real action for another repository', async () => {
      fetchActionMock.mockResolvedValueOnce(null);
      await executeWorkflow(
        writeWorkflow(
          [
            '      - uses: actions/checkout@v4',
            '        with:',
            '          repository: octo/other'
          ].join('\n')
        )
      );
      expect(fetchActionMock).toHaveBeenCalledWith('actions/checkout@v4');
    });

    it('runs the real action when localCheckout is false', async () => {
      fetchActionMock.mockResolvedValueOnce(null);
      await executeWorkflow(
        writeWorkflow('      - uses: actions/checkout@v4\n'),
        { localCheckout: false }
      );
      expect(fetchActionMock).toHaveBeenCalledWith('actions/checkout@v4');
    });

    it('copies the working copy into path:, and removes it at job end', async () => {
      const result = await executeWorkflow(
        writeWorkflow(
          [
            '      - uses: actions/checkout@v4',
            '        with:',
            '          path: src/app',
            '      - run: cat src/app/local.txt && test -f src/app/.git/config && test ! -e src/app/src/app',
            '      - uses: actions/checkout@v4',
            '        with:',
            '          path: other',
            '      - run: test ! -e other/src/app && echo "no nested copy"'
          ].join('\n')
        )
      );

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[1].output).toContain('uncommitted change');
      expect(result.jobs[0].steps[3].output).toContain('no nested copy');
      expect(fs.existsSync(path.join(workDir, 'src', 'app'))).toBe(false);
      expect(fs.existsSync(path.join(workDir, 'other'))).toBe(false);
    });

    it('replaces a copy left behind by an earlier run', async () => {
      const stale = path.join(workDir, 'app');
      fs.mkdirSync(stale);
      fs.writeFileSync(path.join(stale, '.secureci-checkout'), '');
      fs.writeFileSync(path.join(stale, 'stale.txt'), 'old');

      const result = await executeWorkflow(
        writeWorkflow(
          [
            '      - uses: actions/checkout@v4',
            '        with:',
            '          path: app',
            '      - run: test ! -e app/stale.txt && cat app/local.txt'
          ].join('\n')
        )
      );

      expect(result.success).toBe(true);
    });

    it('refuses to overwrite a non-empty path: it did not create', async () => {
      fs.mkdirSync(path.join(workDir, 'mine'));
      fs.writeFileSync(path.join(workDir, 'mine', 'keep.txt'), 'precious');

      const result = await executeWorkflow(
        writeWorkflow(
          [
            '      - uses: actions/checkout@v4',
            '        with:',
            '          path: mine'
          ].join('\n')
        )
      );

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].error).toContain('already exists');
      expect(
        fs.readFileSync(path.join(workDir, 'mine', 'keep.txt'), 'utf8')
      ).toBe('precious');
    });

    it('rejects a path: outside the workspace', async () => {
      const result = await executeWorkflow(
        writeWorkflow(
          [
            '      - uses: actions/checkout@v4',
            '        with:',
            '          path: ../escape'
          ].join('\n')
        )
      );

      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].error).toContain('outside the workspace');
    });

    it('exposes secrets.GITHUB_TOKEN as github.token', async () => {
      const result = await executeWorkflow(
        writeWorkflow(
          '      - run: test "${{ github.token }}" = "tok-1" && echo token matched\n'
        ),
        { secrets: { GITHUB_TOKEN: 'tok-1' } }
      );

      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('token matched');
    });
  });

  describe('running on the host (#15, #36)', () => {
    let tempDir: string;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-host-'));
      process.env.SECURECI_TEST_LEAK = 'leaked-value';
      warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      delete process.env.SECURECI_TEST_LEAK;
      warnSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function writeWorkflow(steps: string): string {
      const file = path.join(tempDir, 'wf.yml');
      fs.writeFileSync(
        file,
        `name: Host\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`
      );
      return file;
    }

    const warnings = () => warnSpy.mock.calls.flat().join('\n');

    it('does not pass the shell env to run: steps, but keeps PATH and HOME', async () => {
      const result = await executeWorkflow(
        writeWorkflow(
          '      - run: test -z "${SECURECI_TEST_LEAK:-}" && test -n "$HOME" && command -v node >/dev/null && echo clean\n'
        )
      );
      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[0].output).toContain('clean');
    });

    it('does not pass the shell env to JavaScript actions', async () => {
      const actionDir = path.join(tempDir, 'js');
      fs.mkdirSync(actionDir);
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        'name: js\ndescription: d\nruns:\n  using: node20\n  main: index.js\n'
      );
      fs.writeFileSync(
        path.join(actionDir, 'index.js'),
        'console.log("leak=" + (process.env.SECURECI_TEST_LEAK ?? "none"))'
      );
      fetchActionMock.mockResolvedValueOnce(path.join(actionDir, 'action.yml'));

      const result = await executeWorkflow(
        writeWorkflow('      - uses: some/js@v1\n')
      );
      expect(result.jobs[0].steps[0].output).toContain('leak=none');
    });

    it('passes --env values (and NAME from the shell) as the lowest-precedence env', async () => {
      const file = path.join(tempDir, 'wf.yml');
      fs.writeFileSync(
        file,
        [
          'name: Host',
          'on: push',
          'env:',
          '  OVERRIDDEN: from-workflow',
          'jobs:',
          '  a:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: echo "$SECURECI_TEST_LEAK $EXTRA $OVERRIDDEN ${{ env.EXTRA }}"'
        ].join('\n')
      );
      const result = await executeWorkflow(file, {
        env: {
          SECURECI_TEST_LEAK: 'leaked-value',
          EXTRA: 'x1',
          OVERRIDDEN: 'from-flag'
        }
      });
      expect(result.jobs[0].steps[0].output).toContain(
        'leaked-value x1 from-workflow x1'
      );
    });

    it('warns once per job when remote actions run without container isolation', async () => {
      fetchActionMock.mockResolvedValue(null);
      await executeWorkflow(
        writeWorkflow(
          [
            '      - uses: actions/checkout@v4',
            '      - uses: org/one@v1',
            '      - uses: org/two@v2',
            '      - uses: ./local',
            '      - uses: docker://alpine:3'
          ].join('\n') + '\n'
        ),
        { containerRuntime: 'none' }
      );
      const matching = warnSpy.mock.calls
        .flat()
        .filter((m) => String(m).includes('without container isolation'));
      expect(matching).toHaveLength(1);
      expect(matching[0]).toContain('org/one@v1, org/two@v2');
      expect(matching[0]).not.toContain('actions/checkout');
      expect(matching[0]).not.toContain('./local');
      expect(matching[0]).not.toContain('docker://');
      fetchActionMock.mockReset();
    });

    it('also warns when it falls back to the host because no runtime is available', async () => {
      fetchActionMock.mockResolvedValue(null);
      await executeWorkflow(writeWorkflow('      - uses: org/one@v1\n'), {
        containerRuntime: 'docker'
      });
      expect(warnings()).toContain('without container isolation');
      fetchActionMock.mockReset();
    });

    it('does not warn in a container, or without remote actions', async () => {
      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);
      fetchActionMock.mockResolvedValue(null);
      await executeWorkflow(writeWorkflow('      - uses: org/one@v1\n'), {
        containerRuntime: 'docker'
      });
      resolveContainerRuntimeMock.mockResolvedValue(null);
      await executeWorkflow(writeWorkflow('      - run: echo hi\n'), {
        containerRuntime: 'none'
      });
      expect(warnings()).not.toContain('without container isolation');
      fetchActionMock.mockReset();
    });
  });
});
