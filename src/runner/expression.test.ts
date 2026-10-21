import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  createContext,
  evaluateCondition,
  expressionDataFlow,
  resolveExpressionValue,
  substituteExpressions,
  validateExpression
} from './expression';

describe('evaluateCondition', () => {
  it('returns true when condition is undefined', () => {
    const ctx = createContext();
    expect(evaluateCondition(undefined, ctx)).toBe(true);
  });

  it('evaluates boolean literals', () => {
    const ctx = createContext();
    expect(evaluateCondition('true', ctx)).toBe(true);
    expect(evaluateCondition('false', ctx)).toBe(false);
  });

  it('strips ${{ }} wrapper', () => {
    const ctx = createContext();
    expect(evaluateCondition('${{ true }}', ctx)).toBe(true);
    expect(evaluateCondition('${{ false }}', ctx)).toBe(false);
  });

  it('resolves env values with truthiness', () => {
    const ctx = createContext({ FLAG: 'yes' });
    expect(evaluateCondition('env.FLAG', ctx)).toBe(true);
    expect(evaluateCondition('env.MISSING', ctx)).toBe(false);
  });

  it('resolves inputs and secrets', () => {
    const ctx = createContext({}, { greet: 'World' }, { TOKEN: 'abc' });
    expect(evaluateCondition("inputs.greet == 'World'", ctx)).toBe(true);
    expect(evaluateCondition("secrets.TOKEN == 'abc'", ctx)).toBe(true);
    expect(evaluateCondition("secrets.TOKEN == 'wrong'", ctx)).toBe(false);
  });

  it('is case-insensitive for string equality, like GitHub expressions', () => {
    const ctx = createContext({}, { greet: 'World' });
    expect(evaluateCondition("inputs.greet == 'world'", ctx)).toBe(true);
  });

  it('supports != operator', () => {
    const ctx = createContext({}, { greet: 'World' });
    expect(evaluateCondition("inputs.greet != 'Nope'", ctx)).toBe(true);
  });

  it('supports && and ||', () => {
    const ctx = createContext({}, { a: 'x', b: 'y' });
    expect(evaluateCondition("inputs.a == 'x' && inputs.b == 'y'", ctx)).toBe(
      true
    );
    expect(evaluateCondition("inputs.a == 'z' || inputs.b == 'y'", ctx)).toBe(
      true
    );
    expect(evaluateCondition("inputs.a == 'z' && inputs.b == 'y'", ctx)).toBe(
      false
    );
  });

  it('supports negation and parentheses', () => {
    const ctx = createContext({}, { a: 'x' });
    expect(evaluateCondition("!(inputs.a == 'z')", ctx)).toBe(true);
  });

  it('resolves steps.<id>.outcome and steps.<id>.outputs.<key>', () => {
    const ctx = createContext();
    ctx.steps['build'] = { outcome: 'success', outputs: { version: '1.2.3' } };
    expect(evaluateCondition("steps.build.outcome == 'success'", ctx)).toBe(
      true
    );
    expect(
      evaluateCondition("steps.build.outputs.version == '1.2.3'", ctx)
    ).toBe(true);
    expect(evaluateCondition('steps.missing.outcome', ctx)).toBe(false);
  });

  it('implements success(), failure(), always(), cancelled()', () => {
    const okCtx = createContext();
    expect(evaluateCondition('success()', okCtx)).toBe(true);
    expect(evaluateCondition('failure()', okCtx)).toBe(false);
    expect(evaluateCondition('always()', okCtx)).toBe(true);
    expect(evaluateCondition('cancelled()', okCtx)).toBe(false);

    const failedCtx = createContext();
    failedCtx.jobFailed = true;
    expect(evaluateCondition('success()', failedCtx)).toBe(false);
    expect(evaluateCondition('failure()', failedCtx)).toBe(true);
  });

  it('throws on invalid expressions instead of failing open', () => {
    const ctx = createContext();
    expect(() => evaluateCondition('inputs.a ===', ctx)).toThrow();
    expect(() => evaluateCondition('unknownFunc()', ctx)).toThrow(
      "Unrecognized function: 'unknownFunc'"
    );
    expect(() => evaluateCondition("fromJSON('not json')", ctx)).toThrow();
  });

  it('resolves matrix values', () => {
    const ctx = createContext({}, {}, {}, {}, { node: '18' });
    expect(evaluateCondition("matrix.node == '18'", ctx)).toBe(true);
    expect(evaluateCondition("matrix.node == '16'", ctx)).toBe(false);
  });

  it('resolves github context values', () => {
    const ctx = createContext({}, {}, {}, { ref_name: 'main' });
    expect(evaluateCondition("github.ref_name == 'main'", ctx)).toBe(true);
  });
});

describe('substituteExpressions', () => {
  it('replaces env/inputs/secrets/matrix/github references', () => {
    const ctx = createContext(
      { FOO: 'bar' },
      { name: 'World' },
      { TOKEN: 'secret' },
      { sha: 'abc123' },
      { node: '18' }
    );
    expect(substituteExpressions('Hello ${{ inputs.name }}', ctx)).toBe(
      'Hello World'
    );
    expect(substituteExpressions('env=${{ env.FOO }}', ctx)).toBe('env=bar');
    expect(substituteExpressions('token=${{ secrets.TOKEN }}', ctx)).toBe(
      'token=secret'
    );
    expect(substituteExpressions('node=${{ matrix.node }}', ctx)).toBe(
      'node=18'
    );
    expect(substituteExpressions('sha=${{ github.sha }}', ctx)).toBe(
      'sha=abc123'
    );
  });

  it('replaces unresolved references with an empty string', () => {
    const ctx = createContext();
    expect(substituteExpressions('value=${{ inputs.missing }}', ctx)).toBe(
      'value='
    );
  });

  it('leaves non-expression text untouched', () => {
    const ctx = createContext();
    expect(substituteExpressions('plain text', ctx)).toBe('plain text');
  });
});

describe('expression functions', () => {
  const value = (expr: string, ctx = createContext()) =>
    resolveExpressionValue(expr, ctx);

  it('contains() searches strings case-insensitively and arrays by element', () => {
    const ctx = createContext({}, {}, {}, { event_name: 'pull_request' });
    expect(value("contains('Hello world', 'WORLD')")).toBe(true);
    expect(value("contains('Hello', 'bye')")).toBe(false);
    expect(value("contains(github.event_name, 'pull')", ctx)).toBe(true);
    expect(
      value(
        'contains(fromJSON(\'["push", "pull_request"]\'), github.event_name)',
        ctx
      )
    ).toBe(true);
    expect(value("contains(fromJSON('[1, 2]'), 3)")).toBe(false);
  });

  it('startsWith() and endsWith() are case-insensitive', () => {
    expect(value("startsWith('refs/heads/main', 'REFS/heads/')")).toBe(true);
    expect(value("endsWith('release.tar.gz', '.GZ')")).toBe(true);
    expect(value("startsWith('abc', 'b')")).toBe(false);
  });

  it('format() replaces {N} and unescapes {{ }}', () => {
    expect(value("format('Hello {0} {1} {0}', 'a', 'b')")).toBe('Hello a b a');
    expect(value("format('{{0}} is {0}', 'x')")).toBe('{0} is x');
  });

  it('join() joins arrays with an optional separator', () => {
    expect(value('join(fromJSON(\'["a","b"]\'))')).toBe('a,b');
    expect(value('join(fromJSON(\'["a","b"]\'), \' | \')')).toBe('a | b');
    expect(value("join('single', '-')")).toBe('single');
  });

  it('toJSON() and fromJSON() round-trip values', () => {
    const ctx = createContext({}, {}, {}, {}, { os: 'linux' });
    expect(value('toJSON(matrix)', ctx)).toBe('{\n  "os": "linux"\n}');
    expect(value('fromJSON(\'{"a": {"b": 3}}\').a.b')).toBe(3);
    expect(value("fromJSON('true')")).toBe(true);
  });

  it('hashFiles() hashes matching files in the workspace, sorted', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-hash-'));
    fs.mkdirSync(path.join(workspace, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'package-lock.json'), 'root');
    fs.writeFileSync(
      path.join(workspace, 'a', 'b', 'package-lock.json'),
      'nested'
    );
    fs.writeFileSync(path.join(workspace, 'a', 'other.txt'), 'x');
    const ctx = createContext({}, {}, {}, { workspace });

    const sha = (data: string | Buffer) =>
      crypto.createHash('sha256').update(data).digest();
    const files = [
      path.join(workspace, 'a', 'b', 'package-lock.json'),
      path.join(workspace, 'package-lock.json')
    ].sort();
    const expected = crypto
      .createHash('sha256')
      .update(Buffer.concat(files.map((f) => sha(fs.readFileSync(f)))))
      .digest('hex');

    expect(value("hashFiles('**/package-lock.json')", ctx)).toBe(expected);
    expect(value("hashFiles('**/nothing-matches')", ctx)).toBe('');
    expect(value("hashFiles('**/*.json', '!a/**')", ctx)).toBe(
      crypto
        .createHash('sha256')
        .update(sha(fs.readFileSync(path.join(workspace, 'package-lock.json'))))
        .digest('hex')
    );
    fs.rmSync(workspace, { recursive: true, force: true });
  });
});

describe('expression operators and contexts', () => {
  const value = (expr: string, ctx = createContext()) =>
    resolveExpressionValue(expr, ctx);

  it('|| and && return operand values, not booleans', () => {
    const ctx = createContext({}, { set: 'yes', empty: '' });
    expect(value("inputs.empty || 'fallback'", ctx)).toBe('fallback');
    expect(value("inputs.set || 'fallback'", ctx)).toBe('yes');
    expect(value("inputs.set && 'both'", ctx)).toBe('both');
    expect(value("inputs.empty && 'both'", ctx)).toBe('');
    expect(
      substituteExpressions("v=${{ inputs.missing || 'default' }}", ctx)
    ).toBe('v=default');
  });

  it('supports < <= > >= with GitHub type coercion', () => {
    expect(value('1 < 2')).toBe(true);
    expect(value('2 <= 2')).toBe(true);
    expect(value("'10' > 9")).toBe(true);
    expect(value("'b' > 'A'")).toBe(true);
    expect(value('3 >= 4')).toBe(false);
  });

  it('coerces mixed types to numbers for ==', () => {
    expect(value("'1' == 1")).toBe(true);
    expect(value('true == 1')).toBe(true);
    expect(value('null == 0')).toBe(true);
    expect(value("'' == 0")).toBe(true);
  });

  it('supports index access and the * object filter', () => {
    const ctx = createContext(
      {},
      {},
      {},
      {
        event: {
          pull_request: { labels: [{ name: 'bug' }, { name: 'docs' }] }
        }
      }
    );
    expect(value("github['event']['pull_request'].labels[1].name", ctx)).toBe(
      'docs'
    );
    expect(
      value("contains(github.event.pull_request.labels.*.name, 'bug')", ctx)
    ).toBe(true);
  });

  it('resolves needs, job, runner, vars and strategy contexts', () => {
    const ctx = createContext();
    ctx.needs = {
      build: { result: 'success', outputs: { version: '1.2.3' } }
    };
    ctx.job = { status: 'success' };
    ctx.runner = { os: 'Linux' };
    ctx.vars = { REGION: 'eu' };
    ctx.strategy = { 'job-index': 0, 'job-total': 2 };
    expect(value('needs.build.outputs.version', ctx)).toBe('1.2.3');
    expect(value("needs.build.result == 'success'", ctx)).toBe(true);
    expect(value('job.status', ctx)).toBe('success');
    expect(value('runner.os', ctx)).toBe('Linux');
    expect(value('vars.REGION', ctx)).toBe('eu');
    expect(value('strategy.job-total', ctx)).toBe(2);
  });

  it('exposes steps.<id>.conclusion', () => {
    const ctx = createContext();
    ctx.steps['lint'] = {
      outcome: 'failure',
      conclusion: 'success',
      outputs: {}
    };
    expect(value('steps.lint.outcome', ctx)).toBe('failure');
    expect(value('steps.lint.conclusion', ctx)).toBe('success');
  });

  it('renders arrays and objects as Array/Object when substituted, like GitHub', () => {
    const ctx = createContext({}, {}, {}, {}, { list: ['a'] });
    expect(substituteExpressions('${{ matrix.list }}', ctx)).toBe('Array');
    expect(substituteExpressions('${{ matrix }}', ctx)).toBe('Object');
    expect(substituteExpressions('${{ null }}', ctx)).toBe('');
  });

  it("supports '' escapes inside single-quoted strings", () => {
    expect(value("'it''s'")).toBe("it's");
  });

  it('treats 0, empty string, null and false as falsy', () => {
    const ctx = createContext();
    expect(evaluateCondition('0', ctx)).toBe(false);
    expect(evaluateCondition("''", ctx)).toBe(false);
    expect(evaluateCondition('null', ctx)).toBe(false);
    expect(evaluateCondition("fromJSON('[]')", ctx)).toBe(true);
  });
});

describe('validateExpression', () => {
  it('accepts valid expressions, wrapped or not', () => {
    expect(
      validateExpression("github.ref == 'refs/heads/main'", 'job-if')
    ).toBeUndefined();
    expect(
      validateExpression(
        "${{ success() && needs.a.result == 'success' }}",
        'job-if'
      )
    ).toBeUndefined();
    expect(
      validateExpression(
        "matrix.os == 'linux' && hashFiles('**/x') != '' && contains(steps.a.outputs.x, 'y')",
        'step-if'
      )
    ).toBeUndefined();
  });

  it('rejects unknown contexts and functions, like GitHub', () => {
    expect(validateExpression("foo == 'x'", 'step-if')).toContain(
      "Unrecognized named-value: 'foo'"
    );
    expect(validateExpression('bogus()', 'step-if')).toContain(
      "Unrecognized function: 'bogus'"
    );
  });

  it('applies context availability: a job if: has no matrix, steps or env', () => {
    for (const expr of ["matrix.os == 'x'", 'steps.a.outcome', 'env.X']) {
      expect(validateExpression(expr, 'job-if')).toContain(
        'Unrecognized named-value'
      );
      expect(validateExpression(expr, 'step-if')).toBeUndefined();
    }
    expect(validateExpression("hashFiles('x')", 'job-if')).toContain(
      "Unrecognized function: 'hashFiles'"
    );
  });

  it('rejects secrets in composite action steps', () => {
    expect(validateExpression('secrets.X', 'composite-step-if')).toContain(
      "Unrecognized named-value: 'secrets'"
    );
  });

  it('reports syntax errors', () => {
    expect(validateExpression('github.ref ==', 'step-if')).toBeTruthy();
    expect(validateExpression('(github.ref', 'step-if')).toBeTruthy();
    expect(validateExpression("contains('a'", 'step-if')).toBeTruthy();
  });

  it('does not evaluate anything while validating', () => {
    expect(
      validateExpression("fromJSON('not json')", 'step-if')
    ).toBeUndefined();
  });
});

describe('expressionDataFlow', () => {
  const values = (expr: string) => expressionDataFlow(expr)?.values;

  it('returns the context path a plain reference substitutes', () => {
    expect(expressionDataFlow('github.event.issue.title')).toEqual({
      values: [['github', 'event', 'issue', 'title']],
      trees: []
    });
  });

  it('lower-cases paths and follows [] and .* access', () => {
    expect(values("GitHub.Event['Pull_Request'].TITLE")).toEqual([
      ['github', 'event', 'pull_request', 'title']
    ]);
    expect(values('github.event.commits[0].message')).toEqual([
      ['github', 'event', 'commits', '0', 'message']
    ]);
    expect(values('github.event.commits.*.message')).toEqual([
      ['github', 'event', 'commits', '*', 'message']
    ]);
    expect(values('github.event.commits[*].message')).toEqual([
      ['github', 'event', 'commits', '*', 'message']
    ]);
  });

  it('treats a computed key as any key', () => {
    expect(values('github.event.issue[matrix.field]')).toEqual([
      ['github', 'event', 'issue', '*']
    ]);
  });

  it('has no data flow for literals, comparisons and negation', () => {
    for (const expr of [
      "'text'",
      '42',
      'true',
      'null',
      "github.event.issue.title == 'x'",
      'github.event.issue.title != github.head_ref',
      'github.event.issue.title < 3',
      '!github.event.issue.title'
    ]) {
      expect(expressionDataFlow(expr)).toEqual({ values: [], trees: [] });
    }
  });

  it('has no data flow out of boolean and status functions or hashFiles', () => {
    for (const expr of [
      "contains(github.event.issue.title, 'x')",
      "startsWith(github.head_ref, 'x')",
      "endsWith(github.head_ref, 'x')",
      'success()',
      'failure()',
      'always()',
      'cancelled()',
      "hashFiles('**/package-lock.json')"
    ]) {
      expect(expressionDataFlow(expr)).toEqual({ values: [], trees: [] });
    }
  });

  it('flows both operands of || and &&, which return an operand', () => {
    expect(values("github.event.issue.title || 'none'")).toEqual([
      ['github', 'event', 'issue', 'title']
    ]);
    expect(values('github.head_ref && github.sha')).toEqual([
      ['github', 'head_ref'],
      ['github', 'sha']
    ]);
  });

  it('follows member access through parenthesized || results', () => {
    expect(
      values('(github.event.pull_request || github.event.issue).title')
    ).toEqual([
      ['github', 'event', 'pull_request', 'title'],
      ['github', 'event', 'issue', 'title']
    ]);
  });

  it('flows the arguments of format() and join()', () => {
    expect(values("format('{0}-{1}', github.head_ref, github.sha)")).toEqual([
      ['github', 'head_ref'],
      ['github', 'sha']
    ]);
    expect(values("join(github.event.commits.*.message, ', ')")).toEqual([
      ['github', 'event', 'commits', '*', 'message']
    ]);
  });

  it('records toJSON() arguments as whole trees', () => {
    expect(expressionDataFlow('toJSON(github.event)')).toEqual({
      values: [],
      trees: [['github', 'event']]
    });
  });

  it('keeps trees through fromJSON() and member access', () => {
    expect(
      expressionDataFlow('fromJSON(toJSON(github.event)).issue.title')
    ).toEqual({ values: [], trees: [['github', 'event']] });
  });

  it('flows the arguments of functions it does not know', () => {
    expect(values('someFutureFunction(github.head_ref)')).toEqual([
      ['github', 'head_ref']
    ]);
  });

  it('ignores member access on literals', () => {
    expect(values("'abc'.length")).toEqual([]);
  });

  it('accepts a ${{ }} wrapper', () => {
    expect(values('${{ github.head_ref }}')).toEqual([['github', 'head_ref']]);
  });

  it('returns undefined for a syntax error', () => {
    expect(expressionDataFlow('github.head_ref ==')).toBeUndefined();
    expect(expressionDataFlow("'unterminated")).toBeUndefined();
  });
});

describe('star filter vs a literal key', () => {
  it("treats ['*'] as a property name, not the * filter", () => {
    const ctx = createContext({}, {}, {}, { event: { '*': 'star', a: 'x' } });
    expect(resolveExpressionValue("github.event['*']", ctx)).toBe('star');
    expect(resolveExpressionValue('github.event.*', ctx)).toEqual([
      'star',
      'x'
    ]);
  });
});
