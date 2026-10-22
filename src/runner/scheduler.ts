import * as os from 'os';
import { NeedsInfo } from './expression';

/**
 * Concurrency for `secureci run`: a global limit on running jobs
 * (`--parallel`), the job graph (a job starts once all its `needs:` are
 * done) and matrix combinations (`strategy.max-parallel`, `fail-fast`).
 * Pure scheduling: what a job or combination does is up to the caller.
 */

/** How a matrix combination (or a single job) ended. */
export interface UnitOutcome {
  result: 'success' | 'failure' | 'cancelled';
  /** Failed, but allowed to by job-level `continue-on-error`. */
  allowedFailure?: boolean;
}

/** A FIFO counting semaphore: at most `limit` holders at a time. */
export class Slots {
  readonly limit: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit) || 1);
  }

  /** Wait for a free slot; call the returned function to free it. */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // The releasing holder hands its slot straight to us.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}

/** The machine's CPU count (the default for `--parallel`), at least 1. */
export function defaultParallelism(
  osApi: {
    availableParallelism?: () => number;
    cpus?: () => unknown[];
  } = os
): number {
  const n = osApi.availableParallelism
    ? osApi.availableParallelism()
    : (osApi.cpus?.().length ?? 1);
  return Math.max(1, n);
}

/** Parse `--parallel` / config `parallel`. Throws unless a positive integer. */
export function parseParallel(raw: string | number): number {
  const n = typeof raw === 'number' ? raw : raw.trim() ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `Invalid value "${raw}" for parallel. Must be a positive integer.`
    );
  }
  return n;
}

export interface MatrixOptions {
  /** `strategy.fail-fast`: cancel the other combinations on a failure. */
  failFast: boolean;
  /** `strategy.max-parallel`: combinations of this job running at once. */
  maxParallel?: number;
  /** Global slots each running combination holds (omit for none). */
  slots?: Slots;
  /** Cancels every combination (e.g. the run was interrupted). */
  signal?: AbortSignal;
  /** Called once when fail-fast leaves combinations unstarted or cancelled. */
  onFailFast?: () => void;
}

/**
 * Run `count` matrix combinations, at most `maxParallel` at once and each
 * holding one of the global `slots` while it runs. With fail-fast, a
 * failure (not allowed by continue-on-error) aborts the signals of the
 * combinations in progress and starts no more, as GitHub cancels the rest
 * of the matrix. Returns each combination's outcome by index, or
 * undefined for one that never started.
 */
export async function runMatrix<R extends UnitOutcome>(
  count: number,
  run: (index: number, signal: AbortSignal) => Promise<R>,
  options: MatrixOptions
): Promise<Array<R | undefined>> {
  const outcomes: Array<R | undefined> = new Array(count).fill(undefined);
  const local = new Slots(options.maxParallel ?? count);
  const controllers = new Map<number, AbortController>();
  let stopped = options.signal?.aborted ?? false;
  let finished = 0;
  const onParentAbort = (): void => {
    stopped = true;
    for (const controller of controllers.values()) controller.abort();
  };
  options.signal?.addEventListener('abort', onParentAbort);

  const runOne = async (index: number): Promise<void> => {
    const releaseLocal = await local.acquire();
    try {
      if (stopped) return;
      const releaseGlobal = options.slots
        ? await options.slots.acquire()
        : undefined;
      try {
        if (stopped) return;
        const controller = new AbortController();
        controllers.set(index, controller);
        try {
          const outcome = await run(index, controller.signal);
          outcomes[index] = outcome;
          finished++;
          if (
            options.failFast &&
            !stopped &&
            outcome.result === 'failure' &&
            !outcome.allowedFailure
          ) {
            stopped = true;
            if (finished < count) options.onFailFast?.();
            for (const other of controllers.values()) {
              if (other !== controller) other.abort();
            }
          }
        } finally {
          controllers.delete(index);
        }
      } finally {
        releaseGlobal?.();
      }
    } finally {
      releaseLocal();
    }
  };

  try {
    const settled = await Promise.allSettled(
      Array.from({ length: count }, (_, i) => runOne(i))
    );
    const failed = settled.find(
      (s): s is PromiseRejectedResult => s.status === 'rejected'
    );
    if (failed) throw failed.reason;
    return outcomes;
  } finally {
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

/** A job not started because another job threw. */
class SkippedJob extends Error {}

/**
 * Run the jobs of a workflow. `order` is a topological order of the job
 * ids; a job waits only for its `needs:` that come earlier in it (so a
 * cycle, or an unknown job, doesn't deadlock) and gets their results.
 * Serially, jobs run one after another in `order`; otherwise each starts
 * as soon as its dependencies are done. If a job throws, no further jobs
 * start, running ones finish, and the first error is rethrown.
 */
export async function runJobGraph(
  order: string[],
  needsOf: (id: string) => string[],
  runJob: (id: string, needs: Record<string, NeedsInfo>) => Promise<NeedsInfo>,
  concurrent: boolean
): Promise<Map<string, NeedsInfo>> {
  const results = new Map<string, NeedsInfo>();
  const position = new Map(order.map((id, i) => [id, i]));
  const depsOf = (id: string): string[] =>
    needsOf(id).filter(
      (dep) => (position.get(dep) ?? Infinity) < (position.get(id) as number)
    );
  const needsFor = (id: string): Record<string, NeedsInfo> =>
    Object.fromEntries(
      depsOf(id).map((dep) => [dep, results.get(dep) as NeedsInfo])
    );

  if (!concurrent) {
    for (const id of order) {
      results.set(id, await runJob(id, needsFor(id)));
    }
    return results;
  }

  let broken = false;
  const done = new Map<string, Promise<void>>();
  for (const id of order) {
    const deps = depsOf(id).map((dep) => done.get(dep) as Promise<void>);
    done.set(
      id,
      Promise.all(deps).then(
        async () => {
          if (broken) throw new SkippedJob();
          try {
            results.set(id, await runJob(id, needsFor(id)));
          } catch (error) {
            broken = true;
            throw error;
          }
        },
        () => {
          throw new SkippedJob();
        }
      )
    );
  }
  const settled = await Promise.allSettled(done.values());
  // The first job that failed itself, not one that never started.
  const firstError = settled.find(
    (s): s is PromiseRejectedResult =>
      s.status === 'rejected' && !(s.reason instanceof SkippedJob)
  );
  if (firstError) throw firstError.reason;
  return results;
}
