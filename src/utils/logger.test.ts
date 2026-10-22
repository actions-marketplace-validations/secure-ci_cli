import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger, LogLevel } from './logger';

describe('Logger secret masking', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logger.setLevel(LogLevel.DEBUG);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logger.clearSecrets();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('masks a registered secret value in info messages', () => {
    logger.registerSecrets({ TOKEN: 'super-secret-value' });

    logger.info('Using token super-secret-value for auth');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('super-secret-value');
    expect(output).toContain('***');
  });

  it('masks a registered secret value in error messages', () => {
    logger.registerSecrets({ API_KEY: 'abcdef123456' });

    logger.error('Request failed with key abcdef123456');

    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).not.toContain('abcdef123456');
  });

  it('masks secrets passed as extra arguments', () => {
    logger.registerSecrets({ TOKEN: 'my-top-secret' });

    logger.info('Output:', 'contains my-top-secret inline');

    const arg = logSpy.mock.calls[0][1] as string;
    expect(arg).not.toContain('my-top-secret');
  });

  it('does not mask short values (avoids over-masking incidental characters)', () => {
    logger.registerSecrets({ FLAG: 'ab' });

    logger.info('value is ab here');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('ab');
  });

  it('stops masking after clearSecrets() is called', () => {
    logger.registerSecrets({ TOKEN: 'clear-me-please' });
    logger.clearSecrets();

    logger.info('token is clear-me-please');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('clear-me-please');
  });

  it('ignores undefined secrets map without throwing', () => {
    expect(() => logger.registerSecrets(undefined)).not.toThrow();
  });
});

describe('Logger job prefixes', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const lines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c) => String(c[0]));

  beforeEach(() => {
    logger.setLevel(LogLevel.DEBUG);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logger.clearSecrets();
    logger.setLevel(LogLevel.INFO);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('prefixes every kind of message with the job label inside withJob', async () => {
    await logger.withJob('build (node: 20)', async () => {
      logger.debug('d');
      logger.info('i');
      logger.success('s');
      logger.warn('w');
      logger.error('e');
      logger.step('Executing job: build');
      logger.result('done', true);
    });
    expect(lines(logSpy)).toEqual([
      '[build (node: 20)] [DEBUG] d',
      '[build (node: 20)] [INFO] i',
      '[build (node: 20)] ✓ s',
      '\n[build (node: 20)] → Executing job: build',
      '[build (node: 20)] ✓ done'
    ]);
    expect(lines(warnSpy)).toEqual(['[build (node: 20)] [WARN] w']);
    expect(lines(errorSpy)).toEqual(['[build (node: 20)] [ERROR] e']);
  });

  it('prefixes each line of a multi-line message', async () => {
    await logger.withJob('test', async () => {
      logger.info('line 1\nline 2\n\nline 4');
    });
    expect(lines(logSpy)).toEqual([
      '[test] [INFO] line 1\n[test] line 2\n\n[test] line 4'
    ]);
  });

  it('leaves messages outside withJob unprefixed', async () => {
    logger.info('plain');
    expect(lines(logSpy)).toEqual(['[INFO] plain']);
  });

  it('keeps each concurrent job on its own label across awaits', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    await Promise.all(
      ['a', 'b'].map((label) =>
        logger.withJob(label, async () => {
          logger.info('one');
          await tick();
          logger.info('two');
        })
      )
    );
    expect(lines(logSpy).sort()).toEqual([
      '[a] [INFO] one',
      '[a] [INFO] two',
      '[b] [INFO] one',
      '[b] [INFO] two'
    ]);
  });

  it('nests labels for jobs of a called workflow', async () => {
    await logger.withJob('call', async () => {
      await logger.withJob('build', async () => logger.info('x'));
      logger.info('y');
    });
    expect(lines(logSpy)).toEqual([
      '[call / build] [INFO] x',
      '[call] [INFO] y'
    ]);
  });

  it('can replace the innermost label (a matrix combination of its job)', async () => {
    await logger.withJob('call', async () => {
      await logger.withJob('build', async () => {
        logger.info('job');
        await logger.withJob(
          'build (node: 20)',
          async () => logger.info('unit'),
          true
        );
      });
    });
    await logger.withJob('top', async () => logger.info('t'), true);
    expect(lines(logSpy)).toEqual([
      '[call / build] [INFO] job',
      '[call / build (node: 20)] [INFO] unit',
      '[top] [INFO] t'
    ]);
  });

  it('masks secrets in the label too', async () => {
    logger.registerSecrets({ T: 'hunter2-secret' });
    await logger.withJob('job (token: hunter2-secret)', async () =>
      logger.info('hi')
    );
    expect(lines(logSpy)).toEqual(['[job (token: ***)] [INFO] hi']);
  });

  it('returns the value of the wrapped function', async () => {
    await expect(logger.withJob('j', async () => 42)).resolves.toBe(42);
  });
});
