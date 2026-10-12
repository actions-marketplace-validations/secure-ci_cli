import { describe, it, expect } from 'vitest';
import { createColors } from './ansi';

describe('createColors', () => {
  it('leaves text plain when stdout is not a terminal', () => {
    const c = createColors({}, false);
    expect(c.red('boom')).toBe('boom');
    expect(c.green('ok')).toBe('ok');
  });

  it('wraps text in ANSI codes on a terminal', () => {
    const c = createColors({}, true);
    expect(c.red('boom')).toBe('\u001b[31mboom\u001b[39m');
    expect(c.cyan('hi')).toBe('\u001b[36mhi\u001b[39m');
    expect(c.gray('x')).toBe('\u001b[90mx\u001b[39m');
  });

  it('honours NO_COLOR even on a terminal', () => {
    const c = createColors({ NO_COLOR: '1' }, true);
    expect(c.blue('plain')).toBe('plain');
  });

  it('honours FORCE_COLOR when not on a terminal', () => {
    const c = createColors({ FORCE_COLOR: '1' }, false);
    expect(c.yellow('warn')).toBe('\u001b[33mwarn\u001b[39m');
  });

  it('treats TERM=dumb as no colour', () => {
    const c = createColors({ TERM: 'dumb' }, true);
    expect(c.green('ok')).toBe('ok');
  });
});
