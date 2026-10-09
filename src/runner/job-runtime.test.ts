import { describe, it, expect } from 'vitest';
import { stepDisplayName } from './job-runtime';
import { createContext } from './expression';

describe('stepDisplayName', () => {
  const ctx = {
    ...createContext({}, {}, {}, {}, { os: 'linux' })
  };

  it('substitutes expressions in a step name', () => {
    expect(stepDisplayName({ name: 'Build ${{ matrix.os }}' }, ctx)).toBe(
      'Build linux'
    );
  });

  it('returns the name verbatim without a context', () => {
    expect(stepDisplayName({ name: 'Plain name' })).toBe('Plain name');
  });

  it('falls back to the uses reference', () => {
    expect(stepDisplayName({ uses: 'actions/checkout@v4' })).toBe(
      'actions/checkout@v4'
    );
  });

  it('falls back to the first non-empty line of run', () => {
    expect(stepDisplayName({ run: '\n  npm ci\n  npm test\n' })).toBe('npm ci');
    expect(stepDisplayName({ run: 'echo ${{ matrix.os }}' }, ctx)).toBe(
      'echo linux'
    );
  });

  it('is "step" for an empty step', () => {
    expect(stepDisplayName({})).toBe('step');
  });
});
