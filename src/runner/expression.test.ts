import {
  createContext,
  evaluateCondition,
  substituteExpressions
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

  it('fails open (returns true) on invalid expressions', () => {
    const ctx = createContext();
    expect(evaluateCondition('inputs.a ===', ctx)).toBe(true);
    expect(evaluateCondition('unknownFunc()', ctx)).toBe(true);
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
