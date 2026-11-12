import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';

// org-scan.sh is bash; these tests run it against bare git repositories
// served from file://, a fake GitHub API on localhost and a fake `secureci`
// that records its arguments, so no network or real CLI is needed.
const SCRIPT = path.resolve(__dirname, '..', 'org-scan.sh');
const TOKEN = 'ghp_testtoken1234567890';

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null))))
  );
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com'
    }
  });

/**
 * A bare repository at `<root>/<owner>/<name>.git` with the given files,
 * cloneable as `file://<root>/<owner>/<name>.git`.
 */
function bareRepo(
  root: string,
  fullName: string,
  files: Record<string, string>
): void {
  const work = tmp('org-scan-work-');
  git(work, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(work, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'init');
  const bare = path.join(root, `${fullName}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git(root, 'clone', '-q', '--bare', work, bare);
}

const WORKFLOW =
  'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n';
// Application code that must never reach the scan output.
const SECRET_SOURCE = 'const apiKey = "super-secret-source";\n';

/** A fake `secureci` that logs each call and prints canned JSON. */
function fakeSecureci(dir: string, log: string): string {
  const bin = path.join(dir, 'secureci');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
printf '%s\\n' "$PWD|$*" >> "${log}"
case "$1" in
  --version) echo 9.9.9 ;;
  inventory) echo '{"actions":[],"advisories":[],"file":"'"$3"'"}' ;;
  validate)
    echo '{"valid":false,"files":[]}'
    [ -n "$FAKE_STDERR" ] && echo "$FAKE_STDERR" >&2
    exit 1 ;;
esac
`
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

interface FakeApi {
  url: string;
  requests: Array<{ url: string; auth?: string }>;
}

/** A fake GitHub REST API serving `routes` (path + query → JSON or status). */
async function fakeApi(
  routes: Record<string, unknown | number>
): Promise<FakeApi> {
  const requests: FakeApi['requests'] = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '', auth: req.headers.authorization });
    const route = routes[req.url ?? ''];
    if (route === undefined || typeof route === 'number') {
      res.writeHead(typeof route === 'number' ? route : 404);
      res.end('{"message":"Not Found"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof route === 'string' ? route : JSON.stringify(route));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

function repo(
  fullName: string,
  extra: { fork?: boolean; archived?: boolean; description?: string } = {}
) {
  return {
    id: 1,
    name: fullName.split('/')[1],
    full_name: fullName,
    private: true,
    owner: { login: fullName.split('/')[0], type: 'Organization' },
    description: extra.description ?? null,
    fork: extra.fork ?? false,
    archived: extra.archived ?? false,
    default_branch: 'main'
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(
  args: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', ...opts.env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Every file under `dir`, relative, sorted. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

function readAll(dir: string): string {
  return listFiles(dir)
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
}

/** A git server root, a fake secureci and a working directory. */
function setup() {
  const gitRoot = tmp('org-scan-git-');
  const bin = tmp('org-scan-bin-');
  const cwd = tmp('org-scan-cwd-');
  const log = path.join(bin, 'calls.log');
  const secureci = fakeSecureci(bin, log);
  const calls = () =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { gitRoot, cwd, secureci, calls };
}

function env(
  s: ReturnType<typeof setup>,
  api: FakeApi | undefined,
  extra: Record<string, string> = {}
) {
  return {
    GITHUB_SERVER_URL: `file://${s.gitRoot}`,
    GITHUB_API_URL: api?.url ?? 'http://127.0.0.1:9',
    SECURECI: s.secureci,
    ...extra
  };
}

describe('org-scan.sh', () => {
  it('lists the org over the API, skips archived repos and forks, and scans each repo', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/api', {
      '.github/workflows/ci.yml': WORKFLOW,
      '.github/workflows/deploy.yaml': WORKFLOW,
      'src/index.js': SECRET_SOURCE
    });
    bareRepo(s.gitRoot, 'acme/web', {
      '.github/workflows/ci.yml': WORKFLOW
    });
    const api = await fakeApi({
      // Compact JSON on page 1, pretty-printed on page 2: both must parse.
      '/orgs/acme/repos?per_page=100&page=1': JSON.stringify([
        repo('acme/api', { description: 'API, with "full_name": "x/y" text' }),
        repo('acme/old', { archived: true })
      ]),
      '/orgs/acme/repos?per_page=100&page=2': JSON.stringify(
        [repo('acme/web'), repo('acme/fork-of-lib', { fork: true })],
        null,
        2
      ),
      '/orgs/acme/repos?per_page=100&page=3': []
    });

    const result = await run(['acme'], {
      cwd: s.cwd,
      env: env(s, api, { GITHUB_TOKEN: TOKEN })
    });
    expect(result.stderr).not.toContain('error:');
    expect(result.code).toBe(0);

    const out = path.join(s.cwd, 'secureci-org-scan-acme');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')
    );
    expect(manifest).toMatchObject({
      tool: 'secureci-org-scan',
      org: 'acme',
      secureciVersion: '9.9.9',
      contract: null,
      repos: [
        { name: 'acme/api', status: 'scanned', workflows: 2 },
        { name: 'acme/web', status: 'scanned', workflows: 1 }
      ]
    });
    expect(manifest.scannedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
    );

    expect(listFiles(out)).toEqual([
      'errors.log',
      'manifest.json',
      'repos/acme__api/inventory/ci.yml.json',
      'repos/acme__api/inventory/deploy.yaml.json',
      'repos/acme__api/validate.json',
      'repos/acme__web/inventory/ci.yml.json',
      'repos/acme__web/validate.json'
    ]);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(out, 'repos/acme__api/inventory/ci.yml.json'),
          'utf8'
        )
      ).file
    ).toBe('.github/workflows/ci.yml');

    // validate runs once per repo, on every top-level workflow file.
    expect(s.calls().filter((c) => c.includes('|validate'))).toEqual([
      expect.stringMatching(
        /\|validate --format json \.github\/workflows\/ci\.yml \.github\/workflows\/deploy\.yaml$/
      ),
      expect.stringMatching(
        /\|validate --format json \.github\/workflows\/ci\.yml$/
      )
    ]);

    // The API saw the token; the output never contains it or any source code.
    expect(api.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(readAll(out)).not.toContain(TOKEN);
    expect(readAll(out)).not.toContain('super-secret-source');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);

    // The archive holds the same files, and the clones are gone.
    const archive = `${out}.tar.gz`;
    expect(fs.existsSync(archive)).toBe(true);
    const listing = execFileSync('tar', ['-tzf', archive], {
      encoding: 'utf8'
    });
    expect(listing).toContain('secureci-org-scan-acme/manifest.json');
    expect(listing).not.toContain('src/index.js');
    // It says where to send the archive, and that other routes exist.
    expect(result.stdout).toContain('Email it to hello@secure-ci.dev');
    expect(result.stdout).toContain("we'll agree another way");
    expect(result.stdout).toContain(
      path.join(fs.realpathSync(s.cwd), 'secureci-org-scan-acme.tar.gz')
    );
  });

  it('falls back to the user endpoint when the owner is not an organization', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'alice/tool', { '.github/workflows/ci.yml': WORKFLOW });
    const api = await fakeApi({
      '/orgs/alice/repos?per_page=100&page=1': 404,
      '/users/alice/repos?per_page=100&type=owner&page=1': [repo('alice/tool')],
      '/users/alice/repos?per_page=100&type=owner&page=2': []
    });

    const result = await run(['alice'], { cwd: s.cwd, env: env(s, api) });
    expect(result.code).toBe(0);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(s.cwd, 'secureci-org-scan-alice', 'manifest.json'),
        'utf8'
      )
    );
    expect(manifest.repos).toEqual([
      { name: 'alice/tool', status: 'scanned', workflows: 1 }
    ]);
    // Without a token, no Authorization header is sent.
    expect(api.requests.every((r) => r.auth === undefined)).toBe(true);
  });

  it('scans only the repositories in --repos, without calling the API', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/api', { '.github/workflows/ci.yml': WORKFLOW });
    bareRepo(s.gitRoot, 'acme/web', { '.github/workflows/ci.yml': WORKFLOW });
    bareRepo(s.gitRoot, 'partner/shared', {
      '.github/workflows/ci.yml': WORKFLOW
    });
    const api = await fakeApi({});
    fs.writeFileSync(
      path.join(s.cwd, 'repos.txt'),
      '# repositories to scan\napi\n\n  partner/shared  \n'
    );

    const result = await run(['acme', '--repos', 'repos.txt'], {
      cwd: s.cwd,
      env: env(s, api)
    });
    expect(result.code).toBe(0);
    expect(api.requests).toEqual([]);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(s.cwd, 'secureci-org-scan-acme', 'manifest.json'),
        'utf8'
      )
    );
    expect(manifest.repos.map((r: { name: string }) => r.name)).toEqual([
      'acme/api',
      'partner/shared'
    ]);
  });

  it('records repos with no workflows and repos that fail to clone, and keeps going', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/docs', { 'README.md': '# docs\n' });
    bareRepo(s.gitRoot, 'acme/web', { '.github/workflows/ci.yml': WORKFLOW });
    fs.writeFileSync(path.join(s.cwd, 'repos.txt'), 'docs\nmissing\nweb\n');

    const result = await run(['acme', '--repos', 'repos.txt'], {
      cwd: s.cwd,
      env: env(s, undefined)
    });
    expect(result.code).toBe(0);
    const out = path.join(s.cwd, 'secureci-org-scan-acme');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')
    );
    expect(manifest.repos).toEqual([
      { name: 'acme/docs', status: 'no-workflows', workflows: 0 },
      { name: 'acme/missing', status: 'clone-failed', workflows: 0 },
      { name: 'acme/web', status: 'scanned', workflows: 1 }
    ]);
    expect(fs.readFileSync(path.join(out, 'errors.log'), 'utf8')).toContain(
      'acme/missing'
    );
    expect(result.stdout).toMatch(/1 scanned, 1 without workflows, 1 failed/);
  });

  it('passes a local --contract to validate as an absolute path, and records it', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/api', { '.github/workflows/ci.yml': WORKFLOW });
    fs.mkdirSync(path.join(s.cwd, 'contracts'));
    fs.writeFileSync(
      path.join(s.cwd, 'contracts', 'std.yml'),
      'required: []\n'
    );
    fs.writeFileSync(path.join(s.cwd, 'repos.txt'), 'api\n');

    const result = await run(
      ['acme', '--repos', 'repos.txt', '--contract', 'contracts/std.yml'],
      { cwd: s.cwd, env: env(s, undefined) }
    );
    expect(result.code).toBe(0);
    const contract = path.join(fs.realpathSync(s.cwd), 'contracts', 'std.yml');
    expect(s.calls().find((c) => c.includes('|validate'))).toContain(
      `validate --format json --contract ${contract} .github/workflows/ci.yml`
    );
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(s.cwd, 'secureci-org-scan-acme', 'manifest.json'),
        'utf8'
      )
    );
    expect(manifest.contract).toBe('contracts/std.yml');
  });

  it('passes a remote --contract through unchanged', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/api', { '.github/workflows/ci.yml': WORKFLOW });
    fs.writeFileSync(path.join(s.cwd, 'repos.txt'), 'api\n');
    const remote = 'acme/standards/contracts/platform.yml@4f1c2d3';

    const result = await run(
      ['acme', '--repos', 'repos.txt', '--contract', remote],
      { cwd: s.cwd, env: env(s, undefined) }
    );
    expect(result.code).toBe(0);
    expect(s.calls().find((c) => c.includes('|validate'))).toContain(
      `--contract ${remote} `
    );
  });

  it('writes to --out, and keeps secureci stderr in errors.log', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/api', { '.github/workflows/ci.yml': WORKFLOW });
    fs.writeFileSync(path.join(s.cwd, 'repos.txt'), 'api\n');

    const result = await run(
      ['--out', 'scan', '--repos', 'repos.txt', 'acme'],
      {
        cwd: s.cwd,
        env: env(s, undefined, { FAKE_STDERR: 'advisory lookup failed' })
      }
    );
    expect(result.code).toBe(0);
    const log = fs.readFileSync(path.join(s.cwd, 'scan', 'errors.log'), 'utf8');
    expect(log).toContain('acme/api');
    expect(log).toContain('advisory lookup failed');
    expect(fs.existsSync(path.join(s.cwd, 'scan.tar.gz'))).toBe(true);
  });

  it('skips repository names that are not plain owner/name', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/api', { '.github/workflows/ci.yml': WORKFLOW });
    const api = await fakeApi({
      '/orgs/acme/repos?per_page=100&page=1': [
        repo('acme/../../etc'),
        repo('acme/api')
      ],
      '/orgs/acme/repos?per_page=100&page=2': []
    });

    const result = await run(['acme'], { cwd: s.cwd, env: env(s, api) });
    expect(result.code).toBe(0);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(s.cwd, 'secureci-org-scan-acme', 'manifest.json'),
        'utf8'
      )
    );
    expect(manifest.repos.map((r: { name: string }) => r.name)).toEqual([
      'acme/api'
    ]);
    expect(result.stderr).toContain('skipping unexpected repository name');
  });

  it('fails clearly when the API refuses the request', async () => {
    const s = setup();
    const api = await fakeApi({
      '/orgs/acme/repos?per_page=100&page=1': 401
    });
    const result = await run(['acme'], { cwd: s.cwd, env: env(s, api) });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/error: .*HTTP 401/);
  });

  it('fails clearly when the org finds no repositories', async () => {
    const s = setup();
    const api = await fakeApi({ '/orgs/acme/repos?per_page=100&page=1': [] });
    const result = await run(['acme'], { cwd: s.cwd, env: env(s, api) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error: no repositories to scan');
  });

  it('refuses to overwrite an existing output directory', async () => {
    const s = setup();
    fs.mkdirSync(path.join(s.cwd, 'secureci-org-scan-acme'));
    const result = await run(['acme'], { cwd: s.cwd, env: env(s, undefined) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('already exists');
  });

  it('prints usage and exits 2 without an org, or with an unknown option', async () => {
    const s = setup();
    const none = await run([], { cwd: s.cwd, env: env(s, undefined) });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain('Usage:');
    const bad = await run(['acme', '--nope'], {
      cwd: s.cwd,
      env: env(s, undefined)
    });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown option: --nope');
  });

  it('prints help on --help and exits 0', async () => {
    const s = setup();
    const result = await run(['--help'], {
      cwd: s.cwd,
      env: env(s, undefined)
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--repos');
  });

  it('runs secureci from PATH when SECURECI is unset', async () => {
    const s = setup();
    bareRepo(s.gitRoot, 'acme/api', { '.github/workflows/ci.yml': WORKFLOW });
    fs.writeFileSync(path.join(s.cwd, 'repos.txt'), 'api\n');
    const result = await run(['--repos', 'repos.txt', 'acme'], {
      cwd: s.cwd,
      env: {
        ...env(s, undefined),
        SECURECI: undefined,
        PATH: `${path.dirname(s.secureci)}${path.delimiter}${process.env.PATH}`
      }
    });
    expect(result.stderr).not.toContain('error:');
    expect(result.code).toBe(0);
    expect(s.calls().map((c) => c.split('|')[1])).toEqual([
      '--version',
      'validate --format json .github/workflows/ci.yml',
      'inventory --dry-run .github/workflows/ci.yml'
    ]);
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(s.cwd, 'secureci-org-scan-acme', 'manifest.json'),
        'utf8'
      )
    );
    expect(manifest.secureciVersion).toBe('9.9.9');
  });

  it('fails clearly when secureci is not installed', async () => {
    const s = setup();
    const result = await run(['acme'], {
      cwd: s.cwd,
      env: { ...env(s, undefined), SECURECI: path.join(s.cwd, 'nope') }
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('secureci');
    expect(result.stderr).toContain('https://secure-ci.dev/install.sh');
  });
});
