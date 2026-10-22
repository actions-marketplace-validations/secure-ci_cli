import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const resolveContainerRuntimeMock = vi.fn();

vi.mock('./container-runtime', async () => {
  const actual = await vi.importActual('./container-runtime');
  return {
    ...actual,
    resolveContainerRuntime: (...args: unknown[]) =>
      resolveContainerRuntimeMock(...args)
  };
});

import { executeWorkflow } from './executor';

/** Parallel execution of jobs and matrix combinations (#49). */
describe('executeWorkflow: parallel jobs (#49)', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  const workflow = (yaml: string): string => {
    const file = path.join(dir, 'workflow.yml');
    fs.writeFileSync(file, yaml);
    return file;
  };

  // Wait (up to ~5s) for a marker file another job creates; fails if none.
  const waitFor = (name: string) =>
    `(for i in $(seq 100); do [ -e "${dir}/${name}" ] && exit 0; sleep 0.05; done; exit 1)`;

  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-parallel-'));
    savedEnv = {};
    for (const key of Object.keys(process.env)) {
      if (/^(GITHUB|RUNNER)_/.test(key)) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
    }
    resolveContainerRuntimeMock.mockReset();
    resolveContainerRuntimeMock.mockResolvedValue(null);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(process.env, savedEnv);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs independent jobs at the same time, and a job after all its needs', async () => {
    const file = workflow(`
name: Graph
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: touch "${dir}/a" && ${waitFor('b')}
  b:
    runs-on: ubuntu-latest
    steps:
      - run: touch "${dir}/b" && ${waitFor('a')}
  c:
    needs: [a, b]
    runs-on: ubuntu-latest
    steps:
      - run: test -e "${dir}/a" && test -e "${dir}/b" && echo both-done
`);
    const result = await executeWorkflow(file, { parallel: 4 });
    expect(result.success).toBe(true);
    // Results stay in workflow (needs) order, whatever finished first.
    expect(result.jobs.map((j) => j.job)).toEqual(['a', 'b', 'c']);
    expect(result.jobs[2].steps[0].output).toContain('both-done');
  });

  it('prefixes log lines with the job label when jobs run concurrently', async () => {
    const file = workflow(`
name: Prefixed
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo "hello \${{ matrix.node }}"
`);
    const result = await executeWorkflow(file, { parallel: 2 });
    expect(result.success).toBe(true);
    const out = logged();
    expect(out).toContain('[build (node: 18)] [INFO] hello 18');
    expect(out).toContain('[build (node: 20)] [INFO] hello 20');
    expect(out).toContain('[build] ✓ Job build completed successfully');
  });

  it('does not prefix with --parallel 1 (sequential, as before)', async () => {
    const file = workflow(`
name: Sequential
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo "hello \${{ matrix.node }}"
  after:
    runs-on: ubuntu-latest
    steps:
      - run: echo after
`);
    const result = await executeWorkflow(file, { parallel: 1 });
    expect(result.success).toBe(true);
    const out = logged();
    expect(out).not.toMatch(/^\[build/m);
    // Strictly one job after another, in order.
    const order = [...out.matchAll(/Executing job: (.*)/g)].map((m) => m[1]);
    expect(order).toEqual(['build (node: 18)', 'build (node: 20)', 'after']);
  });

  it('does not prefix a lone job even when parallel', async () => {
    const file = workflow(`
name: Lone
on: push
jobs:
  only:
    runs-on: ubuntu-latest
    steps:
      - run: echo solo
`);
    await executeWorkflow(file, { parallel: 4 });
    expect(logged()).toContain('[INFO] solo');
    expect(logged()).not.toContain('[only]');
  });

  it('honours strategy.max-parallel', async () => {
    // Each combination holds a lock (mkdir is atomic) for a while; any
    // overlap would make a mkdir fail.
    const file = workflow(`
name: MaxParallel
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      max-parallel: 1
      matrix:
        n: [1, 2, 3]
    steps:
      - run: mkdir "${dir}/lock" && sleep 0.2 && rmdir "${dir}/lock"
`);
    const result = await executeWorkflow(file, { parallel: 4 });
    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(3);
  });

  it('honours the global --parallel limit across jobs', async () => {
    const file = workflow(`
name: Limit
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir "${dir}/lock" && sleep 0.2 && rmdir "${dir}/lock"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: mkdir "${dir}/lock" && sleep 0.2 && rmdir "${dir}/lock"
`);
    // Under the limit of 1 they can't overlap; this also takes the
    // sequential path.
    const result = await executeWorkflow(file, { parallel: 1 });
    expect(result.success).toBe(true);
  });

  it('cancels in-progress matrix siblings on failure (fail-fast)', async () => {
    const file = workflow(`
name: FailFast
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - run: |
          if [ "\${{ matrix.n }}" = "1" ]; then ${waitFor('started-2')}; exit 1; fi
          touch "${dir}/started-2"
          for i in $(seq 100); do sleep 0.05; done
          touch "${dir}/finished-2"
      - run: touch "${dir}/second-step-2"
  after:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo never
`);
    const started = Date.now();
    const result = await executeWorkflow(file, { parallel: 4 });
    expect(Date.now() - started).toBeLessThan(4000);
    expect(result.success).toBe(false);
    const [one, two] = result.jobs;
    expect(one).toMatchObject({ job: 'test (n: 1)', success: false });
    expect(one.cancelled).toBeUndefined();
    expect(two).toMatchObject({
      job: 'test (n: 2)',
      success: false,
      cancelled: true
    });
    expect(two.steps).toHaveLength(1);
    expect(two.steps[0].error).toBe('The operation was canceled.');
    expect(fs.existsSync(path.join(dir, 'finished-2'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'second-step-2'))).toBe(false);
    expect(result.jobs).toHaveLength(2);
    expect(logged()).toContain('Skipping job: after');
  });

  it('keeps siblings running when the failure is allowed by continue-on-error', async () => {
    const file = workflow(`
name: Experimental
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    continue-on-error: \${{ matrix.experimental }}
    strategy:
      matrix:
        experimental: [true, false]
    steps:
      - run: |
          if [ "\${{ matrix.experimental }}" = "true" ]; then exit 1; fi
          sleep 0.2
          echo stable-ok
`);
    const result = await executeWorkflow(file, { parallel: 4 });
    expect(result.success).toBe(true);
    expect(result.jobs[0]).toMatchObject({
      success: false,
      continueOnError: true
    });
    expect(result.jobs[1].success).toBe(true);
    expect(result.jobs[1].steps[0].output).toContain('stable-ok');
  });

  it('lets other combinations finish with fail-fast: false', async () => {
    const file = workflow(`
name: NoFailFast
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        n: [1, 2]
    steps:
      - run: |
          if [ "\${{ matrix.n }}" = "1" ]; then exit 1; fi
          sleep 0.2
          echo two-ok
`);
    const result = await executeWorkflow(file, { parallel: 4 });
    expect(result.success).toBe(false);
    expect(result.jobs.map((j) => j.success)).toEqual([false, true]);
    expect(result.jobs[1].cancelled).toBeUndefined();
  });

  it('propagates skipped dependencies and runs always() jobs', async () => {
    const file = workflow(`
name: Skips
on: push
jobs:
  gate:
    if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo gate
  build:
    needs: gate
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  report:
    needs: build
    if: always()
    runs-on: ubuntu-latest
    steps:
      - run: echo "build=\${{ needs.build.result }}"
`);
    const result = await executeWorkflow(file, { parallel: 4 });
    expect(result.success).toBe(true);
    expect(result.jobs.map((j) => j.job)).toEqual(['report']);
    expect(result.jobs[0].steps[0].output).toContain('build=skipped');
  });

  it('gives each concurrent job its own RUNNER_TEMP', async () => {
    const file = workflow(`
name: Temp
on: push
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$RUNNER_TEMP"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "$RUNNER_TEMP"
`);
    const result = await executeWorkflow(file, { parallel: 2 });
    const [a, b] = result.jobs.map((j) => j.steps[0].output?.trim());
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it('merges matrix job outputs in combination order', async () => {
    const file = workflow(`
name: Outputs
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    outputs:
      last: \${{ steps.s.outputs.v }}
    steps:
      - id: s
        run: |
          if [ "\${{ matrix.n }}" = "2" ]; then echo "v=two" >> "$GITHUB_OUTPUT"; exit 0; fi
          sleep 0.3
          echo "v=one" >> "$GITHUB_OUTPUT"
  use:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo "got=\${{ needs.build.outputs.last }}"
`);
    const result = await executeWorkflow(file, { parallel: 4 });
    // Like the sequential run: the last combination's value wins.
    expect(result.jobs[2].steps[0].output).toContain('got=two');
  });

  it('stops and removes a cancelled job container (container mode)', async () => {
    let nextId = 0;
    const releases = new Map<string, () => void>();
    const stopped: string[] = [];
    const fake = {
      name: 'docker' as const,
      isAvailable: vi.fn().mockResolvedValue(true),
      execute: vi.fn(),
      build: vi.fn(),
      start: vi.fn(async () => ({ success: true, id: `ctr-${++nextId}` })),
      exec: vi.fn(async (id: string, opts: { command?: string }) => {
        const isStep = /\/script\.[a-z0-9]*'?$/.test(opts.command ?? '');
        const base = {
          stderr: '',
          timedOut: false,
          durationMs: 1
        };
        if (!isStep) return { ...base, success: true, stdout: '', exitCode: 0 };
        if (id === 'ctr-1') {
          // Fail once the sibling is running.
          await new Promise<void>((r) => {
            const check = () => (nextId >= 2 ? r() : setTimeout(check, 5));
            check();
          });
          return { ...base, success: false, stdout: '', exitCode: 1 };
        }
        // Runs until its container is removed.
        await new Promise<void>((r) => releases.set(id, r));
        return { ...base, success: false, stdout: '', exitCode: 137 };
      }),
      stop: vi.fn(async (id: string) => {
        stopped.push(id);
        releases.get(id)?.();
      }),
      stopSync: vi.fn(),
      createNetwork: vi.fn().mockResolvedValue(true),
      removeNetwork: vi.fn().mockResolvedValue(undefined),
      removeNetworkSync: vi.fn(),
      health: vi.fn().mockResolvedValue('healthy'),
      ports: vi.fn().mockResolvedValue({})
    };
    resolveContainerRuntimeMock.mockResolvedValue(fake);

    const file = workflow(`
name: ContainerCancel
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2]
    steps:
      - run: echo "\${{ matrix.n }}"
`);
    const result = await executeWorkflow(file, {
      parallel: 2,
      containerRuntime: 'docker'
    });
    expect(result.success).toBe(false);
    expect(result.jobs[1]).toMatchObject({
      job: 'test (n: 2)',
      cancelled: true
    });
    expect(stopped.sort()).toEqual(['ctr-1', 'ctr-2']);
  });

  it('runs matrix calls of a reusable workflow in parallel, sharing the limit', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(
      path.join(dir, 'called.yml'),
      `
name: Called
on:
  workflow_call:
    inputs:
      n:
        type: string
jobs:
  inner:
    runs-on: ubuntu-latest
    steps:
      - run: |
          touch "${dir}/called-\${{ inputs.n }}"
          ${waitFor('called-1')} && ${waitFor('called-2')}
`
    );
    const file = workflow(`
name: Caller
on: push
jobs:
  call:
    strategy:
      matrix:
        n: ['1', '2']
    uses: ./called.yml
    with:
      n: \${{ matrix.n }}
`);
    const result = await executeWorkflow(file, { parallel: 2 });
    expect(result.success).toBe(true);
    expect(result.jobs.map((j) => j.job)).toEqual([
      'call (n: 1)',
      'call (n: 2)'
    ]);
    expect(logged()).toContain('[call (n: 1)]');
  });
});
