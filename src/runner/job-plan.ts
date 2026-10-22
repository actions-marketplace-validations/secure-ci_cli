import { logger } from '../utils/logger';
import { resolveExpressionValue, ExpressionContext } from './expression';

/** Deep equality for matrix values (JSON-like data). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return (
    keysA.length === keysB.length &&
    keysA.every((key) =>
      sameValue(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    )
  );
}

/** `key: value, ...` for a matrix combination's job label. */
export function matrixLabel(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(([k, v]) => `${k}: ${matrixValueText(v)}`)
    .join(', ');
}

/** A boolean setting that may be an expression (`continue-on-error`). */
export function isTruthySetting(
  value: unknown,
  ctx: ExpressionContext
): boolean {
  const resolved = matrixValue(value, ctx);
  return resolved === true || resolved === 'true';
}

/** A positive number setting (e.g. timeout-minutes), possibly an expression. */
export function numberSetting(
  value: unknown,
  ctx: ExpressionContext
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(matrixValue(value, ctx));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A `${{ }}` string resolved to its value (e.g. via fromJSON), else as is. */
export function matrixValue(value: unknown, ctx: ExpressionContext): unknown {
  if (typeof value !== 'string' || !/^\s*\$\{\{[\s\S]*\}\}\s*$/.test(value)) {
    return value;
  }
  return resolveExpressionValue(value, ctx);
}

/**
 * Expand a job's `strategy.matrix` into its combinations, as GitHub does:
 * the cartesian product of the axes, minus combinations matching an
 * `exclude` entry (on all of its keys), then each `include` entry is
 * merged into every combination whose original axis values it doesn't
 * change (values added by an earlier include may be overwritten), or
 * added as a new combination if it fits none. The matrix, or any axis,
 * may be an expression such as `${{ fromJSON(needs.x.outputs.m) }}`.
 */
export function expandMatrix(
  rawMatrix: unknown,
  ctx: ExpressionContext
): Array<Record<string, unknown>> {
  const matrix = matrixValue(rawMatrix, ctx);
  if (!matrix || typeof matrix !== 'object' || Array.isArray(matrix)) {
    return [{}];
  }

  const entries = (key: string): Array<Record<string, unknown>> => {
    const list = matrixValue((matrix as Record<string, unknown>)[key], ctx);
    return Array.isArray(list)
      ? list.filter(
          (e): e is Record<string, unknown> => !!e && typeof e === 'object'
        )
      : [];
  };
  const include = entries('include');
  const exclude = entries('exclude');
  const axes = Object.entries(matrix as Record<string, unknown>)
    .filter(([key]) => key !== 'include' && key !== 'exclude')
    .map(([key, raw]): [string, unknown[]] => {
      const values = matrixValue(raw, ctx);
      return [key, Array.isArray(values) ? values : [values]];
    });
  const axisKeys = new Set(axes.map(([key]) => key));

  let combinations: Array<Record<string, unknown>> = axes.length ? [{}] : [];
  for (const [key, values] of axes) {
    combinations = combinations.flatMap((combo) =>
      values.map((value) => ({ ...combo, [key]: value }))
    );
  }
  combinations = combinations.filter(
    (combo) =>
      !exclude.some((entry) =>
        Object.entries(entry).every(([key, value]) =>
          sameValue(combo[key], value)
        )
      )
  );

  const added: Array<Record<string, unknown>> = [];
  for (const entry of include) {
    let merged = false;
    for (const combo of combinations) {
      const fits = Object.entries(entry).every(
        ([key, value]) => !axisKeys.has(key) || sameValue(combo[key], value)
      );
      if (fits) {
        Object.assign(combo, entry);
        merged = true;
      }
    }
    if (!merged) added.push({ ...entry });
  }
  combinations.push(...added);
  return combinations.length ? combinations : [{}];
}

/**
 * `--matrix key:value` filters: key -> accepted values (as text). Repeating
 * a key accepts any of its values.
 */
export type MatrixFilter = Record<string, string[]>;

/**
 * Parse repeatable `--matrix key:value` arguments. Splits on the first `:`
 * only, so values may contain colons (`image:node:20-alpine`).
 */
export function parseMatrixFilter(
  pairs: string | string[] | undefined
): MatrixFilter {
  const filter: MatrixFilter = {};
  for (const pair of pairs === undefined ? [] : [pairs].flat()) {
    const separator = pair.indexOf(':');
    if (separator <= 0) {
      throw new Error(
        `Invalid --matrix argument "${pair}": expected key:value`
      );
    }
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const values = (filter[key] ??= []);
    if (!values.includes(value)) values.push(value);
  }
  return filter;
}

/** A matrix value as text, the way it appears in the job name. */
export function matrixValueText(value: unknown): string {
  return value && typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);
}

export interface MatrixSelection {
  /** Filter keys this matrix defines (the ones that were applied). */
  keys: string[];
  /** Matching combinations with their index in the full expansion. */
  matches: Array<{ index: number; values: Record<string, unknown> }>;
}

/**
 * Keep the combinations whose value for every filter key the matrix
 * defines is one of the accepted values (compared as text). Keys the
 * matrix doesn't define don't apply, so jobs without a matrix are
 * unaffected; a combination lacking an applied key doesn't match.
 */
export function filterMatrix(
  combinations: Array<Record<string, unknown>>,
  filter: MatrixFilter
): MatrixSelection {
  const keys = Object.keys(filter).filter((key) =>
    combinations.some((combo) => key in combo)
  );
  const matches = combinations
    .map((values, index) => ({ index, values }))
    .filter(({ values }) =>
      keys.every(
        (key) =>
          key in values && filter[key].includes(matrixValueText(values[key]))
      )
    );
  return { keys, matches };
}

/** The warning for a matrix job none of whose combinations match. */
export function noMatrixMatchMessage(
  jobId: string,
  filter: MatrixFilter,
  combinations: Array<Record<string, unknown>>
): string {
  const wanted = Object.entries(filter)
    .flatMap(([key, values]) => values.map((value) => `${key}:${value}`))
    .join(', ');
  return [
    `No matrix combination of job "${jobId}" matches --matrix ${wanted}; skipping it. Available combinations:`,
    ...combinations.map((combo) => `  ${matrixLabel(combo)}`)
  ].join('\n');
}

/** Filter keys that no expanded matrix defined. */
export function unknownMatrixKeys(
  filter: MatrixFilter,
  definedKeys: Set<string>
): string[] {
  return Object.keys(filter).filter((key) => !definedKeys.has(key));
}

/**
 * Order job IDs so dependencies (via `needs`) run before dependents, using
 * Kahn's algorithm. Falls back to declaration order (with a warning) if a
 * cycle is detected, since that indicates an invalid workflow.
 */
export function topologicalJobOrder(
  jobs: Record<string, { needs?: string | string[] }>
): string[] {
  const jobIds = Object.keys(jobs);
  const needsOf = (id: string): string[] => {
    const needs = jobs[id].needs;
    if (!needs) return [];
    return Array.isArray(needs) ? needs : [needs];
  };

  const inDegree = new Map<string, number>();
  for (const id of jobIds) {
    inDegree.set(id, needsOf(id).filter((dep) => jobIds.includes(dep)).length);
  }

  const queue = jobIds.filter((id) => inDegree.get(id) === 0);
  const ordered: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    ordered.push(id);

    for (const other of jobIds) {
      if (needsOf(other).includes(id)) {
        const remaining = (inDegree.get(other) || 0) - 1;
        inDegree.set(other, remaining);
        if (remaining === 0) {
          queue.push(other);
        }
      }
    }
  }

  if (ordered.length !== jobIds.length) {
    logger.warn(
      'Detected a cycle in job "needs" dependencies; falling back to declaration order.'
    );
    return jobIds;
  }

  return ordered;
}
