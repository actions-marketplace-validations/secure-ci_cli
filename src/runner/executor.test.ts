import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const resolveContainerRuntimeMock = vi.fn();
const fetchActionMock = vi.fn();
const fetchRepoFileMock = vi.fn();

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
    fetchAction: (...args: unknown[]) => fetchActionMock(...args),
    fetchRepoFile: (...args: unknown[]) => fetchRepoFileMock(...args)
  };
});

import {
  executeWorkflow,
  expandMatrix,
  parseRepositoryFromRemote
} from './executor';
import { createContext } from './expression';
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
    stopSync: vi.fn(),
    createNetwork: vi.fn().mockResolvedValue(true),
    removeNetwork: vi.fn().mockResolvedValue(undefined),
    removeNetworkSync: vi.fn(),
    health: vi.fn().mockResolvedValue('healthy'),
    ports: vi.fn().mockResolvedValue({ '5432': '49153' })
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
  // SecureCI): the github context prefers $GITHUB_* / $RUNNER_* from the host.
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
    fetchActionMock.mockImplementation(
      (uses: string, options?: Parameters<typeof actual.fetchAction>[1]) =>
        actual.fetchAction(uses, options)
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

    it('fails before running anything when the container runtime is unavailable', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-noruntime-'));
      const marker = path.join(dir, 'ran');
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        `name: No Runtime\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: touch ${marker}\n`
      );
      resolveContainerRuntimeMock.mockResolvedValue(null);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        for (const containerRuntime of ['auto', 'docker'] as const) {
          const result = await executeWorkflow(file, { containerRuntime });
          expect(result.success).toBe(false);
          expect(result.jobs).toEqual([]);
        }
        expect(fs.existsSync(marker)).toBe(false);
        const errors = errorSpy.mock.calls.flat().join('\n');
        expect(errors).toContain('No container runtime available');
        expect(errors).toContain('--container-runtime host');
      } finally {
        errorSpy.mockRestore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('runs on the host only when asked to with containerRuntime none', async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'secureci-host-optin-')
      );
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        'name: Host\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n'
      );
      try {
        const result = await executeWorkflow(file, {
          containerRuntime: 'host'
        });
        expect(result.success).toBe(true);
        expect(resolveContainerRuntimeMock).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
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

    it('runs Docker actions with the default engine in host mode', async () => {
      const dockerActionPath = path.join(
        fixturesDir,
        'docker-action',
        'action.yml'
      );
      fetchActionMock.mockResolvedValueOnce(dockerActionPath);
      const executeMock = vi.fn().mockResolvedValue({
        success: true,
        stdout: 'from docker\n',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        durationMs: 1
      });
      const fake = {
        ...fakeJobContainerRuntime(),
        build: vi
          .fn()
          .mockResolvedValue({ success: true, stdout: '', stderr: '' }),
        execute: executeMock
      };
      resolveContainerRuntimeMock.mockImplementation(async (preference) =>
        preference === 'auto' ? fake : null
      );
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'secureci-hostdocker-')
      );
      const workflowPath = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        workflowPath,
        'name: D\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: test-org/docker-action@v1\n        with:\n          message: hi\n'
      );
      try {
        const result = await executeWorkflow(workflowPath, {
          containerRuntime: 'host'
        });
        expect(result.success).toBe(true);
        expect(executeMock).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
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
      expect(result.jobs[0].steps[0].error).toContain(
        'docker, podman or containerd'
      );

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
      // pre runs at job start, as its own step (#36).
      expect(outputs[0]).toContain('phase=pre');
      expect(outputs[1]).toContain('phase=main');
      expect(outputs[1]).not.toContain('phase=pre');
      expect(outputs[2]).toContain('phase=later-step');
      expect(outputs[3]).toContain('phase=post state=from-main');
      expect(result.jobs[0].steps).toHaveLength(4);
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

    it('treats a container: expression that evaluates to empty as no container', async () => {
      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);
      const workflowPath = writeWorkflow(`
name: Optional Container
on:
  workflow_dispatch:
    inputs:
      image: { type: string, default: '' }
jobs:
  a:
    runs-on: ubuntu-22.04
    container: \${{ inputs.image || null }}
    steps:
      - run: echo a
`);

      await executeWorkflow(workflowPath, { containerRuntime: 'docker' });
      await executeWorkflow(workflowPath, {
        containerRuntime: 'docker',
        inputs: { image: 'node:20' }
      });

      expect(fake.start.mock.calls.map((c) => c[0].image)).toEqual([
        'catthehacker/ubuntu:act-22.04',
        'node:20'
      ]);
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
        containerRuntime: 'host'
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
      - run: |
          rc=0; { false | true; } || rc=$?
          echo "dir=$(basename "$PWD") pipefail=$rc"
  job:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: .secureci-test-wd/job
        shell: sh
    steps:
      - run: |
          rc=0; { false | true; } || rc=$?
          echo "dir=$(basename "$PWD") pipefail=$rc"
      - run: echo "dir=$(basename "$PWD")"
        working-directory: .secureci-test-wd
`);

      try {
        const result = await executeWorkflow(workflowPath);

        // The default shell is bash with `-eo pipefail`, so `false | true`
        // returns 1 (pipefail=1). The job overrides the shell to `sh -e`
        // (no pipefail), so the same pipeline returns 0 (pipefail=0). This
        // distinguishes the shells regardless of whether /bin/sh is dash or
        // bash on the host (checking $BASH_VERSION would not: bash in POSIX
        // sh mode still sets it).
        expect(result.success).toBe(true);
        expect(result.jobs[0].steps[0].output).toContain('dir=wf pipefail=1');
        expect(result.jobs[1].steps[0].output).toContain('dir=job pipefail=0');
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
      expect(fetchActionMock).toHaveBeenCalledWith(
        'actions/checkout@v4',
        expect.anything()
      );
    });

    it('runs the real action when localCheckout is false', async () => {
      fetchActionMock.mockResolvedValueOnce(null);
      await executeWorkflow(
        writeWorkflow('      - uses: actions/checkout@v4\n'),
        { localCheckout: false }
      );
      expect(fetchActionMock).toHaveBeenCalledWith(
        'actions/checkout@v4',
        expect.anything()
      );
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
        { containerRuntime: 'host' }
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

    it('does not warn in a container, or without remote actions', async () => {
      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);
      fetchActionMock.mockResolvedValue(null);
      await executeWorkflow(writeWorkflow('      - uses: org/one@v1\n'), {
        containerRuntime: 'docker'
      });
      resolveContainerRuntimeMock.mockResolvedValue(null);
      await executeWorkflow(writeWorkflow('      - run: echo hi\n'), {
        containerRuntime: 'host'
      });
      expect(warnings()).not.toContain('without container isolation');
      fetchActionMock.mockReset();
    });
  });

  describe('reusable workflow calls (#11)', () => {
    let root: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-reuse-'));
      fs.mkdirSync(path.join(root, '.github', 'workflows'), {
        recursive: true
      });
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root);
      fetchRepoFileMock.mockReset();
    });
    afterEach(() => {
      cwdSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    });

    function write(rel: string, content: string): string {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return file;
    }

    const reusable = `
name: Reusable
on:
  workflow_call:
    inputs:
      who:
        type: string
        required: true
      greeting:
        type: string
        default: hello
    secrets:
      token:
        required: true
    outputs:
      message:
        value: \${{ jobs.second.outputs.msg }}
      first-result:
        value: \${{ jobs.first.result }}
jobs:
  second:
    needs: first
    runs-on: ubuntu-latest
    outputs:
      msg: \${{ steps.m.outputs.msg }}
    steps:
      - id: m
        run: echo "msg=\${{ needs.first.outputs.part }} \${{ inputs.who }}" >> "$GITHUB_OUTPUT"
  first:
    runs-on: ubuntu-latest
    outputs:
      part: \${{ steps.p.outputs.part }}
    steps:
      - id: p
        run: |
          test "\${{ secrets.token }}" = "s3cret" && echo "token ok"
          test -z "\${{ secrets.OTHER }}" && echo "no other secret"
          echo "part=\${{ inputs.greeting }}" >> "$GITHUB_OUTPUT"
`;

    it('runs a local reusable workflow from the repository root, with inputs, secrets and outputs', async () => {
      write('.github/workflows/reuse.yml', reusable);
      const caller = write(
        '.github/workflows/caller.yml',
        `
name: Caller
on: push
jobs:
  prep:
    runs-on: ubuntu-latest
    outputs:
      name: \${{ steps.n.outputs.name }}
    steps:
      - id: n
        run: echo "name=octo" >> "$GITHUB_OUTPUT"
  call:
    needs: prep
    uses: ./.github/workflows/reuse.yml
    with:
      who: \${{ needs.prep.outputs.name }}-\${{ inputs.suffix }}
    secrets:
      token: \${{ secrets.TOP }}
  after:
    needs: call
    runs-on: ubuntu-latest
    steps:
      - run: echo "got [\${{ needs.call.outputs.message }}] [\${{ needs.call.outputs.first-result }}]"
`
      );

      const result = await executeWorkflow(caller, {
        inputs: { suffix: 'x' },
        secrets: { TOP: 's3cret', OTHER: 'nope' }
      });

      expect(result.success).toBe(true);
      const callJob = result.jobs.find((j) => j.job === 'call');
      const outputs = callJob?.steps.map((s) => s.output).join('\n');
      expect(outputs).toContain('token ok');
      expect(outputs).toContain('no other secret');
      expect(callJob?.outputs).toEqual({
        message: 'hello octo-x',
        'first-result': 'success'
      });
      expect(
        result.jobs.find((j) => j.job === 'after')?.steps[0].output
      ).toContain('got [hello octo-x] [success]');
    });

    it('runs a reusable workflow once per matrix combination', async () => {
      write('.github/workflows/reuse.yml', reusable);
      const caller = write(
        '.github/workflows/caller.yml',
        `
name: Caller
on: push
jobs:
  call:
    strategy:
      matrix:
        who: [ann, bob]
    uses: ./.github/workflows/reuse.yml
    with:
      who: \${{ matrix.who }}
    secrets:
      token: s3cret
`
      );
      const result = await executeWorkflow(caller);
      expect(result.success).toBe(true);
      expect(result.jobs.map((j) => [j.job, j.outputs?.message])).toEqual([
        ['call (who: ann)', 'hello ann'],
        ['call (who: bob)', 'hello bob']
      ]);
    });

    it('passes all secrets with secrets: inherit', async () => {
      write(
        '.github/workflows/reuse.yml',
        reusable.replace('test -z', 'test -n')
      );
      const caller = write(
        '.github/workflows/caller.yml',
        `
name: Caller
on: push
jobs:
  call:
    uses: ./.github/workflows/reuse.yml
    with:
      who: me
    secrets: inherit
`
      );
      const result = await executeWorkflow(caller, {
        secrets: { token: 's3cret', OTHER: 'yes' }
      });
      expect(result.success).toBe(true);
    });

    it('fetches a remote reusable workflow', async () => {
      const remote = write('remote-cache/reuse.yml', reusable);
      fetchRepoFileMock.mockResolvedValueOnce(remote);
      const caller = write(
        '.github/workflows/caller.yml',
        `
name: Caller
on: push
jobs:
  call:
    uses: org/shared/.github/workflows/reuse.yml@v1
    with:
      who: remote
    secrets:
      token: s3cret
`
      );

      const result = await executeWorkflow(caller, { offline: true });

      expect(fetchRepoFileMock).toHaveBeenCalledWith(
        'org/shared/.github/workflows/reuse.yml@v1',
        { offline: true }
      );
      expect(result.success).toBe(true);
      expect(result.jobs[0].outputs).toMatchObject({ message: 'hello remote' });
    });

    it('fails the calling job when the workflow cannot be fetched, and skips its dependents', async () => {
      fetchRepoFileMock.mockResolvedValueOnce(null);
      const caller = write(
        '.github/workflows/caller.yml',
        `
name: Caller
on: push
jobs:
  call:
    uses: org/shared/.github/workflows/missing.yml@v1
  after:
    needs: call
    runs-on: ubuntu-latest
    steps:
      - run: echo never
`
      );

      const result = await executeWorkflow(caller);
      expect(result.success).toBe(false);
      expect(result.jobs.map((j) => j.job)).toEqual(['call']);
    });
  });

  describe('matrix expansion (#14)', () => {
    const ctx = createContext();

    it('expands the cartesian product of the axes', () => {
      expect(expandMatrix({ a: [1, 2], b: ['x'] }, ctx)).toEqual([
        { a: 1, b: 'x' },
        { a: 2, b: 'x' }
      ]);
      expect(expandMatrix(undefined, ctx)).toEqual([{}]);
    });

    it('removes combinations matching an exclude entry (partial match)', () => {
      expect(
        expandMatrix(
          {
            os: ['linux', 'mac'],
            node: [18, 20],
            exclude: [{ os: 'mac', node: 18 }, { node: 99 }]
          },
          ctx
        )
      ).toEqual([
        { os: 'linux', node: 18 },
        { os: 'linux', node: 20 },
        { os: 'mac', node: 20 }
      ]);
    });

    it("applies include like GitHub's documented example", () => {
      expect(
        expandMatrix(
          {
            fruit: ['apple', 'pear'],
            animal: ['cat', 'dog'],
            include: [
              { color: 'green' },
              { color: 'pink', animal: 'cat' },
              { fruit: 'apple', shape: 'circle' },
              { fruit: 'banana' },
              { fruit: 'banana', animal: 'cat' }
            ]
          },
          ctx
        )
      ).toEqual([
        { fruit: 'apple', animal: 'cat', color: 'pink', shape: 'circle' },
        { fruit: 'apple', animal: 'dog', color: 'green', shape: 'circle' },
        { fruit: 'pear', animal: 'cat', color: 'pink' },
        { fruit: 'pear', animal: 'dog', color: 'green' },
        { fruit: 'banana' },
        { fruit: 'banana', animal: 'cat' }
      ]);
    });

    it('uses include entries as the combinations when there are no axes', () => {
      expect(
        expandMatrix({ include: [{ os: 'a' }, { os: 'b', x: 1 }] }, ctx)
      ).toEqual([{ os: 'a' }, { os: 'b', x: 1 }]);
    });

    it('evaluates expressions for the whole matrix and for axis values', () => {
      expect(
        expandMatrix(
          '${{ fromJSON(\'{"os":["a","b"],"include":[{"os":"c"}]}\') }}',
          ctx
        )
      ).toEqual([{ os: 'a' }, { os: 'b' }, { os: 'c' }]);
      expect(
        expandMatrix({ os: '${{ fromJSON(\'["x","y"]\') }}' }, ctx)
      ).toEqual([{ os: 'x' }, { os: 'y' }]);
    });

    it('honours job-level continue-on-error per combination', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-matrix-'));
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        `
name: Matrix
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    continue-on-error: \${{ matrix.experimental }}
    strategy:
      matrix:
        node: [18, 20]
        experimental: [false]
        include:
          - node: 22
            experimental: true
    steps:
      - run: '[ "\${{ matrix.node }}" != "22" ]'
  after:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo "after ran"
`
      );
      try {
        const result = await executeWorkflow(file);
        expect(result.jobs.map((j) => [j.job, j.success])).toEqual([
          ['test (node: 18, experimental: false)', true],
          ['test (node: 20, experimental: false)', true],
          ['test (node: 22, experimental: true)', false],
          ['after', true]
        ]);
        expect(result.success).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('--matrix filter (#50)', () => {
    let dir: string;
    let file: string;
    let warnings: string[];
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-matrix-filter-'));
      file = path.join(dir, 'wf.yml');
      warnings = [];
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warnings.push(args.join(' '));
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});
      fs.writeFileSync(
        file,
        `
name: Matrix
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
        os: [linux, mac]
    steps:
      - run: echo "node=\${{ matrix.node }} os=\${{ matrix.os }} index=\${{ strategy.job-index }}/\${{ strategy.job-total }}"
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  after:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo after
  call:
    strategy:
      matrix:
        node: [18, 20]
    uses: ./called.yml
    with:
      who: \${{ matrix.node }}
`
      );
      fs.writeFileSync(
        path.join(dir, 'called.yml'),
        `
name: Called
on:
  workflow_call:
    inputs:
      who:
        type: string
jobs:
  inner:
    runs-on: ubuntu-latest
    steps:
      - run: echo "called \${{ inputs.who }}"
`
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('runs only the matching combinations, keeping their names and strategy values', async () => {
      const result = await executeWorkflow(file, {
        matrix: { node: ['20'], os: ['mac'] }
      });
      expect(result.success).toBe(true);
      expect(result.jobs.map((j) => j.job)).toEqual([
        'test (node: 20, os: mac)',
        'lint',
        'call (node: 20)',
        'after'
      ]);
      expect(result.jobs[0].steps[0].output).toContain(
        'node=20 os=mac index=3/4'
      );
      expect(result.jobs[2].steps[0].output).toContain('called 20');
      expect(warnings).toEqual([]);
    });

    it('applies with --job', async () => {
      const result = await executeWorkflow(file, {
        job: 'test',
        matrix: { node: ['18'] }
      });
      expect(result.jobs.map((j) => j.job)).toEqual([
        'test (node: 18, os: linux)',
        'test (node: 18, os: mac)'
      ]);
    });

    it('skips a job with no matching combination, warns, and fails the run', async () => {
      const result = await executeWorkflow(file, {
        matrix: { node: ['16'] }
      });
      expect(result.success).toBe(false);
      expect(result.jobs.map((j) => [j.job, j.success])).toEqual([
        ['lint', true]
      ]);
      const text = warnings.join('\n');
      expect(text).toContain(
        'No matrix combination of job "test" matches --matrix node:16; skipping it. Available combinations:'
      );
      expect(text).toContain('  node: 20, os: mac');
      expect(text).toContain(
        'No matrix combination of job "call" matches --matrix node:16'
      );
    });

    it('warns about a key no matrix job defines, and runs everything', async () => {
      const result = await executeWorkflow(file, {
        job: 'test',
        matrix: { nod: ['20'] }
      });
      expect(result.success).toBe(true);
      expect(result.jobs).toHaveLength(4);
      expect(warnings.join('\n')).toContain(
        '--matrix nod: no matrix job defines this key; it was ignored'
      );
    });
  });

  describe('runner fidelity (#36)', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-fidelity-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeWorkflow(steps: string): string {
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        `name: F\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`
      );
      return file;
    }

    it("runs remote JavaScript actions' pre scripts at job start (#36)", async () => {
      const actionDir = path.join(dir, 'js');
      fs.mkdirSync(actionDir);
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        [
          'name: js',
          'description: d',
          'inputs:',
          '  who:',
          '    default: nobody',
          'runs:',
          '  using: node20',
          '  pre: pre.js',
          '  main: main.js'
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(actionDir, 'pre.js'),
        `require('fs').appendFileSync(process.env.GITHUB_STATE, 'from_pre=' + process.env.INPUT_WHO + '\\n'); console.log('pre ran');`
      );
      fs.writeFileSync(
        path.join(actionDir, 'main.js'),
        'console.log("main sees " + process.env.STATE_from_pre)'
      );
      fetchActionMock.mockResolvedValue(path.join(actionDir, 'action.yml'));

      const result = await executeWorkflow(
        writeWorkflow(
          [
            '      - run: echo first step',
            '      - uses: org/js@v1',
            '        with:',
            '          who: octo'
          ].join('\n') + '\n'
        )
      );
      const fetches = fetchActionMock.mock.calls.length;
      fetchActionMock.mockReset();

      expect(fetches).toBe(1);
      expect(result.success).toBe(true);
      const steps = result.jobs[0].steps;
      expect(
        steps.map((s) => s.step.name ?? s.step.run ?? s.step.uses)
      ).toEqual(['Pre org/js@v1', 'echo first step', 'org/js@v1']);
      expect(steps[0].output).toContain('pre ran');
      expect(steps[2].output).toContain('main sees octo');
    });

    it('collects $GITHUB_STEP_SUMMARY into the job result and prints it', async () => {
      const logSpy = vi.spyOn(console, 'log');
      try {
        const result = await executeWorkflow(
          writeWorkflow(
            [
              '      - run: echo "## Tests" >> "$GITHUB_STEP_SUMMARY"',
              '      - run: echo "- 3 passed" >> "$GITHUB_STEP_SUMMARY"'
            ].join('\n') + '\n'
          )
        );
        expect(result.jobs[0].summary).toBe('## Tests\n- 3 passed\n');
        expect(logSpy.mock.calls.flat().join('\n')).toContain('- 3 passed');
      } finally {
        logSpy.mockRestore();
      }
    });

    it('does not expose secrets.* inside composite actions', async () => {
      const actionDir = path.join(dir, 'comp');
      fs.mkdirSync(actionDir);
      fs.writeFileSync(
        path.join(actionDir, 'action.yml'),
        [
          'name: comp',
          'description: d',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - shell: bash',
          '      run: echo "token=${{ secrets.TOKEN }}"'
        ].join('\n')
      );
      fetchActionMock.mockResolvedValueOnce(path.join(actionDir, 'action.yml'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const result = await executeWorkflow(
          writeWorkflow('      - uses: org/comp@v1\n'),
          { secrets: { TOKEN: 'abc' } }
        );
        expect(result.success).toBe(false);
        expect(result.jobs[0].steps[0].output ?? '').not.toContain('abc');
        expect(warnSpy.mock.calls.flat().join('\n')).toContain(
          "Unrecognized named-value: 'secrets'"
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('kills the step processes in the job container when a step times out', async () => {
      const fake = fakeJobContainerRuntime((_id, opts) =>
        /script\.sh/.test(opts.command ?? '')
          ? { success: false, timedOut: true, exitCode: null }
          : {}
      ) as ReturnType<typeof fakeJobContainerRuntime>;
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const result = await executeWorkflow(
        writeWorkflow('      - run: sleep 100\n'),
        {
          containerRuntime: 'docker',
          containerTimeoutMs: 50
        }
      );

      expect(result.success).toBe(false);
      const calls = fake.exec.mock.calls.map((c) => c[1] as ExecCall);
      const stepCall = calls.find((c) => /script\.sh/.test(c.command ?? ''));
      const marker = stepCall?.env?.SECURECI_STEP;
      expect(marker).toBeTruthy();
      const kill = calls.find(
        (c) => c.command?.includes('kill') && c.command.includes(String(marker))
      );
      expect(kill).toBeDefined();
    });
  });

  describe('service containers (#33)', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-services-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const workflow = `
name: Services
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: postgres:\${{ inputs.pg }}
        env:
          POSTGRES_PASSWORD: pw
        ports:
          - 5432
        options: --health-cmd "pg_isready -U postgres" --health-interval 1s
    steps:
      - run: echo "port=$PORT"
        env:
          PORT: \${{ job.services.db.ports['5432'] }}
`;

    function write(): string {
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(file, workflow);
      return file;
    }

    /** start() calls: services first, then the job container. */
    function startCall(
      fake: ReturnType<typeof fakeJobContainerRuntime>,
      predicate: (o: Record<string, unknown>) => boolean
    ) {
      return fake.start.mock.calls
        .map((c) => c[0] as Record<string, unknown>)
        .find(predicate);
    }

    it('runs services on a job network, waits for health, and tears everything down', async () => {
      const fake = fakeJobContainerRuntime();
      fake.start.mockImplementation(async (o: { service?: boolean }) => ({
        success: true,
        id: o.service ? 'svc-1' : 'job-1'
      }));
      fake.health
        .mockResolvedValueOnce('starting')
        .mockResolvedValueOnce('healthy');
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const result = await executeWorkflow(write(), {
        containerRuntime: 'docker',
        inputs: { pg: '16' }
      });

      expect(result.success).toBe(true);
      const network = fake.createNetwork.mock.calls[0][0] as string;
      expect(network).toMatch(/^secureci-/);
      expect(startCall(fake, (o) => !!o.service)).toMatchObject({
        image: 'postgres:16',
        service: true,
        network,
        networkAlias: 'db',
        ports: ['5432'],
        env: { POSTGRES_PASSWORD: 'pw' },
        extraArgs: [
          '--health-cmd',
          'pg_isready -U postgres',
          '--health-interval',
          '1s'
        ]
      });
      expect(startCall(fake, (o) => !o.service)).toMatchObject({ network });
      expect(fake.health).toHaveBeenCalledTimes(2);
      expect(stepExecCalls(fake)[0].env?.PORT).toBe('49153');
      expect(fake.stop.mock.calls.map((c) => c[0]).sort()).toEqual([
        'job-1',
        'svc-1'
      ]);
      expect(fake.removeNetwork).toHaveBeenCalledWith(network);
    });

    it('fails the job, without running steps, when a service is unhealthy', async () => {
      const fake = fakeJobContainerRuntime();
      fake.health.mockResolvedValue('unhealthy');
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const result = await executeWorkflow(write(), {
        containerRuntime: 'docker',
        inputs: { pg: '16' }
      });

      expect(result.success).toBe(false);
      expect(stepExecCalls(fake)).toHaveLength(0);
      expect(fake.stop).toHaveBeenCalled();
      expect(fake.removeNetwork).toHaveBeenCalled();
    });

    it('on the host, publishes service ports instead of using a network', async () => {
      const fake = fakeJobContainerRuntime();
      fake.start.mockResolvedValue({ success: true, id: 'svc-1' });
      resolveContainerRuntimeMock.mockResolvedValue(fake);

      const result = await executeWorkflow(write(), {
        containerRuntime: 'host',
        inputs: { pg: '16' }
      });

      expect(result.success).toBe(true);
      expect(fake.createNetwork).not.toHaveBeenCalled();
      expect(fake.start).toHaveBeenCalledTimes(1);
      expect(fake.start.mock.calls[0][0]).toMatchObject({
        service: true,
        ports: ['5432']
      });
      expect(fake.start.mock.calls[0][0]).not.toHaveProperty('network');
      expect(result.jobs[0].steps[0].output).toContain('port=49153');
      expect(fake.stop).toHaveBeenCalledWith('svc-1');
    });

    // Real-engine check: opt in with RUN_DOCKER_TESTS=1 (needs a running
    // docker daemon and the postgres:16-alpine image or network access).
    it.skipIf(!process.env.RUN_DOCKER_TESTS)(
      'reaches a real postgres service by hostname from the job container',
      async () => {
        const actual = await vi.importActual<
          typeof import('./container-runtime')
        >('./container-runtime');
        resolveContainerRuntimeMock.mockImplementation(
          actual.resolveContainerRuntime
        );
        const file = path.join(dir, 'real.yml');
        fs.writeFileSync(
          file,
          `
name: Real Services
on: push
jobs:
  db:
    runs-on: ubuntu-latest
    container: postgres:16-alpine
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_PASSWORD: pw
        options: --health-cmd "pg_isready -U postgres" --health-interval 1s --health-retries 60
    steps:
      - run: pg_isready -h postgres -U postgres
`
        );

        const result = await executeWorkflow(file, {
          containerRuntime: 'docker'
        });
        expect(result.success).toBe(true);
        expect(result.jobs[0].steps[0].output).toContain(
          'accepting connections'
        );
      },
      180_000
    );

    it('fails clearly when no container runtime is available for services', async () => {
      resolveContainerRuntimeMock.mockResolvedValue(null);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await executeWorkflow(write(), {
          containerRuntime: 'host',
          inputs: { pg: '16' }
        });
        expect(result.success).toBe(false);
        expect(errorSpy.mock.calls.flat().join('\n')).toContain(
          'services need a container runtime'
        );
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it('keeps github.run_id the same across jobs and called workflows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-runid-'));
    fs.writeFileSync(
      path.join(dir, 'called.yml'),
      'name: C\non: workflow_call\njobs:\n  c:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "id=${{ github.run_id }}"\n'
    );
    const file = path.join(dir, 'wf.yml');
    fs.writeFileSync(
      file,
      [
        'name: R',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: sleep 0.05; echo "id=${{ github.run_id }}"',
        '  b:',
        '    needs: a',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo "id=$GITHUB_RUN_ID"',
        '  c:',
        '    needs: b',
        '    uses: ./called.yml'
      ].join('\n')
    );
    try {
      const result = await executeWorkflow(file);
      const ids = result.jobs.map(
        (j) => j.steps[0].output?.match(/id=(\d+)/)?.[1]
      );
      expect(ids[0]).toBeTruthy();
      expect(new Set(ids).size).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('artifacts and actions/cache (#13)', () => {
    let work: string;
    let home: string;
    let cwdSpy: ReturnType<typeof vi.spyOn>;
    let savedHome: string | undefined;

    beforeEach(() => {
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-art-work-'));
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-art-home-'));
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(work);
      savedHome = process.env.HOME;
      process.env.HOME = home;
      process.env.GITHUB_REPOSITORY = 'octo/proj';
    });
    afterEach(() => {
      cwdSpy.mockRestore();
      process.env.HOME = savedHome;
      delete process.env.GITHUB_REPOSITORY;
      fs.rmSync(work, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    });

    function wf(jobs: string): string {
      const file = path.join(work, 'wf.yml');
      fs.writeFileSync(file, `name: A\non: push\njobs:\n${jobs}`);
      return file;
    }

    const outputOf = (r: Awaited<ReturnType<typeof executeWorkflow>>) =>
      r.jobs.flatMap((j) => j.steps.map((s) => s.output ?? '')).join('\n');

    it('uploads in one job and downloads in another, keeping structure', async () => {
      const result = await executeWorkflow(
        wf(`
  build:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p dist/sub dist/.hidden && echo a > dist/a.txt && echo b > dist/sub/b.txt && echo h > dist/.hidden/h.txt && echo x > dist/skip.log
      - id: up
        uses: actions/upload-artifact@v4
        with:
          name: bundle
          path: |
            dist/**/*.txt
            !dist/skip.log
  use:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - id: down
        uses: actions/download-artifact@v4
        with:
          name: bundle
          path: out
      - run: cat out/a.txt out/sub/b.txt && test ! -e out/.hidden && echo "path=\${{ steps.down.outputs.download-path }}"
`)
      );
      expect(result.success).toBe(true);
      expect(result.jobs[0].steps[1].outputs?.['artifact-id']).toMatch(/^\d+$/);
      expect(outputOf(result)).toContain(`path=${path.join(work, 'out')}`);
    });

    it('downloads every artifact into <path>/<name>, or merged', async () => {
      const result = await executeWorkflow(
        wf(`
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo one > one.txt && echo two > two.txt
      - uses: actions/upload-artifact@v4
        with: { name: first, path: one.txt }
      - uses: actions/upload-artifact@v4
        with: { name: second, path: two.txt }
      - uses: actions/download-artifact@v4
        with: { path: all }
      - uses: actions/download-artifact@v4
        with: { path: merged, pattern: '*', merge-multiple: true }
      - run: cat all/first/one.txt all/second/two.txt merged/one.txt merged/two.txt
`)
      );
      expect(result.success).toBe(true);
    });

    it('applies if-no-files-found and refuses to overwrite by default', async () => {
      const missing = await executeWorkflow(
        wf(`
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with: { name: x, path: nothing/, if-no-files-found: error }
`)
      );
      expect(missing.success).toBe(false);

      const twice = await executeWorkflow(
        wf(`
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo 1 > f.txt
      - uses: actions/upload-artifact@v4
        with: { name: x, path: f.txt }
      - uses: actions/upload-artifact@v4
        with: { name: x, path: f.txt }
      - uses: actions/upload-artifact@v4
        with: { name: x, path: f.txt, overwrite: true }
`)
      );
      expect(twice.jobs[0].steps.map((s) => s.success)).toEqual([
        true,
        true,
        false,
        true
      ]);
    });

    const cacheJob = (key: string, extra = '') => `
  a:
    runs-on: ubuntu-latest
    steps:
      - id: cache
        uses: actions/cache@v4
        with:
          key: ${key}
          path: |
            deps
            ~/.tool-cache
          restore-keys: |
            deps-
${extra}
      - run: echo "hit=[\${{ steps.cache.outputs.cache-hit }}] matched=[\${{ steps.cache.outputs.cache-matched-key }}]"
      - run: mkdir -p deps ~/.tool-cache && echo "\${{ github.run_id }}" > deps/stamp && echo t > ~/.tool-cache/t
`;

    it('saves at job end and restores by exact key, then by restore-keys', async () => {
      const first = await executeWorkflow(wf(cacheJob('deps-1')));
      expect(first.success).toBe(true);
      expect(outputOf(first)).toContain('hit=[] matched=[]');

      fs.rmSync(path.join(work, 'deps'), { recursive: true });
      fs.rmSync(path.join(home, '.tool-cache'), { recursive: true });
      const exact = await executeWorkflow(
        wf(cacheJob('deps-1').replace(/ +- run: mkdir[^\n]*\n/, ''))
      );
      expect(outputOf(exact)).toContain('hit=[true] matched=[deps-1]');
      expect(fs.existsSync(path.join(work, 'deps', 'stamp'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.tool-cache', 't'))).toBe(true);

      const partial = await executeWorkflow(wf(cacheJob('deps-2')));
      expect(outputOf(partial)).toContain('hit=[false] matched=[deps-1]');

      const again = await executeWorkflow(wf(cacheJob('deps-2')));
      expect(outputOf(again)).toContain('hit=[true] matched=[deps-2]');
    });

    it('supports lookup-only, fail-on-cache-miss, and cache/restore + cache/save', async () => {
      const miss = await executeWorkflow(
        wf(cacheJob('other-1', '          fail-on-cache-miss: true'))
      );
      expect(miss.success).toBe(false);

      const saved = await executeWorkflow(
        wf(`
  a:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir -p deps && echo s > deps/s
      - uses: actions/cache/save@v4
        with: { key: split-1, path: deps }
`)
      );
      expect(saved.success).toBe(true);
      fs.rmSync(path.join(work, 'deps'), { recursive: true });

      const lookup = await executeWorkflow(
        wf(`
  a:
    runs-on: ubuntu-latest
    steps:
      - id: c
        uses: actions/cache/restore@v4
        with: { key: split-1, path: deps, lookup-only: true }
      - run: echo "hit=\${{ steps.c.outputs.cache-hit }}" && test ! -e deps/s
      - id: r
        uses: actions/cache/restore@v4
        with: { key: split-1, path: deps }
      - run: cat deps/s
`)
      );
      expect(lookup.success).toBe(true);
      expect(outputOf(lookup)).toContain('hit=true');
    });
  });

  describe('invalid if: expressions', () => {
    let dir: string;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-badif-'));
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      errorSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const errors = () => errorSpy.mock.calls.flat().join('\n');

    function write(jobs: string): string {
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(file, `name: Bad If\non: push\njobs:\n${jobs}`);
      return file;
    }

    it('rejects the workflow before running anything, like GitHub', async () => {
      const marker = path.join(dir, 'ran');
      const result = await executeWorkflow(
        write(`
  a:
    runs-on: ubuntu-latest
    steps:
      - run: touch ${marker}
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
        if: unknownContext.x == 'y'
`)
      );
      expect(result.success).toBe(false);
      expect(result.jobs).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);
      expect(errors()).toContain('Invalid workflow file');
      expect(errors()).toContain(
        "jobs.b.steps[0].if: Unrecognized named-value: 'unknownContext'"
      );
    });

    it('fails the step when its if: errors at runtime, and skips the rest', async () => {
      const result = await executeWorkflow(
        write(`
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo first
      - name: guarded deploy
        if: fromJSON('not json')
        run: echo deployed
      - run: echo after
`)
      );
      expect(result.success).toBe(false);
      const steps = result.jobs[0].steps;
      expect(steps.map((s) => [s.success, s.outcome ?? ''])).toEqual([
        [true, ''],
        [false, ''],
        [true, 'skipped']
      ]);
      expect(steps[1].output ?? '').not.toContain('deployed');
      expect(steps[1].error).toContain("Error when evaluating 'if'");
    });

    function action(
      name: string,
      yml: string,
      files: Record<string, string> = {}
    ) {
      const actionDir = path.join(dir, name);
      fs.mkdirSync(actionDir);
      fs.writeFileSync(path.join(actionDir, 'action.yml'), yml);
      for (const [file, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(actionDir, file), content);
      }
      return path.join(actionDir, 'action.yml');
    }

    it('fails a composite action step whose if: is invalid or errors', async () => {
      for (const [i, condition] of [
        "secrets.X == 'y'",
        "fromJSON('nope')"
      ].entries()) {
        fetchActionMock.mockResolvedValueOnce(
          action(
            `comp-${i}`,
            `name: c\ndescription: d\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      if: ${JSON.stringify(condition)}\n      run: echo inner\n`
          )
        );
        const result = await executeWorkflow(
          write(`
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: org/comp@v1
`)
        );
        expect(result.success).toBe(false);
        expect(result.jobs[0].steps[0].output ?? '').not.toContain('inner');
      }
      expect(errors()).toContain(
        "runs.steps[0].if: Unrecognized named-value: 'secrets'"
      );
      expect(errors()).toContain("Error when evaluating 'if'");
    });

    it('fails the pre step when pre-if errors (main is then skipped), without aborting the run', async () => {
      fetchActionMock.mockResolvedValue(
        action(
          'js-pre',
          "name: js\ndescription: d\nruns:\n  using: node20\n  pre: p.js\n  pre-if: fromJSON('x')\n  main: m.js\n",
          {
            'p.js': 'console.log("hook ran")',
            'm.js': 'console.log("main ran")'
          }
        )
      );
      try {
        const result = await executeWorkflow(
          write(`
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: org/js@v1
`)
        );
        expect(result.success).toBe(false);
        const steps = result.jobs[0].steps;
        expect(steps[0]).toMatchObject({
          step: { name: 'Pre org/js@v1' },
          success: false
        });
        expect(steps[0].error).toContain("Error when evaluating 'if'");
        expect(steps[1].outcome).toBe('skipped');
      } finally {
        fetchActionMock.mockReset();
      }
    });

    it('fails the post step when post-if errors', async () => {
      fetchActionMock.mockResolvedValue(
        action(
          'js-post',
          "name: js\ndescription: d\nruns:\n  using: node20\n  main: m.js\n  post: p.js\n  post-if: fromJSON('y')\n",
          {
            'p.js': 'console.log("hook ran")',
            'm.js': 'console.log("main ran")'
          }
        )
      );
      try {
        const result = await executeWorkflow(
          write(`
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: org/js@v1
`)
        );
        expect(result.success).toBe(false);
        const steps = result.jobs[0].steps;
        expect(steps[0].output).toContain('main ran');
        expect(steps[1]).toMatchObject({
          step: { name: 'Post org/js@v1' },
          success: false
        });
        expect(steps[1].output ?? '').not.toContain('hook ran');
      } finally {
        fetchActionMock.mockReset();
      }
    });

    it('fails the job when its if: errors at runtime, and skips dependents', async () => {
      const result = await executeWorkflow(
        write(`
  a:
    runs-on: ubuntu-latest
    if: fromJSON('{')
    steps:
      - run: echo never
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - run: echo never either
`)
      );
      expect(result.success).toBe(false);
      expect(
        result.jobs.map((j) => [j.job, j.success, j.steps.length])
      ).toEqual([['a', false, 0]]);
      expect(errors()).toContain("Error when evaluating 'if' for job 'a'");
    });
  });

  describe('typed workflow inputs', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-typed-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('gives boolean and number inputs their types in the inputs context, like GitHub', async () => {
      fs.writeFileSync(
        path.join(dir, 'reuse.yml'),
        `
name: R
on:
  workflow_call:
    inputs:
      flag: { type: boolean, default: true }
      count: { type: number, default: 3 }
      label: { type: string, default: x }
jobs:
  gated:
    if: \${{ inputs.flag }}
    runs-on: ubuntu-latest
    steps:
      - run: echo "gated ran"
  always:
    runs-on: ubuntu-latest
    steps:
      - if: \${{ !inputs.flag }}
        run: echo "inverse branch ran"
      - run: echo "count-is-number=\${{ inputs.count == 3 && inputs.count > 2 }} json=\${{ toJSON(inputs.flag) }} label=\${{ inputs.label }}"
`
      );
      const caller = path.join(dir, 'caller.yml');
      fs.writeFileSync(
        caller,
        'name: C\non: push\njobs:\n  off:\n    uses: ./reuse.yml\n    with:\n      flag: false\n      count: 3\n'
      );

      const result = await executeWorkflow(caller);
      const out = result.jobs
        .flatMap((j) => j.steps.map((s) => s.output ?? ''))
        .join('\n');
      expect(result.success).toBe(true);
      expect(out).not.toContain('gated ran');
      expect(out).toContain('inverse branch ran');
      expect(out).toContain('count-is-number=true json=false label=x');
    });

    it('types workflow_dispatch inputs passed with --input', async () => {
      const file = path.join(dir, 'dispatch.yml');
      fs.writeFileSync(
        file,
        `
name: D
on:
  workflow_dispatch:
    inputs:
      dry-run: { type: boolean, default: false }
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - if: \${{ inputs.dry-run }}
        run: echo "dry run"
      - if: \${{ !inputs.dry-run }}
        run: echo "real run"
`
      );
      const off = await executeWorkflow(file, {
        inputs: { 'dry-run': 'false' }
      });
      const on = await executeWorkflow(file, { inputs: { 'dry-run': 'true' } });
      const text = (r: typeof off) =>
        r.jobs[0].steps.map((s) => s.output ?? '').join('\n');
      expect(text(off)).toContain('real run');
      expect(text(off)).not.toContain('dry run');
      expect(text(on)).toContain('dry run');
      expect(text(on)).not.toContain('real run');
    });
  });

  describe('per-step action variables', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-action-env-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('sets GITHUB_ACTION and github.action like the runner', async () => {
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        [
          'name: A',
          'on: push',
          'jobs:',
          '  a:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: echo "one=$GITHUB_ACTION ctx=${{ github.action }}"',
          '      - run: echo "two=$GITHUB_ACTION"',
          '      - id: named',
          '        run: echo "three=$GITHUB_ACTION"'
        ].join('\n')
      );
      const result = await executeWorkflow(file);
      const out = result.jobs[0].steps.map((s) => s.output).join('\n');
      expect(out).toContain('one=__run ctx=__run');
      expect(out).toContain('two=__run_2');
      expect(out).toContain('three=named');
    });

    it('sets GITHUB_ACTION_REPOSITORY/REF for remote actions, and GITHUB_ACTION_PATH in composites', async () => {
      const comp = path.join(dir, 'comp');
      fs.mkdirSync(comp);
      fs.writeFileSync(
        path.join(comp, 'hello.sh'),
        'echo "script in action dir ran"\n'
      );
      fs.writeFileSync(
        path.join(comp, 'action.yml'),
        [
          'name: comp',
          'description: d',
          'runs:',
          '  using: composite',
          '  steps:',
          '    - shell: bash',
          '      run: |',
          '        bash "$GITHUB_ACTION_PATH/hello.sh"',
          '        test "${{ github.action_path }}" = "$GITHUB_ACTION_PATH" && echo "path-matches=true"',
          '        echo "repo=$GITHUB_ACTION_REPOSITORY ref=$GITHUB_ACTION_REF"'
        ].join('\n')
      );
      fetchActionMock.mockResolvedValueOnce(path.join(comp, 'action.yml'));
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        'name: B\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: org/comp@v2\n'
      );

      const logSpy = vi.spyOn(console, 'log');
      let out = '';
      let result: Awaited<ReturnType<typeof executeWorkflow>>;
      try {
        result = await executeWorkflow(file);
        out = logSpy.mock.calls.flat().join('\n');
      } finally {
        logSpy.mockRestore();
      }
      expect(result.success).toBe(true);
      expect(out).toContain('script in action dir ran');
      expect(out).toContain('path-matches=true');
      expect(out).toContain('repo=org/comp ref=v2');
    });
  });

  describe('timeout-minutes', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-timeout-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
    function write(body: string): string {
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(file, body);
      return file;
    }

    it('fails a step that runs past its timeout-minutes (expressions allowed)', async () => {
      const started = Date.now();
      const result = await executeWorkflow(
        write(`
name: T
on:
  workflow_dispatch:
    inputs:
      limit: { type: number, default: 0.02 }
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: slow
        timeout-minutes: \${{ inputs.limit }}
        run: sleep 5
      - if: always()
        run: echo "after"
`),
        { containerRuntime: 'host' }
      );
      expect(Date.now() - started).toBeLessThan(4500);
      expect(result.success).toBe(false);
      expect(result.jobs[0].steps[0].error).toContain(
        "The action 'slow' has timed out after 0.02 minutes"
      );
      expect(result.jobs[0].steps[1].output).toContain('after');
    });

    it('stops a job at its timeout-minutes and skips the remaining steps', async () => {
      const result = await executeWorkflow(
        write(`
name: J
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    timeout-minutes: 0.02
    steps:
      - run: sleep 5
      - run: echo "never"
`),
        { containerRuntime: 'host' }
      );
      expect(result.success).toBe(false);
      const steps = result.jobs[0].steps;
      expect(steps[0].success).toBe(false);
      expect(steps[0].error).toContain(
        'exceeded the maximum execution time of 0.02 minutes'
      );
      expect(steps.map((s) => s.output ?? '').join('')).not.toContain('never');
    });

    it('passes the step timeout to the job container', async () => {
      const fake = fakeJobContainerRuntime();
      resolveContainerRuntimeMock.mockResolvedValue(fake);
      await executeWorkflow(
        write(`
name: C
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - timeout-minutes: 2
        run: echo hi
`),
        { containerRuntime: 'docker' }
      );
      const call = fake.exec.mock.calls
        .map((c) => c[1] as { command?: string; timeoutMs?: number })
        .find((c) => /script\.sh/.test(c.command ?? ''));
      expect(call?.timeoutMs).toBe(120000);
    });
  });
});
