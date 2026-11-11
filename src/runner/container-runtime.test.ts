import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

const execMock = vi.fn();
const spawnMock = vi.fn();

const execFileSyncMock = vi.fn();

vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args)
}));

import {
  resolveContainerRuntime,
  registryOf,
  _resetRuntimeCacheForTests,
  type ContainerRuntime
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

interface SpawnCapture {
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  envFilePath?: string;
  envFile?: string;
  envFileMode?: number;
}

/**
 * Return `child` from spawn and record argv, the client env and the env
 * file's contents/mode at spawn time (the file is deleted once the client
 * exits, so it must be read then).
 */
function captureSpawn(child: ReturnType<typeof fakeChildProcess>) {
  const captures: SpawnCapture[] = [];
  spawnMock.mockImplementation(
    (_bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      const capture: SpawnCapture = { args, env: opts?.env };
      const index = args.indexOf('--env-file');
      if (index !== -1) {
        capture.envFilePath = args[index + 1];
        capture.envFile = fs.readFileSync(capture.envFilePath, 'utf8');
        capture.envFileMode = fs.statSync(capture.envFilePath).mode & 0o777;
      }
      captures.push(capture);
      return child;
    }
  );
  return captures;
}

describe('container-runtime', () => {
  beforeEach(() => {
    execMock.mockReset();
    spawnMock.mockReset();
    _resetRuntimeCacheForTests();
  });

  it.each([
    ['node:20', 'docker.io'],
    ['library/node:20', 'docker.io'],
    ['me/app', 'docker.io'],
    ['ghcr.io/me/app:1', 'ghcr.io'],
    ['registry.example.com:5000/db:2', 'registry.example.com:5000'],
    ['localhost/app', 'localhost'],
    ['localhost:5000/app', 'localhost:5000']
  ])('registryOf(%s) is %s', (image, registry) => {
    expect(registryOf(image)).toBe(registry);
  });

  describe('pull with registry credentials (#90)', () => {
    interface Call {
      args: string[];
      env?: NodeJS.ProcessEnv;
      input?: string;
      configMode?: number;
    }
    /** Every spawn closes at once, with `stdout(args)` and `code(args)`. */
    function autoSpawn(
      stdout: (args: string[]) => string = () => '',
      code: (args: string[]) => number = () => 0
    ) {
      const calls: Call[] = [];
      spawnMock.mockImplementation(
        (_bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
          const child = fakeChildProcess() as ReturnType<
            typeof fakeChildProcess
          > & { stdin: { end: Mock } };
          const call: Call = { args, env: opts?.env };
          const dir =
            opts?.env?.DOCKER_CONFIG ??
            (opts?.env?.REGISTRY_AUTH_FILE
              ? path.dirname(opts.env.REGISTRY_AUTH_FILE)
              : undefined);
          if (dir) call.configMode = fs.statSync(dir).mode & 0o777;
          child.stdin = {
            end: vi.fn((input?: string) => {
              call.input = input;
            })
          };
          calls.push(call);
          setImmediate(() => {
            child.stdout.emit('data', Buffer.from(stdout(args)));
            child.emit('close', code(args));
          });
          return child;
        }
      );
      return calls;
    }
    const auth = {
      registry: 'ghcr.io',
      username: 'me',
      password: 's3cret'
    };

    async function runtimeNamed(name: 'docker' | 'podman') {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      return (await resolveContainerRuntime(name)) as ContainerRuntime;
    }

    it('docker: logs in to a private config dir (password on stdin), pulls, then removes it', async () => {
      const saved = process.env.DOCKER_HOST;
      delete process.env.DOCKER_HOST;
      try {
        const calls = autoSpawn((args) =>
          args[0] === 'context' ? 'unix:///run/user.sock\n' : ''
        );
        const runtime = await runtimeNamed('docker');
        const result = await runtime.pull('ghcr.io/me/app:1', auth);
        expect(result).toEqual({ success: true });
        expect(calls.map((c) => c.args)).toEqual([
          ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
          ['login', '--username', 'me', '--password-stdin', 'ghcr.io'],
          ['pull', 'ghcr.io/me/app:1']
        ]);
        const [, login, pull] = calls;
        expect(login.input).toBe('s3cret');
        expect(JSON.stringify(login.args)).not.toContain('s3cret');
        expect(login.configMode).toBe(0o700);
        // Keep talking to the same engine though the config dir changed.
        expect(login.env?.DOCKER_HOST).toBe('unix:///run/user.sock');
        expect(pull.env?.DOCKER_CONFIG).toBe(login.env?.DOCKER_CONFIG);
        expect(fs.existsSync(login.env?.DOCKER_CONFIG as string)).toBe(false);
      } finally {
        if (saved !== undefined) process.env.DOCKER_HOST = saved;
      }
    });

    it('podman: uses a private auth file', async () => {
      const calls = autoSpawn();
      const runtime = await runtimeNamed('podman');
      expect(await runtime.pull('ghcr.io/me/app:1', auth)).toEqual({
        success: true
      });
      expect(calls.map((c) => c.args[0])).toEqual(['login', 'pull']);
      const file = calls[0].env?.REGISTRY_AUTH_FILE as string;
      expect(path.basename(file)).toBe('auth.json');
      expect(calls[1].env?.REGISTRY_AUTH_FILE).toBe(file);
      expect(fs.existsSync(path.dirname(file))).toBe(false);
    });

    it('reports a failed login without pulling, and still cleans up', async () => {
      const calls = autoSpawn(
        () => '',
        (args) => (args[0] === 'login' ? 1 : 0)
      );
      const runtime = await runtimeNamed('podman');
      const result = await runtime.pull('ghcr.io/me/app:1', auth);
      expect(result.success).toBe(false);
      expect(result.error).toContain('login to ghcr.io failed');
      expect(calls.map((c) => c.args[0])).toEqual(['login']);
      expect(
        fs.existsSync(path.dirname(calls[0].env?.REGISTRY_AUTH_FILE as string))
      ).toBe(false);
    });
  });

  describe('resolveContainerRuntime', () => {
    it('returns null for preference "host"', async () => {
      const runtime = await resolveContainerRuntime('host');
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
      const captures = captureSpawn(child);

      const runtime = await resolveContainerRuntime('docker');
      const resultPromise = runtime?.execute({
        image: 'ubuntu:22.04',
        command: 'echo hi',
        workingDir: '/host/work',
        exchangeDir: '/host/exchange',
        env: { FOO: 'bar' },
        networkDisabled: true
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
          '/host/work:/secureci-workspace',
          '-v',
          '/host/exchange:/secureci-exchange',
          '--network',
          'none',
          '--env-file',
          'ubuntu:22.04',
          'sh',
          '-c',
          'echo hi'
        ]),
        expect.anything()
      );
      expect(captures[0].envFile).toBe('FOO=bar\n');
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
        ]),
        expect.anything()
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
        expect.arrayContaining(['run', '--rm', 'ubuntu:22.04']),
        expect.anything()
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
        'secureci-action-abc123'
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
        'secureci-action-abc123'
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

  describe('job containers (start / exec / stop)', () => {
    async function dockerRuntime() {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const runtime = await resolveContainerRuntime('docker');
      if (!runtime) throw new Error('expected a runtime');
      return runtime;
    }

    it('starts a long-lived container with mounts, env and an idle entrypoint', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      const captures = captureSpawn(child);

      const started = runtime.start({
        image: 'node:20',
        workingDir: '/host/work',
        exchangeDir: '/host/exchange',
        env: { FOO: 'bar' },
        memoryLimit: '512m'
      });
      child.stdout.emit('data', Buffer.from('abc123\n'));
      child.emit('close', 0);

      expect(await started).toEqual({ success: true, id: 'abc123' });
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(spawnMock.mock.calls[0][0]).toBe('docker');
      expect(args.slice(0, 2)).toEqual(['run', '-d']);
      expect(args).toEqual(
        expect.arrayContaining([
          '-v',
          '/host/work:/secureci-workspace',
          '-v',
          '/host/exchange:/secureci-exchange',
          '--memory',
          '512m',
          '--env-file',
          '--entrypoint',
          'tail'
        ])
      );
      expect(captures[0].envFile).toBe('FOO=bar\n');
      expect(args).not.toContain('--network');
      expect(args.slice(-3)).toEqual(['node:20', '-f', '/dev/null']);
    });

    it('disables networking only when asked to', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);

      const started = runtime.start({
        image: 'ubuntu:22.04',
        workingDir: '/w',
        exchangeDir: '/x',
        networkDisabled: true
      });
      child.stdout.emit('data', Buffer.from('id\n'));
      child.emit('close', 0);
      await started;

      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args).toEqual(expect.arrayContaining(['--network', 'none']));
    });

    it('reports a failed start with stderr', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);

      const started = runtime.start({
        image: 'nope:latest',
        workingDir: '/w',
        exchangeDir: '/x'
      });
      child.stderr.emit('data', Buffer.from('pull access denied'));
      child.emit('close', 125);

      expect(await started).toEqual({
        success: false,
        error: 'pull access denied'
      });
    });

    it('execs a shell command in a running container', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      const captures = captureSpawn(child);

      const resultPromise = runtime.exec('abc123', {
        command: 'echo hi',
        env: { A: '1' },
        workingDir: '/secureci-workspace/sub'
      });
      child.stdout.emit('data', Buffer.from('hi\n'));
      child.emit('close', 0);

      expect(await resultPromise).toMatchObject({
        success: true,
        stdout: 'hi\n',
        exitCode: 0
      });
      expect(captures[0].args).toEqual([
        'exec',
        '-w',
        '/secureci-workspace/sub',
        '--env-file',
        captures[0].envFilePath,
        'abc123',
        'sh',
        '-c',
        'echo hi'
      ]);
      expect(captures[0].envFile).toBe('A=1\n');
    });

    it('execs as another user when one is given (e.g. root, for cleanup)', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      const captures = captureSpawn(child);

      const resultPromise = runtime.exec('abc123', {
        args: ['rm', '-rf', '--', '/secureci-workspace/x'],
        user: '0'
      });
      child.emit('close', 0);
      await resultPromise;

      expect(captures[0].args.slice(0, 5)).toEqual([
        'exec',
        '-w',
        '/secureci-workspace',
        '-u',
        '0'
      ]);
      expect(captures[0].args.slice(-5)).toEqual([
        'abc123',
        'rm',
        '-rf',
        '--',
        '/secureci-workspace/x'
      ]);
    });

    it('execs argv directly (no shell) when args are given', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      const captures = captureSpawn(child);

      const resultPromise = runtime.exec('abc123', {
        args: ['/usr/local/bin/node', '/x/index.js'],
        env: { 'INPUT_WHO-TO-GREET': 'me' }
      });
      child.emit('close', 0);
      await resultPromise;

      expect(captures[0].args).toEqual([
        'exec',
        '-w',
        '/secureci-workspace',
        '--env-file',
        captures[0].envFilePath,
        'abc123',
        '/usr/local/bin/node',
        '/x/index.js'
      ]);
      expect(captures[0].envFile).toBe('INPUT_WHO-TO-GREET=me\n');
    });

    it('removes the container on stop, and synchronously on stopSync', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      spawnMock.mockReturnValue(child);

      const stopped = runtime.stop('abc123');
      child.emit('close', 0);
      await stopped;
      expect(spawnMock).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'abc123'],
        expect.anything()
      );

      runtime.stopSync('def456');
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'def456'],
        expect.objectContaining({ stdio: 'ignore' })
      );
    });
  });

  describe('env values stay out of argv', () => {
    const SECRET = 's3cr3t-value';

    async function dockerRuntime() {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const runtime = await resolveContainerRuntime('docker');
      if (!runtime) throw new Error('expected a runtime');
      return runtime;
    }

    const env = {
      TOKEN: SECRET,
      WITH_EQUALS: 'a=b=c',
      EMPTY: '',
      MULTI: `line1\n${SECRET}\nline3`,
      CRLF: 'a\r\nb',
      QUOTED: '"starts with a quote',
      PADDED: '  padded  ',
      PATH: '/container/bin:/usr/bin'
    };

    const calls: Array<
      [string, (runtime: ContainerRuntime) => Promise<unknown>]
    > = [
      [
        'execute',
        (runtime) =>
          runtime.execute({
            image: 'img',
            command: 'true',
            workingDir: '/w',
            exchangeDir: '/x',
            env
          })
      ],
      [
        'start',
        (runtime) =>
          runtime.start({
            image: 'img',
            workingDir: '/w',
            exchangeDir: '/x',
            env
          })
      ],
      ['exec', (runtime) => runtime.exec('abc123', { command: 'true', env })]
    ];

    for (const [name, call] of calls) {
      it(`${name}: passes values via a private env file or the client env, never argv`, async () => {
        const runtime = await dockerRuntime();
        const child = fakeChildProcess();
        const captures = captureSpawn(child);

        const pending = call(runtime);
        child.stdout.emit('data', Buffer.from('id\n'));
        child.emit('close', 0);
        await pending;

        const {
          args,
          env: clientEnv,
          envFile,
          envFileMode,
          envFilePath
        } = captures[0];
        const argv = args.join('\n');
        expect(argv).not.toContain(SECRET);
        expect(argv).not.toContain('a=b=c');
        expect(argv).not.toContain('/container/bin');

        // Plain single-line values go in the env file, intact.
        expect(envFile).toBe(
          `TOKEN=${SECRET}\nWITH_EQUALS=a=b=c\nEMPTY=\nPATH=/container/bin:/usr/bin\n`
        );
        expect(envFileMode).toBe(0o600);
        // ...which is removed once the client has exited.
        expect(fs.existsSync(envFilePath as string)).toBe(false);

        // Values an env file can't carry verbatim are passed by name, with
        // the value in the client's environment.
        for (const key of ['MULTI', 'CRLF', 'QUOTED', 'PADDED']) {
          const index = args.indexOf(key);
          expect(index).toBeGreaterThan(0);
          expect(args[index - 1]).toBe('-e');
          expect(clientEnv?.[key]).toBe(env[key as keyof typeof env]);
        }

        // The client's own environment is otherwise untouched: a PATH meant
        // for the container must not change how the client binary runs.
        expect(clientEnv?.PATH).toBe(process.env.PATH);
      });
    }

    it('removes the env file when the client fails to spawn', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      const captures = captureSpawn(child);

      const pending = runtime.exec('abc123', {
        command: 'true',
        env: { A: '1' }
      });
      child.emit('error', new Error('spawn docker ENOENT'));
      expect(await pending).toMatchObject({ success: false });
      expect(captures[0].envFile).toBe('A=1\n');
      expect(fs.existsSync(captures[0].envFilePath as string)).toBe(false);
    });

    it('omits --env-file when there is no env', async () => {
      const runtime = await dockerRuntime();
      const child = fakeChildProcess();
      const captures = captureSpawn(child);

      const pending = runtime.exec('abc123', { command: 'true' });
      child.emit('close', 0);
      await pending;

      expect(captures[0].args).not.toContain('--env-file');
      expect(captures[0].args).not.toContain('-e');
    });
  });

  describe('service containers (#33)', () => {
    async function dockerRuntime() {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const runtime = await resolveContainerRuntime('docker');
      if (!runtime) throw new Error('expected a runtime');
      return runtime;
    }

    /** Respond to each spawn in turn with [exitCode, stdout]. */
    function respond(...replies: Array<[number, string]>) {
      const captures: string[][] = [];
      spawnMock.mockImplementation((_bin: string, args: string[]) => {
        captures.push(args);
        const child = fakeChildProcess();
        const [code, out] = replies.shift() ?? [0, ''];
        setImmediate(() => {
          if (out) child.stdout.emit('data', Buffer.from(out));
          child.emit('close', code);
        });
        return child;
      });
      return captures;
    }

    it('creates and removes networks', async () => {
      const runtime = await dockerRuntime();
      const calls = respond([0, 'netid\n'], [0, '']);
      expect(await runtime.createNetwork('secureci-net-1')).toBe(true);
      await runtime.removeNetwork('secureci-net-1');
      expect(calls).toEqual([
        ['network', 'create', 'secureci-net-1'],
        ['network', 'rm', 'secureci-net-1']
      ]);
    });

    it('starts a service with network alias, ports, volumes and options', async () => {
      const runtime = await dockerRuntime();
      const calls = respond([0, 'svc1\n']);
      const started = await runtime.start({
        image: 'postgres:16',
        service: true,
        network: 'secureci-net-1',
        networkAlias: 'db',
        ports: ['5432', '6000:6379'],
        volumes: ['/data:/var/lib/data'],
        extraArgs: ['--health-cmd', 'pg_isready', '--health-interval', '1s'],
        env: { POSTGRES_PASSWORD: 'pw' }
      });
      expect(started).toEqual({ success: true, id: 'svc1' });
      const args = calls[0];
      expect(args.slice(0, 2)).toEqual(['run', '-d']);
      expect(args).toEqual(
        expect.arrayContaining([
          '--network',
          'secureci-net-1',
          '--network-alias',
          'db',
          '-p',
          '5432',
          '-p',
          '6000:6379',
          '-v',
          '/data:/var/lib/data',
          '--health-cmd',
          'pg_isready',
          '--env-file'
        ])
      );
      expect(args.join(' ')).not.toContain('pw');
      // Services keep their image's own entrypoint and command.
      expect(args).not.toContain('--entrypoint');
      expect(args[args.length - 1]).toBe('postgres:16');
    });

    it('reads health status and published ports', async () => {
      const runtime = await dockerRuntime();
      const calls = respond(
        [0, 'healthy\n'],
        [
          0,
          '5432/tcp -> 0.0.0.0:49153\n5432/tcp -> [::]:49153\n6379/tcp -> 0.0.0.0:6000\n'
        ]
      );
      expect(await runtime.health('svc1')).toBe('healthy');
      expect(await runtime.ports('svc1')).toEqual({
        '5432': '49153',
        '6379': '6000'
      });
      expect(calls[0].slice(0, 2)).toEqual(['inspect', '--format']);
      expect(calls[1]).toEqual(['port', 'svc1']);
    });
  });

  describe('isolation guards', () => {
    async function dockerRuntime() {
      execMock.mockImplementation((_cmd, _opts, cb) => cb(null, '', ''));
      const runtime = await resolveContainerRuntime('docker');
      if (!runtime) throw new Error('expected a runtime');
      return runtime;
    }

    it('refuses an image that would be parsed as an option (execute)', async () => {
      const runtime = await dockerRuntime();
      const result = await runtime.execute({
        image: '--privileged',
        args: ['-v', '/:/host', 'alpine'],
        workingDir: '/w',
        exchangeDir: '/x'
      });
      expect(result.success).toBe(false);
      expect(result.stderr).toMatch(/Invalid image/);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('refuses an image that would be parsed as an option (start)', async () => {
      const runtime = await dockerRuntime();
      const started = await runtime.start({ image: '-v=/:/h', service: true });
      expect(started.success).toBe(false);
      expect(started.error).toMatch(/Invalid image/);
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('mounts readOnlyPaths of the working dir read-only, when they exist', async () => {
      const runtime = await dockerRuntime();
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-ro-'));
      fs.mkdirSync(path.join(work, '.git'));
      try {
        const child = fakeChildProcess();
        captureSpawn(child);
        const started = runtime.start({
          image: 'node:20',
          workingDir: work,
          readOnlyPaths: ['.git', 'missing']
        });
        child.stdout.emit('data', Buffer.from('id\n'));
        child.emit('close', 0);
        await started;
        const args = spawnMock.mock.calls[0][1] as string[];
        const mounts = args.filter((_, i) => args[i - 1] === '-v');
        expect(mounts).toEqual([
          `${work}:/secureci-workspace`,
          `${path.join(work, '.git')}:/secureci-workspace/.git:ro`
        ]);

        const child2 = fakeChildProcess();
        spawnMock.mockReset();
        captureSpawn(child2);
        const ran = runtime.execute({
          image: 'alpine',
          command: 'true',
          workingDir: work,
          exchangeDir: '/x',
          readOnlyPaths: ['.git']
        });
        child2.emit('close', 0);
        await ran;
        const args2 = spawnMock.mock.calls[0][1] as string[];
        expect(args2).toContain(
          `${path.join(work, '.git')}:/secureci-workspace/.git:ro`
        );
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  });
});
