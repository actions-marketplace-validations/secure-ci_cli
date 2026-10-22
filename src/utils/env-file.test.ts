import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadKeyValues, parseEnvFile, readEnvFiles } from './env-file';
import { logger } from './logger';

describe('parseEnvFile', () => {
  const parse = (content: string): Record<string, string> =>
    parseEnvFile(content, '.env');

  it('parses KEY=value lines', () => {
    expect(parse('A=1\nB=two\n')).toEqual({ A: '1', B: 'two' });
  });

  it('skips blank lines and full-line comments', () => {
    expect(parse('\n# a comment\n   # indented comment\n\nA=1\n  \n')).toEqual({
      A: '1'
    });
  });

  it('accepts an optional export prefix', () => {
    expect(parse('export A=1\nexport  B="two"')).toEqual({
      A: '1',
      B: 'two'
    });
  });

  it('treats a key named export as a key', () => {
    expect(parse('export=1')).toEqual({ export: '1' });
  });

  it('allows empty values, bare or quoted', () => {
    expect(parse('A=\nB=""\nC=\'\'\nD= # just a comment')).toEqual({
      A: '',
      B: '',
      C: '',
      D: ''
    });
  });

  it('splits on the first "=" only', () => {
    expect(parse('TOKEN=abc==\nURL=a=b=c')).toEqual({
      TOKEN: 'abc==',
      URL: 'a=b=c'
    });
  });

  it('trims whitespace around keys and unquoted values', () => {
    expect(parse('  A = spaced value  \n')).toEqual({ A: 'spaced value' });
  });

  it('strips an inline comment after whitespace in an unquoted value', () => {
    expect(parse('A=value # comment\nB=value\t# tab comment')).toEqual({
      A: 'value',
      B: 'value'
    });
  });

  it('keeps a # not preceded by whitespace in an unquoted value', () => {
    expect(parse('A=abc#def\nB=#hash')).toEqual({ A: 'abc#def', B: '#hash' });
  });

  it('keeps single-quoted values literally', () => {
    expect(parse('A=\'  a # b \\n "c" $D \'')).toEqual({
      A: '  a # b \\n "c" $D '
    });
  });

  it('keeps # and leading/trailing spaces inside double quotes', () => {
    expect(parse('A="  a # b  " # comment')).toEqual({ A: '  a # b  ' });
  });

  it('expands \\n, \\", \\\\ (and \\r, \\t) escapes in double quotes', () => {
    expect(
      parse('A="line1\\nline2"\nB="say \\"hi\\""\nC="back\\\\slash"')
    ).toEqual({ A: 'line1\nline2', B: 'say "hi"', C: 'back\\slash' });
    expect(parse('D="a\\tb\\rc"')).toEqual({ D: 'a\tb\rc' });
  });

  it('keeps unknown escapes in double quotes as written', () => {
    expect(parse('A="\\$HOME \\x"')).toEqual({ A: '\\$HOME \\x' });
  });

  it('reads multi-line values in double quotes', () => {
    expect(
      parse('KEY="-----BEGIN KEY-----\nabc\n-----END KEY-----"\nNEXT=1')
    ).toEqual({
      KEY: '-----BEGIN KEY-----\nabc\n-----END KEY-----',
      NEXT: '1'
    });
  });

  it('handles CRLF line endings, including inside multi-line values', () => {
    expect(parse('A=1\r\nB="x\r\ny"\r\n# c\r\nC=3 # c\r\n')).toEqual({
      A: '1',
      B: 'x\ny',
      C: '3'
    });
  });

  it('ignores a UTF-8 byte order mark', () => {
    expect(parse('\uFEFFA=1')).toEqual({ A: '1' });
  });

  it('lets a later duplicate key win', () => {
    expect(parse('A=1\nA=2')).toEqual({ A: '2' });
  });

  it('accepts hyphens in keys (input names may contain them)', () => {
    expect(parse('my-input=1')).toEqual({ 'my-input': '1' });
  });

  describe('invalid lines', () => {
    it('rejects a line without "=", naming file and line', () => {
      expect(() => parse('A=1\n\nghp_supersecret')).toThrow(
        '.env:3: expected KEY=value'
      );
    });

    it('rejects an invalid key', () => {
      expect(() => parse('1A=x')).toThrow('.env:1: invalid variable name');
      expect(() => parse('=x')).toThrow('.env:1: invalid variable name');
      expect(() => parse('A B=x')).toThrow('.env:1: invalid variable name');
    });

    it('rejects an unterminated double-quoted value at its opening line', () => {
      expect(() => parse('A=1\nB="never closed\nC=3')).toThrow(
        '.env:2: unterminated double-quoted value'
      );
    });

    it('rejects an unterminated single-quoted value', () => {
      expect(() => parse("A='open\nB='")).toThrow(
        '.env:1: unterminated single-quoted value'
      );
    });

    it('rejects text after a closing quote', () => {
      expect(() => parse('A="x"y')).toThrow(
        '.env:1: unexpected text after closing quote'
      );
      expect(() => parse("A='x' y")).toThrow(
        '.env:1: unexpected text after closing quote'
      );
    });

    it('reports the right line after a multi-line value', () => {
      expect(() => parse('A="x\ny\nz"\nbad')).toThrow('.env:4:');
    });

    it('never echoes line contents in errors', () => {
      for (const content of [
        'supersecretvalue',
        '1supersecretvalue=x',
        'A="supersecretvalue',
        'A="supersecretvalue"x'
      ]) {
        try {
          parse(content);
          expect.unreachable();
        } catch (error) {
          expect((error as Error).message).not.toContain('supersecret');
        }
      }
    });
  });
});

describe('readEnvFiles / loadKeyValues', () => {
  let dir: string;

  function write(name: string, content: string, mode = 0o600): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    fs.chmodSync(file, mode);
    return file;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-env-file-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('merges files in order, later files overriding earlier ones', () => {
    const a = write('a.env', 'A=1\nB=1');
    const b = write('b.env', 'B=2\nC=2');
    expect(readEnvFiles([a, b], { flagName: '--env-file' })).toEqual({
      A: '1',
      B: '2',
      C: '2'
    });
  });

  it('fails clearly on a missing file', () => {
    expect(() =>
      readEnvFiles([path.join(dir, 'nope.env')], { flagName: '--env-file' })
    ).toThrow(`--env-file: file not found: ${path.join(dir, 'nope.env')}`);
  });

  it('prefixes parse errors with the file path', () => {
    const bad = write('bad.env', 'oops');
    expect(() => readEnvFiles([bad], { flagName: '--var-file' })).toThrow(
      `${bad}:1: expected KEY=value`
    );
  });

  describe('secret file permissions', () => {
    it('warns when a secret file is group/world-readable, without values', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const file = write('loose.secrets', 'TOKEN=hunter22', 0o644);
      readEnvFiles([file], { flagName: '--secret-file', secret: true });
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0][0]);
      expect(message).toContain(file);
      expect(message).toContain('chmod 600');
      expect(message).not.toContain('hunter22');
    });

    it('does not warn for a 0600 secret file', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const file = write('tight.secrets', 'TOKEN=hunter22', 0o600);
      readEnvFiles([file], { flagName: '--secret-file', secret: true });
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not check non-secret files', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const file = write('vars.env', 'A=1', 0o644);
      readEnvFiles([file], { flagName: '--var-file' });
      expect(warn).not.toHaveBeenCalled();
    });

    it('skips the check on Windows, where POSIX modes do not apply', () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const file = write('loose.secrets', 'TOKEN=x', 0o644);
      readEnvFiles([file], {
        flagName: '--secret-file',
        secret: true,
        platform: 'win32'
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('loadKeyValues precedence', () => {
    it('lets explicit flags override values from files', () => {
      const file = write('a.env', 'A=file\nB=file');
      expect(
        loadKeyValues({
          flagName: '--env',
          fileFlagName: '--env-file',
          pairs: ['B=flag'],
          files: [file]
        })
      ).toEqual({ A: 'file', B: 'flag' });
    });

    it('uses config default files only when no file flag is given', () => {
      const fromConfig = write('config.env', 'A=config\nC=config');
      const fromFlag = write('flag.env', 'A=flag');
      expect(
        loadKeyValues({
          flagName: '--env',
          fileFlagName: '--env-file',
          configFiles: fromConfig
        })
      ).toEqual({ A: 'config', C: 'config' });
      expect(
        loadKeyValues({
          flagName: '--env',
          fileFlagName: '--env-file',
          files: [fromFlag],
          configFiles: fromConfig
        })
      ).toEqual({ A: 'flag' });
    });

    it('accepts a list of config default files', () => {
      const a = write('a.env', 'A=1\nB=1');
      const b = write('b.env', 'B=2');
      expect(
        loadKeyValues({
          flagName: '--var',
          fileFlagName: '--var-file',
          configFiles: [a, b]
        })
      ).toEqual({ A: '1', B: '2' });
    });

    it('rejects a malformed config default', () => {
      expect(() =>
        loadKeyValues({
          flagName: '--var',
          fileFlagName: '--var-file',
          configFiles: 42 as unknown as string
        })
      ).toThrow('Invalid var-file in config');
    });

    it('passes secret options through to flags and files', () => {
      const file = write('s.secrets', 'A=file');
      expect(
        loadKeyValues({
          flagName: '--secret',
          fileFlagName: '--secret-file',
          pairs: ['FROM_SHELL'],
          files: [file],
          secret: true,
          fromEnv: { FROM_SHELL: 'shell' }
        })
      ).toEqual({ A: 'file', FROM_SHELL: 'shell' });
      expect(() =>
        loadKeyValues({
          flagName: '--secret',
          fileFlagName: '--secret-file',
          pairs: ['nope'],
          secret: true
        })
      ).toThrow('Invalid --secret argument: expected key=value');
    });

    it('returns an empty record when nothing is given', () => {
      expect(
        loadKeyValues({ flagName: '--input', fileFlagName: '--input-file' })
      ).toEqual({});
    });
  });
});
