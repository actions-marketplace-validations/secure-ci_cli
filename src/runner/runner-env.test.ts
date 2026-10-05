import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parseKeyValueFile,
  createStepFiles,
  readStepFiles,
  cleanupStepFiles,
  processWorkflowCommands,
  buildRunnerEnv,
  prependPath
} from './runner-env';

describe('runner-env', () => {
  const tempDirs: string[] = [];

  function tempFile(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-runner-env-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, content);
    return file;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('parseKeyValueFile', () => {
    it('parses name=value and heredoc entries', () => {
      const file = tempFile(
        ['a=1', 'b=x=y', 'multi<<EOF', 'line1', 'line2', 'EOF', ''].join('\n')
      );
      expect(parseKeyValueFile(file)).toEqual({
        a: '1',
        b: 'x=y',
        multi: 'line1\nline2'
      });
    });

    it('returns {} for a missing file', () => {
      expect(parseKeyValueFile('/nonexistent/ghact/file')).toEqual({});
    });
  });

  describe('step files', () => {
    it('creates empty files and reads back outputs, env, path and state', () => {
      const files = createStepFiles();
      tempDirs.push(files.dir);

      for (const f of [
        files.output,
        files.env,
        files.path,
        files.state,
        files.summary
      ]) {
        expect(fs.readFileSync(f, 'utf-8')).toBe('');
      }

      fs.writeFileSync(files.output, 'out=1\n');
      fs.writeFileSync(files.env, 'FOO=bar\n');
      fs.writeFileSync(files.path, '/opt/a\n\n/opt/b\n');
      fs.writeFileSync(files.state, 'pid=42\n');

      expect(readStepFiles(files)).toEqual({
        outputs: { out: '1' },
        env: { FOO: 'bar' },
        path: ['/opt/a', '/opt/b'],
        state: { pid: '42' }
      });

      cleanupStepFiles(files);
      expect(fs.existsSync(files.dir)).toBe(false);
    });

    it('can create files inside a given directory', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghact-exchange-'));
      tempDirs.push(dir);
      const files = createStepFiles(dir);
      expect(path.dirname(files.output)).toBe(dir);
      expect(fs.existsSync(files.env)).toBe(true);
    });
  });

  describe('processWorkflowCommands', () => {
    it('strips commands from the text and collects their effects', () => {
      const result = processWorkflowCommands(
        [
          'hello',
          '::add-mask::s3cret',
          '::set-output name=legacy::value with spaces',
          '::save-state name=token::abc',
          '::warning file=a.js,line=1::careful',
          '::error::boom',
          '::notice::fyi',
          '::debug::details',
          '::group::Install',
          'inside group',
          '::endgroup::',
          'world'
        ].join('\n')
      );

      expect(result.text).toBe(['hello', 'inside group', 'world'].join('\n'));
      expect(result.masks).toEqual(['s3cret']);
      expect(result.outputs).toEqual({ legacy: 'value with spaces' });
      expect(result.state).toEqual({ token: 'abc' });
      expect(result.annotations).toEqual([
        { level: 'warning', message: 'careful' },
        { level: 'error', message: 'boom' },
        { level: 'notice', message: 'fyi' },
        { level: 'debug', message: 'details' },
        { level: 'group', message: 'Install' }
      ]);
    });

    it('unescapes %25, %0D and %0A in command values', () => {
      const result = processWorkflowCommands(
        '::set-output name=x::a%0Ab%25c%0D'
      );
      expect(result.outputs).toEqual({ x: 'a\nb%c\r' });
    });

    it('leaves lines that merely look similar untouched', () => {
      const result = processWorkflowCommands('not ::a-command:: here');
      expect(result.text).toBe('not ::a-command:: here');
    });
  });

  describe('buildRunnerEnv', () => {
    it('maps the github context onto GITHUB_* and RUNNER_* variables', () => {
      const env = buildRunnerEnv(
        {
          workflow: 'CI',
          job: 'build',
          sha: 'abc',
          ref: 'refs/heads/main',
          ref_name: 'main',
          event_name: 'push',
          actor: 'me',
          repository: 'me/repo',
          repository_owner: 'me',
          run_id: '1',
          run_number: '2',
          run_attempt: '3',
          workspace: '/work',
          server_url: 'https://github.com',
          api_url: 'https://api.github.com'
        },
        {
          workspace: '/work',
          eventPath: '/tmp/event.json',
          tempDir: '/tmp/runner',
          toolCache: '/tools'
        }
      );

      expect(env).toMatchObject({
        CI: 'true',
        GITHUB_ACTIONS: 'true',
        GITHUB_WORKFLOW: 'CI',
        GITHUB_JOB: 'build',
        GITHUB_SHA: 'abc',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_REF_NAME: 'main',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_ACTOR: 'me',
        GITHUB_REPOSITORY: 'me/repo',
        GITHUB_REPOSITORY_OWNER: 'me',
        GITHUB_RUN_ID: '1',
        GITHUB_RUN_NUMBER: '2',
        GITHUB_RUN_ATTEMPT: '3',
        GITHUB_WORKSPACE: '/work',
        GITHUB_EVENT_PATH: '/tmp/event.json',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_API_URL: 'https://api.github.com',
        RUNNER_TEMP: '/tmp/runner',
        RUNNER_TOOL_CACHE: '/tools'
      });
      expect(env.RUNNER_OS).toMatch(/^(Linux|macOS|Windows)$/);
    });
  });

  describe('prependPath', () => {
    it('puts additions before the existing PATH', () => {
      expect(prependPath(['/b', '/a'], '/usr/bin')).toBe(
        ['/b', '/a', '/usr/bin'].join(path.delimiter)
      );
    });

    it('returns the base PATH when there are no additions', () => {
      expect(prependPath([], '/usr/bin')).toBe('/usr/bin');
    });
  });
});
