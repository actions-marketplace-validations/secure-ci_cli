import { describe, it, expect } from 'vitest';
import { resolveShell, shellCommandLine } from './shell';

describe('resolveShell', () => {
  it('defaults to bash with -eo pipefail when bash is available', () => {
    expect(resolveShell(undefined, { bashAvailable: true })).toEqual({
      template: 'bash --noprofile --norc -eo pipefail {0}',
      extension: '.sh'
    });
  });

  it('falls back to sh -e when bash is not available', () => {
    expect(resolveShell(undefined, { bashAvailable: false })).toEqual({
      template: 'sh -e {0}',
      extension: '.sh'
    });
  });

  it('maps the built-in shell keywords like GitHub does', () => {
    const opts = { bashAvailable: true };
    expect(resolveShell('bash', opts).template).toBe(
      'bash --noprofile --norc -eo pipefail {0}'
    );
    expect(resolveShell('sh', opts).template).toBe('sh -e {0}');
    expect(resolveShell('python', opts)).toEqual({
      template: 'python {0}',
      extension: '.py'
    });
    expect(resolveShell('pwsh', opts)).toEqual({
      template: `pwsh -command ". '{0}'"`,
      extension: '.ps1'
    });
  });

  it('uses custom templates containing {0} as-is', () => {
    expect(resolveShell('perl -w {0}', { bashAvailable: true }).template).toBe(
      'perl -w {0}'
    );
  });

  it('treats any other value as a program run with the script path', () => {
    expect(resolveShell('python3', { bashAvailable: true }).template).toBe(
      'python3 {0}'
    );
  });
});

describe('shellCommandLine', () => {
  it('substitutes a single-quoted script path for {0}', () => {
    expect(shellCommandLine('sh -e {0}', '/tmp/a b/script.sh')).toBe(
      "sh -e '/tmp/a b/script.sh'"
    );
  });

  it('escapes single quotes in the path', () => {
    expect(shellCommandLine('sh -e {0}', "/tmp/it's/s.sh")).toBe(
      "sh -e '/tmp/it'\\''s/s.sh'"
    );
  });

  it('inserts the raw path where the template already quotes {0}', () => {
    expect(shellCommandLine(`pwsh -command ". '{0}'"`, '/tmp/s.ps1')).toBe(
      `pwsh -command ". '/tmp/s.ps1'"`
    );
  });
});
