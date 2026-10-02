import { logger } from '../utils/logger';

/**
 * Minimal GitHub Actions expression evaluator.
 *
 * Supports a subset of the real `${{ }}` expression syntax, sufficient for
 * `if:` conditions: env/inputs/secrets/steps member access, success()/
 * failure()/always()/cancelled(), ==, !=, &&, ||, !, parentheses, and
 * string/number/boolean literals.
 *
 * Not supported (yet): contains(), format(), hashFiles(), github.*, matrix.*.
 */

export interface StepOutcomeInfo {
  outcome: 'success' | 'failure' | 'skipped';
  outputs: Record<string, string>;
}

export interface ExpressionContext {
  env: Record<string, string>;
  inputs: Record<string, string>;
  secrets: Record<string, string>;
  steps: Record<string, StepOutcomeInfo>;
  jobFailed: boolean;
}

export function createContext(
  env: Record<string, string> = {},
  inputs: Record<string, string> = {},
  secrets: Record<string, string> = {}
): ExpressionContext {
  return { env, inputs, secrets, steps: {}, jobFailed: false };
}

type Token =
  | { type: 'ident'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'dot' }
  | { type: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (ch === '.') {
      tokens.push({ type: 'dot' });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== quote) {
        value += input[j];
        j++;
      }
      tokens.push({ type: 'string', value });
      i = j + 1;
      continue;
    }
    if (ch === '=' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '==' });
      i += 2;
      continue;
    }
    if (ch === '!' && input[i + 1] === '=') {
      tokens.push({ type: 'op', value: '!=' });
      i += 2;
      continue;
    }
    if (ch === '&' && input[i + 1] === '&') {
      tokens.push({ type: 'op', value: '&&' });
      i += 2;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      tokens.push({ type: 'op', value: '||' });
      i += 2;
      continue;
    }
    if (ch === '!') {
      tokens.push({ type: 'op', value: '!' });
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      let value = '';
      while (j < input.length && /[0-9.]/.test(input[j])) {
        value += input[j];
        j++;
      }
      tokens.push({ type: 'number', value: Number(value) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      let value = '';
      while (j < input.length && /[A-Za-z0-9_-]/.test(input[j])) {
        value += input[j];
        j++;
      }
      tokens.push({ type: 'ident', value });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

function toBoolean(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value !== '';
  return Boolean(value);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (a === b) return true;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function resolveChain(parts: string[], ctx: ExpressionContext): unknown {
  const [namespace, ...rest] = parts;
  switch (namespace) {
    case 'env':
      return rest.length === 1 ? ctx.env[rest[0]] : undefined;
    case 'inputs':
      return rest.length === 1 ? ctx.inputs[rest[0]] : undefined;
    case 'secrets':
      return rest.length === 1 ? ctx.secrets[rest[0]] : undefined;
    case 'steps': {
      const [stepId, field, outputKey] = rest;
      const step = stepId ? ctx.steps[stepId] : undefined;
      if (!step) return undefined;
      if (field === 'outcome') return step.outcome;
      if (field === 'outputs' && outputKey) return step.outputs[outputKey];
      return undefined;
    }
    default:
      return undefined;
  }
}

function callFunction(name: string, ctx: ExpressionContext): boolean {
  switch (name) {
    case 'success':
      return !ctx.jobFailed;
    case 'failure':
      return ctx.jobFailed;
    case 'always':
      return true;
    case 'cancelled':
      return false;
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

  parseExpression(): unknown {
    return this.parseOr();
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.peek().type === 'op' && (this.peek() as { value: string }).value === '||') {
      this.next();
      const right = this.parseAnd();
      left = toBoolean(left) || toBoolean(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.peek().type === 'op' && (this.peek() as { value: string }).value === '&&') {
      this.next();
      const right = this.parseEquality();
      left = toBoolean(left) && toBoolean(right);
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseUnary();
    while (
      this.peek().type === 'op' &&
      ((this.peek() as { value: string }).value === '==' ||
        (this.peek() as { value: string }).value === '!=')
    ) {
      const opTok = this.next() as { value: string };
      const right = this.parseUnary();
      const eq = looseEquals(left, right);
      left = opTok.value === '==' ? eq : !eq;
    }
    return left;
  }

  private parseUnary(): unknown {
    if (this.peek().type === 'op' && (this.peek() as { value: string }).value === '!') {
      this.next();
      return !toBoolean(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const tok = this.peek();
    if (tok.type === 'lparen') {
      this.next();
      const value = this.parseExpression();
      this.expect('rparen');
      return value;
    }
    if (tok.type === 'string') {
      this.next();
      return tok.value;
    }
    if (tok.type === 'number') {
      this.next();
      return tok.value;
    }
    if (tok.type === 'ident') {
      if (tok.value === 'true') {
        this.next();
        return true;
      }
      if (tok.value === 'false') {
        this.next();
        return false;
      }
      return this.parseIdentOrCall();
    }
    throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
  }

  private parseIdentOrCall(): unknown {
    const first = this.next() as { type: 'ident'; value: string };
    const parts = [first.value];
    while (this.peek().type === 'dot') {
      this.next();
      const part = this.next();
      if (part.type !== 'ident') {
        throw new Error('Expected identifier after .');
      }
      parts.push(part.value);
    }
    if (this.peek().type === 'lparen' && parts.length === 1) {
      this.next();
      this.expect('rparen');
      return callFunction(parts[0], this.ctx);
    }
    return resolveChain(parts, this.ctx);
  }
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
    const tokens = tokenize(inner);
    return new Parser(tokens, ctx).parseExpression();
  } catch (error) {
    logger.warn(
      `Failed to resolve expression "${expr}": ${error instanceof Error ? error.message : 'unknown error'}.`
    );
    return undefined;
  }
}

/**
 * Evaluate an `if:` condition string against the given context.
 * Returns true when the condition is undefined/empty, or when it fails to
 * parse (fails open, with a warning, to avoid unexpectedly skipping steps).
 */
export function evaluateCondition(
  expr: string | undefined,
  ctx: ExpressionContext
): boolean {
  if (expr === undefined) return true;

  let trimmed = expr.trim();
  const wrapped = trimmed.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) trimmed = wrapped[1].trim();
  if (trimmed === '') return true;

  try {
    const tokens = tokenize(trimmed);
    const result = new Parser(tokens, ctx).parseExpression();
    return toBoolean(result);
  } catch (error) {
    logger.warn(
      `Failed to evaluate condition "${expr}": ${error instanceof Error ? error.message : 'unknown error'}. Defaulting to true.`
    );
    return true;
  }
}

