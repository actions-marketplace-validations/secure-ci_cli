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

    it('auto mode falls back to containerd (nerdctl) if docker and podman are unavailable', async () => {
      execMock.mockImplementation((cmd: string, _opts, cb) => {
        if (cmd.startsWith('nerdctl')) {
          cb(null, '', '');
        } else {
          cb(new Error('not found'));
        }
      });

      const runtime = await resolveContainerRuntime('auto');

      expect(runtime?.name).toBe('containerd');
    });

    it('returns containerd (backed by nerdctl) when explicitly requested and available', async () => {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));

      const runtime = await resolveContainerRuntime('containerd');

      expect(runtime).not.toBeNull();
      expect(runtime?.name).toBe('containerd');
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('nerdctl version'),
        expect.any(Object),
        expect.any(Function)
      );
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
          '/host/work:/ghact-workspace',
          '-v',
          '/host/exchange:/ghact-exchange',
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

    it('passes discrete argv entries and an entrypoint override when provided', async () => {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);

      const runtime = await resolveContainerRuntime('docker');
      const resultPromise = runtime?.execute({
        image: 'my-action:latest',
        args: ['--flag', 'value'],
        entrypoint: '/entrypoint.sh',
        workingDir: '/host/work',
        exchangeDir: '/host/exchange'
      });

      child.emit('close', 0);
      await resultPromise;

      expect(spawnMock).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          '--entrypoint',
          '/entrypoint.sh',
          'my-action:latest',
          '--flag',
          'value'
        ])
      );
    });

    it('spawns the "nerdctl" binary for the containerd runtime', async () => {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);

      const runtime = await resolveContainerRuntime('containerd');
      const resultPromise = runtime?.execute({
        image: 'ubuntu:22.04',
        command: 'echo hi',
        workingDir: '/host/work',
        exchangeDir: '/host/exchange'
      });

      child.emit('close', 0);
      await resultPromise;

      expect(spawnMock).toHaveBeenCalledWith(
        'nerdctl',
        expect.arrayContaining(['run', '--rm', 'ubuntu:22.04'])
      );
    });
  });

  describe('build', () => {
    it('invokes "<bin> build -t <tag> <contextDir>" and resolves success', async () => {
      execMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          err: unknown,
          stdout?: string,
          stderr?: string
        ) => void;
        cb(null, 'built\n', '');
      });

      const runtime = await resolveContainerRuntime('docker');
      const result = await runtime?.build(
        '/host/action-dir',
        'ghact-action-abc123'
      );

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('docker build -t'),
        expect.any(Function)
      );
      expect(result?.success).toBe(true);
    });

    it('resolves with success: false and an error message on build failure', async () => {
      execMock.mockImplementation((...args: unknown[]) => {
        const cmd = args[0] as string;
        const cb = args[args.length - 1] as (err: unknown) => void;
        if (cmd.includes('version')) {
          cb(null);
        } else {
          cb(
            Object.assign(new Error('build failed'), {
              stdout: '',
              stderr: 'no such file'
            })
          );
        }
      });

      const runtime = await resolveContainerRuntime('docker');
      const result = await runtime?.build(
        '/host/action-dir',
        'ghact-action-abc123'
      );

      expect(result?.success).toBe(false);
      expect(result?.error).toBe('build failed');
    });

    it('includes a -f flag when a non-default Dockerfile name is given', async () => {
      execMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (
          err: unknown,
          stdout?: string,
          stderr?: string
        ) => void;
        cb(null, '', '');
      });

      const runtime = await resolveContainerRuntime('docker');
      await runtime?.build('/host/action-dir', 'tag', 'Dockerfile.alpine');

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining("-f 'Dockerfile.alpine'"),
        expect.any(Function)
      );
    });
  });
});
