import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

const execMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args)
}));

import {
  resolveContainerRuntime,
  _resetRuntimeCacheForTests
} from './container-runtime';

function fakeChildProcess() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: Mock;
  };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = vi.fn();
  return emitter;
}

describe('container-runtime', () => {
  beforeEach(() => {
    execMock.mockReset();
    spawnMock.mockReset();
    _resetRuntimeCacheForTests();
  });

  describe('resolveContainerRuntime', () => {
    it('returns null for preference "none"', async () => {
      const runtime = await resolveContainerRuntime('none');
      expect(runtime).toBeNull();
      expect(execMock).not.toHaveBeenCalled();
    });

    it('returns docker when explicitly requested and available', async () => {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));

      const runtime = await resolveContainerRuntime('docker');

      expect(runtime).not.toBeNull();
      expect(runtime?.name).toBe('docker');
    });

    it('returns null when explicitly requested runtime is unavailable', async () => {
      execMock.mockImplementation((_cmd, _opts, cb) =>
        cb(new Error('command not found'))
      );

      const runtime = await resolveContainerRuntime('podman');

      expect(runtime).toBeNull();
    });

    it('auto mode falls back to podman if docker is unavailable', async () => {
      execMock.mockImplementation((cmd: string, _opts, cb) => {
        if (cmd.startsWith('docker')) {
          cb(new Error('not found'));
        } else {
          cb(null, '', '');
        }
      });

      const runtime = await resolveContainerRuntime('auto');

      expect(runtime?.name).toBe('podman');
    });

    it('auto mode returns null if neither engine is available', async () => {
      execMock.mockImplementation((_cmd, _opts, cb) =>
        cb(new Error('not found'))
      );

      const runtime = await resolveContainerRuntime('auto');

      expect(runtime).toBeNull();
    });
  });

  describe('execute', () => {
    it('runs the configured binary with expected args and resolves on success', async () => {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);

      const runtime = await resolveContainerRuntime('docker');
      const resultPromise = runtime?.execute({
        image: 'ubuntu:22.04',
        command: 'echo hi',
        workingDir: '/host/work',
        exchangeDir: '/host/exchange',
        env: { FOO: 'bar' }
      });

      child.stdout.emit('data', Buffer.from('hi\n'));
      child.emit('close', 0);

      const result = await resultPromise;

      expect(spawnMock).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          'run',
          '--rm',
          '-v',
          '/host/work:/actly-workspace',
          '-v',
          '/host/exchange:/actly-exchange',
          '--network',
          'none',
          '-e',
          'FOO=bar',
          'ubuntu:22.04',
          'sh',
          '-c',
          'echo hi'
        ])
      );
      expect(result).toMatchObject({ success: true, exitCode: 0 });
      expect(result?.stdout).toBe('hi\n');
    });

    it('marks the result as timed out and kills the process', async () => {
      vi.useFakeTimers();
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);

      const runtime = await resolveContainerRuntime('docker');
      const resultPromise = runtime?.execute({
        image: 'ubuntu:22.04',
        command: 'sleep 100',
        workingDir: '/host/work',
        exchangeDir: '/host/exchange',
        timeoutMs: 50
      });

      vi.advanceTimersByTime(50);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      child.emit('close', null);

      const result = await resultPromise;
      expect(result?.timedOut).toBe(true);
      expect(result?.success).toBe(false);

      vi.useRealTimers();
    });
  });
});

