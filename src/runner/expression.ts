import { logger } from '../utils/logger';
import { hashFiles } from './hash-files';

/**
 * GitHub Actions expression evaluator for `${{ }}` and `if:` conditions.
 * https://docs.github.com/en/actions/learn-github-actions/expressions
 *
 * Supports the env/inputs/secrets/steps/github/matrix/needs/job/runner/
 * vars/strategy contexts with `.`, `[...]` and `*` access; literals
 * (strings with '' escapes, numbers, true/false/null); the operators
 * `! < <= > >= == != && ||` with GitHub's loose typing; and the functions
 * contains, startsWith, endsWith, format, join, toJSON, fromJSON,
 * hashFiles, success, failure, always and cancelled.
 */

export interface StepOutcomeInfo {
  outcome: 'success' | 'failure' | 'skipped';
  /** Result after `continue-on-error` is applied. Defaults to outcome. */
  conclusion?: 'success' | 'failure' | 'skipped';
  outputs: Record<string, string>;
}

/**
 * The `github` context: mostly strings, plus the `event` payload object.
 * https://docs.github.com/en/actions/learn-github-actions/contexts#github-context
 */
export interface GithubContext {
  [key: string]: unknown;
}

export interface NeedsInfo {
  result: 'success' | 'failure' | 'skipped' | 'cancelled';
  outputs: Record<string, string>;
}

export interface ExpressionContext {
  env: Record<string, string>;
  inputs: Record<string, string>;
  secrets: Record<string, string>;
  steps: Record<string, StepOutcomeInfo>;
  github: GithubContext;
  matrix: Record<string, unknown>;
  needs: Record<string, NeedsInfo>;
  job: Record<string, unknown>;
  runner: Record<string, unknown>;
  vars: Record<string, string>;
  strategy: Record<string, unknown>;
  /** Set inside composite actions, where GitHub has no `secrets` context. */
  secretsUnavailable?: boolean;
  /** `jobs.<id>.result/outputs`, only for `on.workflow_call.outputs`. */
  jobs?: Record<string, NeedsInfo>;
  jobFailed: boolean;
  /**
   * Set only when evaluating a job-level `if:`: success() then requires
   * every `needs` job to have succeeded, and failure() is true when any
   * of them failed.
   */
  dependencies?: { allSucceeded: boolean; anyFailed: boolean };
}

export function createContext(
  env: Record<string, string> = {},
  inputs: Record<string, string> = {},
  secrets: Record<string, string> = {},
  github: GithubContext = {},
  matrix: Record<string, unknown> = {}
): ExpressionContext {
  return {
    env,
    inputs,
    secrets,
    steps: {},
    github,
    matrix,
    needs: {},
    job: {},
    runner: {},
    vars: {},
    strategy: {},
    jobFailed: false
  };
}

type Token =
  | { type: 'ident'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'lbracket' }
  | { type: 'rbracket' }
  | { type: 'comma' }
  | { type: 'star' }
  | { type: 'dot' }
  | { type: 'eof' };

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const single: Record<string, Token> = {
      '(': { type: 'lparen' },
      ')': { type: 'rparen' },
      '[': { type: 'lbracket' },
      ']': { type: 'rbracket' },
      ',': { type: 'comma' },
      '*': { type: 'star' },
      '.': { type: 'dot' }
    };
    if (single[ch] && !(ch === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      tokens.push(single[ch]);
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // GitHub strings are single-quoted, with '' as an escaped quote.
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < input.length) {
        if (input[j] === quote) {
          if (input[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          break;
        }
        value += input[j];
        j++;
      }
      if (j >= input.length) {
        throw new Error('Unterminated string literal');
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    const op = OPERATORS.find((candidate) => input.startsWith(candidate, i));
    if (op) {
      tokens.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }
    if (/[0-9.]/.test(ch) || (ch === '-' && /[0-9.]/.test(input[i + 1]))) {
      const match = input
        .slice(i)
        .match(/^-?(?:0x[0-9a-fA-F]+|[0-9]*\.?[0-9]+(?:e[+-]?[0-9]+)?)/);
      if (!match) throw new Error(`Invalid number at position ${i}`);
      tokens.push({ type: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_-]/.test(input[j])) j++;
      tokens.push({ type: 'ident', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

/** GitHub truthiness: false, 0, -0, '', null and NaN are falsy. */
function toBoolean(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value !== '';
  return true;
}

/** GitHub's number coercion for mixed-type comparisons. */
function toNumber(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? 0 : Number(trimmed);
  }
  return NaN;
}

function isPrimitive(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'object';
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (!isPrimitive(a) || !isPrimitive(b)) return a === b;
  if (typeof a === typeof b && typeof a !== 'string') return a === b;
  return toNumber(a) === toNumber(b);
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** How a value is rendered when substituted into text. */
function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return 'Array';
  if (typeof value === 'object') return 'Object';
  return String(value);
}

/** Wraps the result of a `*` filter so further access maps over it. */
class FilteredArray {
  constructor(readonly items: unknown[]) {}
}

function unwrap(value: unknown): unknown {
  return value instanceof FilteredArray ? value.items : value;
}

function member(target: unknown, key: string | number): unknown {
  if (target instanceof FilteredArray) {
    return new FilteredArray(
      target.items.flatMap((item) => {
        const v = member(item, key);
        return v === undefined ? [] : [unwrap(v)];
      })
    );
  }
  if (target === null || target === undefined) return undefined;
  if (Array.isArray(target)) {
    return typeof key === 'number' ? target[key] : undefined;
  }
  if (typeof target === 'object') {
    const record = target as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
    // Property names are case-insensitive in GitHub expressions.
    const match = Object.keys(record).find(
      (k) => k.toLowerCase() === String(key).toLowerCase()
    );
    return match === undefined ? undefined : record[match];
  }
  return undefined;
}

function star(target: unknown): FilteredArray {
  const source = unwrap(target);
  if (Array.isArray(source)) return new FilteredArray([...source]);
  if (source && typeof source === 'object') {
    return new FilteredArray(Object.values(source));
  }
  return new FilteredArray([]);
}

function stepsContext(ctx: ExpressionContext): Record<string, unknown> {
  const steps: Record<string, unknown> = {};
  for (const [id, info] of Object.entries(ctx.steps)) {
    steps[id] = {
      outcome: info.outcome,
      conclusion: info.conclusion ?? info.outcome,
      outputs: info.outputs
    };
  }
  return steps;
}

function rootContext(name: string, ctx: ExpressionContext): unknown {
  switch (name) {
    case 'env':
      return ctx.env;
    case 'inputs':
      return ctx.inputs;
    case 'secrets':
      if (ctx.secretsUnavailable) {
        throw new Error(
          "Unrecognized named-value: 'secrets' (composite actions get secrets as inputs)"
        );
      }
      return ctx.secrets;
    case 'steps':
      return stepsContext(ctx);
    case 'github':
      return ctx.github;
    case 'matrix':
      return ctx.matrix;
    case 'needs':
      return ctx.needs;
    case 'job':
      return ctx.job;
    case 'runner':
      return ctx.runner;
    case 'vars':
      return ctx.vars;
    case 'strategy':
      return ctx.strategy;
    case 'jobs':
      if (ctx.jobs) return ctx.jobs;
      throw new Error(`Unrecognized named-value: 'jobs'`);
    default:
      throw new Error(`Unrecognized named-value: '${name}'`);
  }
}

function formatString(template: string, args: unknown[]): string {
  return template.replace(/\{\{|\}\}|\{(\d+)\}/g, (match, index) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    const i = Number(index);
    if (i >= args.length) {
      throw new Error(`format(): no argument for {${i}}`);
    }
    return toText(args[i]);
  });
}

function callFunction(
  name: string,
  rawArgs: unknown[],
  ctx: ExpressionContext
): unknown {
  const args = rawArgs.map(unwrap);
  switch (name.toLowerCase()) {
    case 'success':
      return !ctx.jobFailed && (ctx.dependencies?.allSucceeded ?? true);
    case 'failure':
      return ctx.jobFailed || (ctx.dependencies?.anyFailed ?? false);
    case 'always':
      return true;
    case 'cancelled':
      return false;
    case 'contains': {
      const [search, item] = args;
      if (Array.isArray(search)) {
        return search.some((element) => looseEquals(element, item));
      }
      return toText(search).toLowerCase().includes(toText(item).toLowerCase());
    }
    case 'startswith':
      return toText(args[0])
        .toLowerCase()
        .startsWith(toText(args[1]).toLowerCase());
    case 'endswith':
      return toText(args[0])
        .toLowerCase()
        .endsWith(toText(args[1]).toLowerCase());
    case 'format':
      return formatString(toText(args[0]), args.slice(1));
    case 'join': {
      const separator = args.length > 1 ? toText(args[1]) : ',';
      return Array.isArray(args[0])
        ? args[0].map(toText).join(separator)
        : toText(args[0]);
    }
    case 'tojson':
      return JSON.stringify(args[0] ?? null, null, 2);
    case 'fromjson':
      return JSON.parse(toText(args[0]));
    case 'hashfiles': {
      const workspace =
        typeof ctx.github.workspace === 'string' && ctx.github.workspace
          ? ctx.github.workspace
          : process.cwd();
      return hashFiles(workspace, args.map(toText));
    }
    default:
      throw new Error(`Unsupported function: ${name}()`);
  }
}

class Parser {
  private pos = 0;

  constructor(
    private tokens: Token[],
    private ctx: ExpressionContext
  ) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: Token['type']): void {
    if (this.peek().type !== type) {
      throw new Error(`Expected ${type} but got ${this.peek().type}`);
    }
    this.next();
  }

  private isOp(...values: string[]): boolean {
    const tok = this.peek();
    return tok.type === 'op' && values.includes(tok.value);
  }

  parse(): unknown {
    const value = this.parseOr();
    if (this.peek().type !== 'eof') {
      throw new Error(`Unexpected token: ${this.peek().type}`);
    }
    return unwrap(value);
  }

  // `||` / `&&` return the deciding operand, like GitHub (and JavaScript).
  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.isOp('||')) {
      this.next();
      const right = this.parseAnd();
      left = toBoolean(unwrap(left)) ? left : right;
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.isOp('&&')) {
      this.next();
      const right = this.parseEquality();
      left = toBoolean(unwrap(left)) ? right : left;
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseComparison();
    while (this.isOp('==', '!=')) {
      const op = (this.next() as { value: string }).value;
      const right = this.parseComparison();
      const eq = looseEquals(unwrap(left), unwrap(right));
      left = op === '==' ? eq : !eq;
    }
    return left;
  }

  private parseComparison(): unknown {
    let left = this.parseUnary();
    while (this.isOp('<', '<=', '>', '>=')) {
      const op = (this.next() as { value: string }).value;
      const right = this.parseUnary();
      const c = compare(unwrap(left), unwrap(right));
      left =
        !Number.isNaN(c) &&
        (op === '<'
          ? c < 0
          : op === '<='
            ? c <= 0
            : op === '>'
              ? c > 0
              : c >= 0);
    }
    return left;
  }

  private parseUnary(): unknown {
    if (this.isOp('!')) {
      this.next();
      return !toBoolean(unwrap(this.parseUnary()));
    }
    return this.parsePostfix(this.parsePrimary());
  }

  private parsePostfix(value: unknown): unknown {
    for (;;) {
      const tok = this.peek();
      if (tok.type === 'dot') {
        this.next();
        const part = this.next();
        if (part.type === 'star') {
          value = star(value);
        } else if (part.type === 'ident') {
          value = member(value, part.value);
        } else {
          throw new Error('Expected property name after .');
        }
      } else if (tok.type === 'lbracket') {
        this.next();
        if (this.peek().type === 'star') {
          this.next();
          value = star(value);
        } else {
          const key = unwrap(this.parseOr());
          value = member(value, typeof key === 'number' ? key : toText(key));
        }
        this.expect('rbracket');
      } else {
        return value;
      }
    }
  }

  private parsePrimary(): unknown {
    const tok = this.next();
    switch (tok.type) {
      case 'lparen': {
        const value = this.parseOr();
        this.expect('rparen');
        return value;
      }
      case 'string':
      case 'number':
        return tok.value;
      case 'ident': {
        const lower = tok.value.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        if (lower === 'null') return null;
        if (this.peek().type === 'lparen') {
          this.next();
          const args: unknown[] = [];
          if (this.peek().type !== 'rparen') {
            args.push(this.parseOr());
            while (this.peek().type === 'comma') {
              this.next();
              args.push(this.parseOr());
            }
          }
          this.expect('rparen');
          return callFunction(tok.value, args, this.ctx);
        }
        return rootContext(lower, this.ctx);
      }
      default:
        throw new Error(`Unexpected token: ${tok.type}`);
    }
  }
}

function evaluate(expr: string, ctx: ExpressionContext): unknown {
  return new Parser(tokenize(expr), ctx).parse();
}

/**
 * Resolve a single `${{ expr }}` expression to its underlying value (not
 * coerced to boolean), used for e.g. action output value mapping such as
 * `outputs.greeting.value: ${{ steps.greet.outputs.greeting }}`.
 * Returns undefined if the string isn't a (sole) `${{ }}` expression or
 * fails to evaluate.
 */
export function resolveExpressionValue(
  expr: string | undefined,
  ctx: ExpressionContext
): unknown {
  if (expr === undefined) return undefined;

  const trimmed = expr.trim();
  const wrapped = trimmed.match(/^\$\{\{([\s\S]*)\}\}$/);
  const inner = wrapped ? wrapped[1].trim() : trimmed;

  try {
    return evaluate(inner, ctx);
  } catch (error) {
    logger.warn(
      `Failed to resolve expression "${expr}": ${error instanceof Error ? error.message : 'unknown error'}.`
    );
    return undefined;
  }
}

/**
 * Replace every `${{ expr }}` occurrence within a string with its resolved
 * value. Used for substituting env/inputs/secrets/steps/github/matrix
 * references inside `run:` command text. Expressions that fail to resolve
 * are left as `undefined` -> empty string, matching GitHub Actions behavior
 * for unresolved references.
 */
export function substituteExpressions(
  input: string,
  ctx: ExpressionContext
): string {
  return input.replace(/\$\{\{([\s\S]*?)\}\}/g, (full, inner: string) => {
    try {
      return toText(evaluate(inner.trim(), ctx));
    } catch (error) {
      logger.warn(
        `Failed to resolve expression "${full}": ${error instanceof Error ? error.message : 'unknown error'}.`
      );
      return full;
    }
  });
}

/**
 * Resolve every value of an `env:` / `with:` map against the given context,
 * stringifying non-string YAML scalars (e.g. `PORT: 3000`) the way the
 * runner does before exporting them.
 */
export function substituteRecord(
  record: Record<string, unknown> | undefined,
  ctx: ExpressionContext
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record || {})) {
    result[key] = substituteExpressions(String(value ?? ''), ctx);
  }
  return result;
}

const STATUS_FUNCTION = /\b(success|failure|always|cancelled)\s*\(/i;

/**
 * GitHub wraps a job or step `if:` that doesn't call a status function in
 * an implicit `success() && (...)`; an absent `if:` means `success()`.
 */
export function withImplicitSuccess(expr: unknown): string {
  if (expr === undefined || expr === null || String(expr).trim() === '') {
    return 'success()';
  }
  let inner = String(expr).trim();
  const wrapped = inner.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) inner = wrapped[1].trim();
  return STATUS_FUNCTION.test(inner) ? inner : `success() && (${inner})`;
}

/**
 * Evaluate an `if:` condition string against the given context.
 * Returns true when the condition is undefined/empty, or when it fails to
 * parse (fails open, with a warning, to avoid unexpectedly skipping steps).
 */
export function evaluateCondition(
  expr: string | boolean | undefined,
  ctx: ExpressionContext
): boolean {
  if (expr === undefined) return true;

  let trimmed = String(expr).trim();
  const wrapped = trimmed.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) trimmed = wrapped[1].trim();
  if (trimmed === '') return true;

  try {
    return toBoolean(evaluate(trimmed, ctx));
  } catch (error) {
    logger.warn(
      `Failed to evaluate condition "${expr}": ${error instanceof Error ? error.message : 'unknown error'}. Defaulting to true.`
    );
    return true;
  }
}
