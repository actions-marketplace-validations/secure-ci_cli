import { logger, LogLevel } from './logger';

describe('Logger secret masking', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logger.setLevel(LogLevel.DEBUG);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
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

