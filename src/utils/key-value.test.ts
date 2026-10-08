import { describe, it, expect } from 'vitest';
import { parseKeyValuePairs } from './key-value';

describe('parseKeyValuePairs', () => {
  it('returns an empty object when no pairs are given', () => {
    expect(parseKeyValuePairs(undefined, '--input')).toEqual({});
  });

  it('parses simple key=value pairs', () => {
    expect(parseKeyValuePairs(['a=1', 'b=two'], '--input')).toEqual({
      a: '1',
      b: 'two'
    });
  });

  it('accepts a single string instead of an array', () => {
    expect(parseKeyValuePairs('a=1', '--input')).toEqual({ a: '1' });
  });

  it('splits on the first "=" only, preserving "=" in values', () => {
    expect(
      parseKeyValuePairs(['TOKEN=abc==', 'query=a=b=c'], '--secret')
    ).toEqual({
      TOKEN: 'abc==',
      query: 'a=b=c'
    });
  });

  it('allows an empty value', () => {
    expect(parseKeyValuePairs(['flag='], '--input')).toEqual({ flag: '' });
  });

  it('lets later pairs override earlier ones for the same key', () => {
    expect(parseKeyValuePairs(['a=1', 'a=2'], '--input')).toEqual({ a: '2' });
  });

  it('throws when "=" is missing, naming the flag', () => {
    expect(() => parseKeyValuePairs(['novalue'], '--input')).toThrow(
      /--input.*"novalue".*key=value/
    );
  });

  it('throws when the key is empty', () => {
    expect(() => parseKeyValuePairs(['=value'], '--secret')).toThrow(
      /--secret.*key=value/
    );
  });

  it('does not echo a malformed argument in the error when redacted', () => {
    for (const arg of ['=hunter2', 'hunter2']) {
      expect(() =>
        parseKeyValuePairs([arg], '--secret', { redact: true })
      ).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('hunter2')
        })
      );
    }
  });

  describe('fromEnv', () => {
    it('reads a bare NAME from the given environment', () => {
      expect(
        parseKeyValuePairs(['TOKEN', 'B=2'], '--secret', {
          fromEnv: { TOKEN: 'from-env' }
        })
      ).toEqual({ TOKEN: 'from-env', B: '2' });
    });

    it('errors when the variable is not set, without showing values', () => {
      expect(() =>
        parseKeyValuePairs(['MISSING'], '--secret', { fromEnv: {} })
      ).toThrow('--secret MISSING: environment variable MISSING is not set');
    });

    it('still rejects a bare NAME when fromEnv is not enabled', () => {
      expect(() => parseKeyValuePairs(['TOKEN'], '--input')).toThrow(
        'expected key=value'
      );
    });
  });
});
