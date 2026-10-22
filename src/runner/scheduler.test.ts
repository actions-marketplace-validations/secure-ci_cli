import { describe, it, expect } from 'vitest';
import {
  Slots,
  runMatrix,
  runJobGraph,
  defaultParallelism,
  parseParallel,
  UnitOutcome
} from './scheduler';
import { NeedsInfo } from './expression';

/** A promise that the test resolves by hand. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let pending promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Slots', () => {
  it('never hands out more than its limit, in FIFO order', async () => {
    const slots = new Slots(2);
    const order: number[] = [];
    let active = 0;
    let peak = 0;
    const gates = [0, 1, 2, 3].map(() => deferred());
    const tasks = gates.map(async (gate, i) => {
      const release = await slots.acquire();
      order.push(i);
      active++;
      peak = Math.max(peak, active);
      await gate.promise;
      active--;
      release();
    });
    await flush();
    expect(order).toEqual([0, 1]);
    gates[1].resolve();
    await flush();
    expect(order).toEqual([0, 1, 2]);
    gates.forEach((g) => g.resolve());
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('treats a release called twice as one release', async () => {
    const slots = new Slots(1);
    const release = await slots.acquire();
    release();
    release();
    const a = await slots.acquire();
    let second = false;
    void slots.acquire().then(() => (second = true));
    await flush();
    expect(second).toBe(false);
    a();
    await flush();
    expect(second).toBe(true);
  });

  it('clamps the limit to at least 1', () => {
    expect(new Slots(0).limit).toBe(1);
    expect(new Slots(3.7).limit).toBe(3);
  });
});

describe('defaultParallelism / parseParallel', () => {
  it('is the number of CPUs, at least 1', () => {
    expect(defaultParallelism()).toBeGreaterThanOrEqual(1);
    expect(defaultParallelism({ availableParallelism: () => 6 })).toBe(6);
    expect(defaultParallelism({ cpus: () => [{}, {}, {}] as unknown[] })).toBe(
      3
    );
    expect(defaultParallelism({ cpus: () => [] })).toBe(1);
  });

  it('accepts positive integers only', () => {
    expect(parseParallel('4')).toBe(4);
    expect(parseParallel(2)).toBe(2);
    for (const bad of ['0', '-1', '1.5', 'abc', '', 0]) {
      expect(() => parseParallel(bad)).toThrow(/positive integer/);
    }
  });
});

describe('runMatrix', () => {
  const ok: UnitOutcome = { result: 'success' };

  it('runs combinations concurrently up to max-parallel', async () => {
    const gates = [0, 1, 2, 3].map(() => deferred());
    const started: number[] = [];
    const run = runMatrix(
      4,
      async (i) => {
        started.push(i);
        await gates[i].promise;
        return ok;
      },
      { failFast: true, maxParallel: 2 }
    );
    await flush();
    expect(started).toEqual([0, 1]);
    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);
    gates.forEach((g) => g.resolve());
    const outcomes = await run;
    expect(outcomes.map((o) => o?.result)).toEqual([
      'success',
      'success',
      'success',
      'success'
    ]);
  });

  it('shares the global slots with other work', async () => {
    const slots = new Slots(1);
    const release = await slots.acquire();
    const started: number[] = [];
    const run = runMatrix(
      2,
      async (i) => {
        started.push(i);
        return ok;
      },
      { failFast: true, slots }
    );
    await flush();
    expect(started).toEqual([]);
    release();
    await run;
    expect(started).toEqual([0, 1]);
  });

  it('runs one at a time with max-parallel 1, stopping on failure (fail-fast)', async () => {
    const started: number[] = [];
    let skippedNotice = 0;
    const outcomes = await runMatrix(
      3,
      async (i): Promise<UnitOutcome> => {
        started.push(i);
        return { result: i === 0 ? 'failure' : 'success' };
      },
      { failFast: true, maxParallel: 1, onFailFast: () => skippedNotice++ }
    );
    expect(started).toEqual([0]);
    expect(outcomes).toEqual([{ result: 'failure' }, undefined, undefined]);
    expect(skippedNotice).toBe(1);
  });

  it('cancels in-progress siblings on failure with fail-fast', async () => {
    const signals: AbortSignal[] = [];
    const fail = deferred();
    const outcomes = await runMatrix(
      3,
      async (i, signal): Promise<UnitOutcome> => {
        signals[i] = signal;
        if (i === 0) {
          await fail.promise;
          return { result: 'failure' };
        }
        if (i === 1) {
          setTimeout(() => fail.resolve(), 0);
        }
        await new Promise((r) => signal.addEventListener('abort', r));
        return { result: 'cancelled' };
      },
      { failFast: true }
    );
    expect(outcomes.map((o) => o?.result)).toEqual([
      'failure',
      'cancelled',
      'cancelled'
    ]);
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(true);
    expect(signals[2].aborted).toBe(true);
  });

  it('keeps running siblings when fail-fast is off', async () => {
    const started: number[] = [];
    let notices = 0;
    const outcomes = await runMatrix(
      3,
      async (i): Promise<UnitOutcome> => {
        started.push(i);
        return { result: i === 0 ? 'failure' : 'success' };
      },
      { failFast: false, maxParallel: 1, onFailFast: () => notices++ }
    );
    expect(started).toEqual([0, 1, 2]);
    expect(outcomes.map((o) => o?.result)).toEqual([
      'failure',
      'success',
      'success'
    ]);
    expect(notices).toBe(0);
  });

  it('does not fail fast on a failure allowed by continue-on-error', async () => {
    const started: number[] = [];
    const outcomes = await runMatrix(
      3,
      async (i): Promise<UnitOutcome> => {
        started.push(i);
        return i === 0
          ? { result: 'failure', allowedFailure: true }
          : { result: 'success' };
      },
      { failFast: true, maxParallel: 1 }
    );
    expect(started).toEqual([0, 1, 2]);
    expect(outcomes[0]).toEqual({ result: 'failure', allowedFailure: true });
  });

  it('does not report fail-fast when the failing unit was the last one', async () => {
    let notices = 0;
    await runMatrix(
      2,
      async (i): Promise<UnitOutcome> => ({
        result: i === 1 ? 'failure' : 'success'
      }),
      { failFast: true, maxParallel: 1, onFailFast: () => notices++ }
    );
    expect(notices).toBe(0);
  });

  it('releases global slots even when a unit throws', async () => {
    const slots = new Slots(1);
    await expect(
      runMatrix(
        1,
        async () => {
          throw new Error('boom');
        },
        { failFast: true, slots }
      )
    ).rejects.toThrow('boom');
    const release = await slots.acquire();
    release();
  });

  it('aborts every unit when the parent signal aborts', async () => {
    const parent = new AbortController();
    const started: number[] = [];
    const run = runMatrix(
      3,
      async (i, signal): Promise<UnitOutcome> => {
        started.push(i);
        await new Promise((r) => signal.addEventListener('abort', r));
        return { result: 'cancelled' };
      },
      { failFast: true, maxParallel: 2, signal: parent.signal }
    );
    await flush();
    parent.abort();
    const outcomes = await run;
    expect(started).toEqual([0, 1]);
    expect(outcomes.map((o) => o?.result)).toEqual([
      'cancelled',
      'cancelled',
      undefined
    ]);
  });
});

describe('runJobGraph', () => {
  type Jobs = Record<string, string[]>;
  const needsOf = (jobs: Jobs) => (id: string) => jobs[id] ?? [];

  it('runs jobs serially in the given order when not concurrent', async () => {
    const events: string[] = [];
    const jobs: Jobs = { a: [], b: [], c: ['a'] };
    await runJobGraph(
      ['a', 'b', 'c'],
      needsOf(jobs),
      async (id) => {
        events.push(`start ${id}`);
        await flush();
        events.push(`end ${id}`);
        return { result: 'success', outputs: {} };
      },
      false
    );
    expect(events).toEqual([
      'start a',
      'end a',
      'start b',
      'end b',
      'start c',
      'end c'
    ]);
  });

  it('starts independent jobs together and a job once all its needs are done', async () => {
    const jobs: Jobs = { a: [], b: [], c: ['a', 'b'], d: ['a'] };
    const gates: Record<string, ReturnType<typeof deferred>> = {
      a: deferred(),
      b: deferred(),
      c: deferred(),
      d: deferred()
    };
    const started: string[] = [];
    const run = runJobGraph(
      ['a', 'b', 'c', 'd'],
      needsOf(jobs),
      async (id) => {
        started.push(id);
        await gates[id].promise;
        return { result: 'success', outputs: {} };
      },
      true
    );
    await flush();
    expect(started).toEqual(['a', 'b']);
    gates.a.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'd']);
    gates.b.resolve();
    await flush();
    expect(started).toEqual(['a', 'b', 'd', 'c']);
    gates.c.resolve();
    gates.d.resolve();
    const results = await run;
    expect([...results.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it("hands each job its dependencies' results (e.g. to skip after a failure)", async () => {
    const jobs: Jobs = { build: [], test: ['build'], deploy: ['test'] };
    const seen: Record<string, Record<string, NeedsInfo>> = {};
    const results = await runJobGraph(
      ['build', 'test', 'deploy'],
      needsOf(jobs),
      async (id, needs): Promise<NeedsInfo> => {
        seen[id] = needs;
        if (id === 'build') return { result: 'failure', outputs: {} };
        // A fake `if: success()`: skip when a dependency didn't succeed.
        const ok = Object.values(needs).every((n) => n.result === 'success');
        return { result: ok ? 'success' : 'skipped', outputs: {} };
      },
      true
    );
    expect(seen.test.build.result).toBe('failure');
    expect(seen.deploy.test.result).toBe('skipped');
    expect(results.get('deploy')?.result).toBe('skipped');
  });

  it('does not wait on unknown dependencies or ones later in the order (cycle fallback)', async () => {
    const jobs: Jobs = { a: ['b'], b: ['a'], c: ['missing'] };
    const started: string[] = [];
    await runJobGraph(
      ['a', 'b', 'c'],
      needsOf(jobs),
      async (id, needs) => {
        started.push(`${id}:${Object.keys(needs).join(',')}`);
        return { result: 'success', outputs: {} };
      },
      true
    );
    // b waits for a (earlier); a ignores b; c ignores the unknown job.
    expect(started).toEqual(['a:', 'c:', 'b:a']);
  });

  it('waits for running jobs and rethrows the first error, starting nothing new', async () => {
    const jobs: Jobs = { a: [], b: [], c: ['a'] };
    const started: string[] = [];
    let bDone = false;
    await expect(
      runJobGraph(
        ['a', 'b', 'c'],
        needsOf(jobs),
        async (id) => {
          started.push(id);
          if (id === 'a') throw new Error('a broke');
          await flush();
          await flush();
          bDone = true;
          return { result: 'success', outputs: {} };
        },
        true
      )
    ).rejects.toThrow('a broke');
    expect(started).toEqual(['a', 'b']);
    expect(bDone).toBe(true);
  });
});
