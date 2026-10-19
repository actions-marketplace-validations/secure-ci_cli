import { describe, it, expect, afterEach, vi } from 'vitest';
import { Progress } from './progress';
import { logger } from './logger';

function sink(isTTY: boolean) {
  const out = {
    isTTY,
    text: '',
    write: (s: string) => ((out.text += s), true)
  };
  return out;
}

describe('Progress', () => {
  afterEach(() => logger.setBeforeWrite(undefined));

  it('prints one line per item when not a terminal (CI)', () => {
    const out = sink(false);
    const p = new Progress('Resolving tags', 2, out);
    p.tick('actions/checkout@v4');
    p.tick('org/scan@v1');
    p.done('Resolved 2 tags');
    expect(out.text).toBe(
      'Resolving tags [1/2] actions/checkout@v4\n' +
        'Resolving tags [2/2] org/scan@v1\n' +
        'Resolved 2 tags\n'
    );
  });

  it('updates one line in place on a terminal, then leaves the summary', () => {
    const out = sink(true);
    const p = new Progress('Reading actions', 1, out);
    p.tick('a@v1');
    p.grow();
    p.tick('b@v2');
    p.done('Read 2 actions');
    expect(out.text).toBe(
      '\r\x1b[KReading actions [1/1] a@v1' +
        '\r\x1b[KReading actions [2/2] b@v2' +
        '\r\x1b[KRead 2 actions\n'
    );
  });

  it('clears its line before a log message on a terminal', () => {
    const out = sink(true);
    const p = new Progress('Resolving tags', 2, out);
    p.tick('a@v1');
    // Any logger output first clears the progress line.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('something');
    warn.mockRestore();
    expect(out.text.endsWith('\r\x1b[K')).toBe(true);
    p.done();
    expect(out.text.endsWith('\r\x1b[K')).toBe(true);
  });

  it('prints nothing for an empty phase', () => {
    const out = sink(true);
    const p = new Progress('Resolving tags', 0, out);
    p.done('Resolved 0 tags');
    expect(out.text).toBe('');
  });
});
