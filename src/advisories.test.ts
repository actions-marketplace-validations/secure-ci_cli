import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  Advisory,
  AdvisoryChecker,
  AdvisoryFinding,
  AdvisoryTarget,
  HttpGet,
  advisoryValidationErrors,
  checkFileAdvisories,
  chooseVersion,
  compareVersions,
  describeFinding,
  describeReport,
  describeUnchecked,
  fetchRepoAdvisories,
  findingLevel,
  getAdvisoryCacheDir,
  matchAdvisories,
  mergeReports,
  parseAdvisories,
  parseVersion,
  targetsFromInventory,
  targetsFromReferences,
  versionInRange
} from './advisories';
import { parseFile } from './parser/workflow-parser';

const fixturesDir = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'advisories'
);
const fixture = (name: string): string =>
  fs.readFileSync(path.join(fixturesDir, name), 'utf8');

const DAY = 24 * 60 * 60 * 1000;

/** An HttpGet serving fixtures by `affects=` package, recording calls. */
function fakeHttp(byRepo: Record<string, string>): HttpGet & {
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const get = (async (url: string, headers: Record<string, string>) => {
    calls.push({ url, headers });
    const affects = new URL(url).searchParams.get('affects') ?? '';
    const body = byRepo[affects.toLowerCase()];
    if (body === undefined) {
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    }
    return body;
  }) as HttpGet & { calls: typeof calls };
  get.calls = calls;
  return get;
}

function target(uses: string, extra: Partial<AdvisoryTarget> = {}) {
  const at = uses.lastIndexOf('@');
  const [owner, repo, ...rest] = uses.slice(0, at).split('/');
  return {
    uses,
    owner,
    repo,
    subpath: rest.length ? rest.join('/') : undefined,
    ref: uses.slice(at + 1),
    path: 'jobs.a.steps[0]',
    ...extra
  };
}

describe('parseVersion / compareVersions', () => {
  it('parses tags with or without a v prefix, partial and prerelease', () => {
    expect(parseVersion('v4')).toEqual({ nums: [4], pre: [] });
    expect(parseVersion('4.1')).toEqual({ nums: [4, 1], pre: [] });
    expect(parseVersion('v1.2.3-beta.1+build.5')).toEqual({
      nums: [1, 2, 3],
      pre: ['beta', '1']
    });
    expect(parseVersion('main')).toBeNull();
    expect(parseVersion('v1.x')).toBeNull();
    expect(parseVersion('a'.repeat(40))).toBeNull();
  });

  it('compares numerically, pads missing parts, and ranks prereleases lower', () => {
    const cmp = (a: string, b: string) =>
      compareVersions(
        parseVersion(a) as NonNullable<ReturnType<typeof parseVersion>>,
        parseVersion(b) as NonNullable<ReturnType<typeof parseVersion>>
      );
    expect(cmp('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(cmp('v4', '4.0.0')).toBe(0);
    expect(cmp('2.0.0-rc.1', '2.0.0')).toBeLessThan(0);
    expect(cmp('2.0.0', '2.0.0-rc.1')).toBeGreaterThan(0);
    expect(cmp('2.0.0-rc.2', '2.0.0-rc.10')).toBeLessThan(0);
    expect(cmp('2.0.0-alpha', '2.0.0-1')).toBeGreaterThan(0);
    expect(cmp('2.0.0-1', '2.0.0-alpha')).toBeLessThan(0);
    expect(cmp('2.0.0-rc', '2.0.0-rc.1')).toBeLessThan(0);
    expect(cmp('2.0.0-beta', '2.0.0-alpha')).toBeGreaterThan(0);
  });
});

describe('versionInRange', () => {
  it.each([
    ['45.0.7', '< 46.0.1', true],
    ['46.0.1', '< 46.0.1', false],
    ['v46.0.0', '<46.0.1', true],
    ['2.3.4', '>= 1.0, < 2.3.4', false],
    ['2.3.3', '>= 1.0, < 2.3.4', true],
    ['0.9.0', '>= 1.0, < 2.3.4', false],
    ['1.0.0', '>= 1.0, < 2.3.4', true],
    ['2.3.4', '<= 2.3.4', true],
    ['3.0.0', '> 2.3.4', true],
    ['2.3.4', '> 2.3.4', false],
    ['3.1.0', '= 3.1.0', true],
    ['3.1.1', '= 3.1.0', false],
    ['3.1.0', '3.1.0', true],
    ['2.0.0-rc.1', '>= 2.0.0', false]
  ])('%s in "%s" is %s', (version, range, expected) => {
    expect(versionInRange(version, range)).toBe(expected);
  });

  it('is undefined when the version or range cannot be read', () => {
    expect(versionInRange('main', '< 1.0.0')).toBeUndefined();
    expect(versionInRange('1.0.0', '')).toBeUndefined();
    expect(versionInRange('1.0.0', '~> 1.0')).toBeUndefined();
    expect(versionInRange('1.0.0', '< 1.0, ')).toBeUndefined();
  });
});

describe('chooseVersion', () => {
  const sha = 'a'.repeat(40);
  const tags = new Map([
    ['v4', sha],
    ['v4.2', sha],
    ['v4.2.1', sha],
    ['v4.2.0', 'b'.repeat(40)],
    ['nightly', sha]
  ]);

  it('uses a full version ref as is', () => {
    expect(chooseVersion('v1.2.3')).toEqual({
      version: 'v1.2.3',
      approximate: false
    });
  });

  it('maps a SHA pin to the most specific release tag at that commit', () => {
    expect(chooseVersion(sha, sha, tags)).toEqual({
      version: 'v4.2.1',
      approximate: false
    });
  });

  it('maps a moving major tag to the release it points at', () => {
    expect(chooseVersion('v4', undefined, tags)).toEqual({
      version: 'v4.2.1',
      approximate: false
    });
  });

  it('treats a moving tag it cannot map as its lower bound, approximately', () => {
    expect(chooseVersion('v4')).toEqual({ version: 'v4', approximate: true });
    expect(chooseVersion('v5', undefined, tags)).toEqual({
      version: 'v5',
      approximate: true
    });
  });

  it('returns undefined for an untagged commit or a branch', () => {
    expect(chooseVersion('c'.repeat(40), 'c'.repeat(40), tags)).toBeUndefined();
    expect(chooseVersion('main')).toBeUndefined();
    // An all-digit SHA is not version 9999...
    expect(chooseVersion('9'.repeat(40))).toBeUndefined();
    expect(chooseVersion(undefined)).toBeUndefined();
  });
});

describe('parseAdvisories', () => {
  it('reads the REST response, dropping withdrawn advisories and other ecosystems', () => {
    const parsed = parseAdvisories(JSON.parse(fixture('mixed.json')));
    expect(parsed.map((a) => a.ghsaId)).toEqual([
      'GHSA-aaaa-bbbb-cccc',
      'GHSA-gggg-hhhh-iiii'
    ]);
    expect(parsed[0]).toEqual({
      ghsaId: 'GHSA-aaaa-bbbb-cccc',
      summary: 'Critical issue in the upload sub-action',
      severity: 'critical',
      url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
      vulnerabilities: [
        {
          package: 'example-org/toolkit/upload',
          range: '>= 2.0.0, <= 2.3.4',
          firstPatched: '2.3.5'
        }
      ]
    });
    expect(parsed[1].cveId).toBe('CVE-2024-0001');
    expect(parsed[1].vulnerabilities[0].firstPatched).toBeUndefined();
  });

  it('normalises severities and tolerates junk', () => {
    expect(parseAdvisories({ not: 'an array' })).toEqual([]);
    const parsed = parseAdvisories([
      null,
      { ghsa_id: 1 },
      { ghsa_id: 'GHSA-1', severity: 'moderate', vulnerabilities: 'x' },
      {
        ghsa_id: 'GHSA-2',
        severity: 'weird',
        summary: 3,
        vulnerabilities: [null, { package: {} }]
      }
    ]);
    expect(parsed).toEqual([
      {
        ghsaId: 'GHSA-1',
        summary: '',
        severity: 'medium',
        vulnerabilities: []
      },
      {
        ghsaId: 'GHSA-2',
        summary: '',
        severity: 'unknown',
        vulnerabilities: []
      }
    ]);
  });
});

describe('matchAdvisories', () => {
  const tj = parseAdvisories(
    JSON.parse(fixture('tj-actions-changed-files.json'))
  );
  const mixed = parseAdvisories(JSON.parse(fixture('mixed.json')));

  it('flags every advisory whose range contains the version', () => {
    const findings = matchAdvisories(
      target('tj-actions/changed-files@v40.1.0'),
      { version: 'v40.1.0', approximate: false },
      tj
    );
    expect(findings.map((f) => [f.ghsaId, f.severity])).toEqual([
      ['GHSA-mrrh-fwg8-r2c3', 'high'],
      ['GHSA-mcph-m25j-8j63', 'medium']
    ]);
    expect(findings[0]).toMatchObject({
      uses: 'tj-actions/changed-files@v40.1.0',
      cveId: 'CVE-2025-30066',
      range: '< 46.0.1',
      firstPatched: '46.0.1',
      version: 'v40.1.0',
      approximate: false,
      path: 'jobs.a.steps[0]'
    });
  });

  it('does not flag a patched version', () => {
    expect(
      matchAdvisories(
        target('tj-actions/changed-files@v46.0.1'),
        { version: 'v46.0.1', approximate: false },
        tj
      )
    ).toEqual([]);
  });

  it('matches package names case-insensitively, including sub-actions', () => {
    const upload = matchAdvisories(
      target('example-org/toolkit/upload@v2.1.0'),
      { version: 'v2.1.0', approximate: false },
      mixed
    );
    expect(upload.map((f) => f.ghsaId)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    // The sub-action's advisory doesn't apply to the repository root.
    expect(
      matchAdvisories(
        target('example-org/toolkit@v2.1.0'),
        { version: 'v2.1.0', approximate: false },
        mixed
      )
    ).toEqual([]);
  });

  it('flags an unreadable range as "may be affected"', () => {
    const odd: Advisory[] = [
      {
        ghsaId: 'GHSA-odd',
        summary: 'odd range',
        severity: 'high',
        vulnerabilities: [{ package: 'o/r', range: '~> 1.0' }]
      }
    ];
    const [finding] = matchAdvisories(
      target('o/r@v1.0.0'),
      { version: 'v1.0.0', approximate: false },
      odd
    );
    expect(finding.approximate).toBe(true);
    expect(describeFinding(finding)).toContain(
      'The affected range could not be read.'
    );
    expect(describeFinding(finding)).not.toContain('moving tag');
  });
});

describe('severity and messages', () => {
  const finding = (over: Partial<AdvisoryFinding> = {}): AdvisoryFinding => ({
    uses: 'tj-actions/changed-files@v45',
    ghsaId: 'GHSA-mrrh-fwg8-r2c3',
    cveId: 'CVE-2025-30066',
    severity: 'high',
    summary: 'Leaks secrets.',
    url: 'https://github.com/advisories/GHSA-mrrh-fwg8-r2c3',
    range: '< 46.0.1',
    firstPatched: '46.0.1',
    version: 'v45.0.0',
    approximate: false,
    path: 'jobs.a.steps[0]',
    ...over
  });

  it('maps critical/high to error and medium/low/unknown to warning by default', () => {
    expect(findingLevel(finding({ severity: 'critical' }))).toBe('error');
    expect(findingLevel(finding({ severity: 'high' }))).toBe('error');
    expect(findingLevel(finding({ severity: 'medium' }))).toBe('warning');
    expect(findingLevel(finding({ severity: 'low' }))).toBe('warning');
    expect(findingLevel(finding({ severity: 'unknown' }))).toBe('warning');
  });

  it('makes findings at or above the contract fail-on level errors', () => {
    expect(findingLevel(finding({ severity: 'medium' }), 'medium')).toBe(
      'error'
    );
    expect(findingLevel(finding({ severity: 'low' }), 'medium')).toBe(
      'warning'
    );
    expect(findingLevel(finding({ severity: 'high' }), 'critical')).toBe(
      'warning'
    );
    expect(findingLevel(finding({ severity: 'low' }), 'low')).toBe('error');
  });

  it('never fails on an approximate match', () => {
    expect(
      findingLevel(finding({ severity: 'critical', approximate: true }), 'low')
    ).toBe('warning');
  });

  it('describes the advisory, its fix and an approximate match', () => {
    expect(describeFinding(finding())).toBe(
      'tj-actions/changed-files@v45 has a known security advisory: GHSA-mrrh-fwg8-r2c3 (CVE-2025-30066, high): Leaks secrets. Affected versions: < 46.0.1; first patched version: 46.0.1. https://github.com/advisories/GHSA-mrrh-fwg8-r2c3'
    );
    const approx = describeFinding(
      finding({
        version: 'v45',
        approximate: true,
        firstPatched: undefined,
        cveId: undefined,
        url: undefined
      })
    );
    expect(approx).toContain('may be affected');
    expect(approx).toContain('GHSA-mrrh-fwg8-r2c3 (high)');
    expect(approx).toContain('no patched version yet');
    expect(approx).toContain('v45 is a moving tag');
    expect(approx).toContain('compared as 45.0.0');
  });

  it('becomes secureci/vulnerable-action validation errors', () => {
    const errors = advisoryValidationErrors(
      {
        findings: [finding(), finding({ severity: 'low' })],
        unknownVersions: [],
        unchecked: [],
        stale: []
      },
      undefined
    );
    expect(errors).toEqual([
      expect.objectContaining({
        path: 'jobs.a.steps[0]',
        severity: 'error',
        rule: 'secureci/vulnerable-action'
      }),
      expect.objectContaining({ severity: 'warning' })
    ]);
    expect(errors[0].message).toContain('GHSA-mrrh-fwg8-r2c3');
  });

  it('summarises repositories that were not checked', () => {
    expect(describeUnchecked([])).toBeUndefined();
    expect(
      describeUnchecked([
        { repo: 'a/b', reason: 'offline and not cached' },
        { repo: 'c/d', reason: 'offline and not cached' },
        { repo: 'e/f', reason: 'HTTP 404' }
      ])
    ).toBe(
      'Security advisories not checked for a/b, c/d (offline and not cached); e/f (HTTP 404).'
    );
  });
});

describe('fetchRepoAdvisories', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-adv-'));
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const base = {
    apiUrl: 'https://ghe.example.com/api/v3',
    token: null as string | null
  };

  it('queries GET /advisories for the actions ecosystem and caches the result', async () => {
    const http = fakeHttp({
      'tj-actions/changed-files': fixture('tj-actions-changed-files.json')
    });
    const now = 1_000_000;
    const result = await fetchRepoAdvisories('tj-actions', 'changed-files', {
      ...base,
      httpGet: http,
      cacheDir,
      now: () => now,
      token: 'tok'
    });
    expect(result.advisories?.map((a) => a.ghsaId)).toEqual([
      'GHSA-mrrh-fwg8-r2c3',
      'GHSA-mcph-m25j-8j63'
    ]);
    const url = new URL(http.calls[0].url);
    expect(url.origin + url.pathname).toBe(
      'https://ghe.example.com/api/v3/advisories'
    );
    expect(url.searchParams.get('ecosystem')).toBe('actions');
    expect(url.searchParams.get('affects')).toBe('tj-actions/changed-files');
    expect(url.searchParams.get('per_page')).toBe('100');
    expect(http.calls[0].headers).toMatchObject({
      Authorization: 'Bearer tok',
      Accept: 'application/vnd.github+json',
      'User-Agent': 'secureci-cli'
    });
    const cached = JSON.parse(
      fs.readFileSync(
        path.join(cacheDir, 'tj-actions', 'changed-files.json'),
        'utf8'
      )
    );
    expect(cached).toMatchObject({
      api: base.apiUrl,
      fetchedAt: now
    });

    // Within the TTL the cache answers; no request.
    const again = await fetchRepoAdvisories('TJ-Actions', 'Changed-Files', {
      ...base,
      httpGet: http,
      cacheDir,
      now: () => now + DAY - 1
    });
    expect(again.advisories).toHaveLength(2);
    expect(http.calls).toHaveLength(1);

    // After the TTL it is fetched again.
    await fetchRepoAdvisories('tj-actions', 'changed-files', {
      ...base,
      httpGet: http,
      cacheDir,
      now: () => now + DAY + 1
    });
    expect(http.calls).toHaveLength(2);
  });

  it('honours a custom TTL and ignores a cache written for another API', async () => {
    const http = fakeHttp({ 'o/r': '[]' });
    await fetchRepoAdvisories('o', 'r', {
      ...base,
      httpGet: http,
      cacheDir,
      now: () => 0
    });
    await fetchRepoAdvisories('o', 'r', {
      ...base,
      httpGet: http,
      cacheDir,
      now: () => 10,
      ttlMs: 5
    });
    expect(http.calls).toHaveLength(2);
    await fetchRepoAdvisories('o', 'r', {
      apiUrl: 'https://api.github.com',
      token: null,
      httpGet: http,
      cacheDir,
      now: () => 11
    });
    expect(http.calls).toHaveLength(3);
  });

  it('offline: uses the cache even when stale, else reports not cached', async () => {
    const http = fakeHttp({ 'o/r': fixture('mixed.json') });
    await fetchRepoAdvisories('o', 'r', {
      ...base,
      httpGet: http,
      cacheDir,
      now: () => 0
    });
    const stale = await fetchRepoAdvisories('o', 'r', {
      ...base,
      httpGet: http,
      cacheDir,
      now: () => 10 * DAY,
      offline: true
    });
    expect(stale.advisories).toHaveLength(2);
    expect(stale.stale).toBe(true);
    const missing = await fetchRepoAdvisories('x', 'y', {
      ...base,
      httpGet: http,
      cacheDir,
      offline: true
    });
    expect(missing).toEqual({ error: 'offline and not cached' });
    expect(http.calls).toHaveLength(1);
  });

  it('falls back to a stale cache when the API fails', async () => {
    const ok = fakeHttp({ 'o/r': '[]' });
    await fetchRepoAdvisories('o', 'r', {
      ...base,
      httpGet: ok,
      cacheDir,
      now: () => 0
    });
    const failing: HttpGet = async () => {
      throw Object.assign(new Error('HTTP 403'), { status: 403 });
    };
    const result = await fetchRepoAdvisories('o', 'r', {
      ...base,
      httpGet: failing,
      cacheDir,
      now: () => 2 * DAY
    });
    expect(result).toMatchObject({ advisories: [], stale: true });
    expect(result.error).toContain('rate-limited');

    const none = await fetchRepoAdvisories('p', 'q', {
      ...base,
      httpGet: failing,
      cacheDir
    });
    expect(none.advisories).toBeUndefined();
    expect(none.error).toMatch(/HTTP 403.*GITHUB_TOKEN/);
  });

  it('reports a network error and an unparseable body', async () => {
    const down: HttpGet = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(
      await fetchRepoAdvisories('o', 'r', { ...base, httpGet: down, cacheDir })
    ).toEqual({ error: 'connect ECONNREFUSED' });
    const junk: HttpGet = async () => 'not json';
    expect(
      (
        await fetchRepoAdvisories('o', 'r', {
          ...base,
          httpGet: junk,
          cacheDir
        })
      ).error
    ).toBeTruthy();
  });

  it('retries without a token GitHub rejects', async () => {
    const seen: Array<string | undefined> = [];
    const http: HttpGet = async (_url, headers) => {
      seen.push(headers.Authorization);
      if (headers.Authorization) {
        throw Object.assign(new Error('HTTP 401'), { status: 401 });
      }
      return '[]';
    };
    const result = await fetchRepoAdvisories('o', 'r', {
      ...base,
      token: 'expired',
      httpGet: http,
      cacheDir
    });
    expect(result.advisories).toEqual([]);
    expect(seen).toEqual(['Bearer expired', undefined]);
  });

  it('does not query or cache names that are not repository names', async () => {
    const http = fakeHttp({});
    expect(
      await fetchRepoAdvisories('..', 'r', { ...base, httpGet: http, cacheDir })
    ).toEqual({ advisories: [] });
    expect(http.calls).toHaveLength(0);
  });

  it('ignores a corrupt cache file', async () => {
    fs.mkdirSync(path.join(cacheDir, 'o'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'o', 'r.json'), '{oops');
    const http = fakeHttp({ 'o/r': '[]' });
    expect(
      (
        await fetchRepoAdvisories('o', 'r', {
          ...base,
          httpGet: http,
          cacheDir
        })
      ).advisories
    ).toEqual([]);
    expect(http.calls).toHaveLength(1);
  });

  it('defaults to ~/.secureci/advisories and the configured API', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-home-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('GITHUB_API_URL', 'https://ghe.example.com/api/v3/');
    try {
      expect(getAdvisoryCacheDir()).toBe(
        path.join(home, '.secureci', 'advisories')
      );
      const http = fakeHttp({ 'o/r': '[]' });
      await fetchRepoAdvisories('o', 'r', { httpGet: http, token: null });
      expect(http.calls[0].url).toMatch(
        /^https:\/\/ghe\.example\.com\/api\/v3\/advisories\?/
      );
      expect(
        fs.existsSync(path.join(home, '.secureci', 'advisories', 'o', 'r.json'))
      ).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AdvisoryChecker', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-adv-'));
  });
  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  const tjSha = '1'.repeat(40);
  const tags = new Map([
    ['v45', tjSha],
    ['v45.0.7', tjSha],
    ['v46', '2'.repeat(40)],
    ['v46.0.1', '2'.repeat(40)]
  ]);

  function checker(over: Record<string, unknown> = {}) {
    const http = fakeHttp({
      'tj-actions/changed-files': fixture('tj-actions-changed-files.json'),
      'actions/checkout': fixture('none.json')
    });
    const listTags = vi.fn(async () => tags);
    return {
      http,
      listTags,
      checker: new AdvisoryChecker({
        apiUrl: 'https://api.github.com',
        token: null,
        httpGet: http,
        cacheDir,
        listTags,
        ...over
      })
    };
  }

  it('queries each repository once and flags vulnerable refs', async () => {
    const looked: string[] = [];
    const {
      checker: c,
      http,
      listTags
    } = checker({
      onLookup: (repo: string) => looked.push(repo)
    });
    const report = await c.check([
      target('tj-actions/changed-files@v45.0.7'),
      target('tj-actions/changed-files@v46.0.1'),
      target('actions/checkout@v4'),
      target('actions/checkout@v3')
    ]);
    expect(http.calls).toHaveLength(2);
    expect(looked).toEqual(['tj-actions/changed-files', 'actions/checkout']);
    expect(report.findings.map((f) => [f.uses, f.ghsaId])).toEqual([
      ['tj-actions/changed-files@v45.0.7', 'GHSA-mrrh-fwg8-r2c3']
    ]);
    // No advisories for actions/checkout: no tag lookup needed.
    expect(listTags).not.toHaveBeenCalled();
    expect(report.unknownVersions).toEqual([]);

    // A second check reuses the in-memory answer.
    await c.check([target('tj-actions/changed-files@v44.0.0')]);
    expect(http.calls).toHaveLength(2);
  });

  it('maps a SHA pin to its tag, and reports an untagged pin as unknown', async () => {
    const { checker: c, listTags } = checker();
    const report = await c.check([
      target(`tj-actions/changed-files@${tjSha}`, { sha: tjSha }),
      target(`tj-actions/changed-files@${'9'.repeat(40)}`, {
        sha: '9'.repeat(40)
      })
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      uses: `tj-actions/changed-files@${tjSha}`,
      version: 'v45.0.7',
      approximate: false
    });
    expect(report.unknownVersions).toEqual([
      {
        uses: `tj-actions/changed-files@${'9'.repeat(40)}`,
        advisories: ['GHSA-mrrh-fwg8-r2c3', 'GHSA-mcph-m25j-8j63']
      }
    ]);
    expect(listTags).toHaveBeenCalledTimes(1);
    expect(listTags).toHaveBeenCalledWith('tj-actions', 'changed-files');
  });

  it('resolves a moving major tag through the tag list', async () => {
    const { checker: c } = checker();
    const report = await c.check([
      target('tj-actions/changed-files@v45'),
      target('tj-actions/changed-files@v46')
    ]);
    expect(report.findings.map((f) => [f.uses, f.version])).toEqual([
      ['tj-actions/changed-files@v45', 'v45.0.7']
    ]);
  });

  it('falls back to the lower bound of a moving tag when tags cannot be listed', async () => {
    const { checker: c } = checker({ listTags: async () => undefined });
    const report = await c.check([target('tj-actions/changed-files@v45')]);
    expect(report.findings[0]).toMatchObject({
      version: 'v45',
      approximate: true
    });
  });

  it('offline: does not list tags, uses only the cache, and reports the rest', async () => {
    const online = checker();
    await online.checker.check([target('tj-actions/changed-files@v45.0.7')]);
    const { checker: c, http, listTags } = checker({ offline: true });
    const report = await c.check([
      target('tj-actions/changed-files@v45'),
      target('actions/checkout@v4')
    ]);
    expect(http.calls).toHaveLength(0);
    expect(listTags).not.toHaveBeenCalled();
    expect(report.findings[0]).toMatchObject({ approximate: true });
    expect(report.unchecked).toEqual([
      { repo: 'actions/checkout', reason: 'offline and not cached' }
    ]);
  });

  it('records repositories answered from a stale cache', async () => {
    const first = checker({ now: () => 0 });
    await first.checker.check([target('actions/checkout@v4')]);
    const { checker: c } = checker({
      now: () => 3 * DAY,
      httpGet: async () => {
        throw new Error('offline');
      }
    });
    const report = await c.check([target('actions/checkout@v4')]);
    expect(report.stale).toEqual(['actions/checkout']);
    expect(report.unchecked).toEqual([]);
  });
});

describe.skipIf(process.env.CI || !process.env.RUN_NETWORK_TESTS)(
  'GitHub Advisory Database (network)',
  () => {
    it('finds GHSA-mrrh-fwg8-r2c3 for tj-actions/changed-files@v45.0.7', async () => {
      const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-adv-'));
      try {
        const report = await new AdvisoryChecker({ cacheDir }).check([
          target('tj-actions/changed-files@v45.0.7')
        ]);
        expect(report.findings.map((f) => f.ghsaId)).toContain(
          'GHSA-mrrh-fwg8-r2c3'
        );
      } finally {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      }
    }, 60_000);
  }
);

describe('targets and output helpers', () => {
  const sha = '1'.repeat(40);

  it('turns references into distinct targets, keeping the first path', () => {
    const refs = [
      {
        uses: 'tj-actions/changed-files@v45',
        kind: 'action' as const,
        owner: 'tj-actions',
        repo: 'changed-files',
        ref: 'v45',
        pinned: false,
        path: 'jobs.a.steps[0]'
      },
      {
        uses: 'tj-actions/changed-files@v45',
        kind: 'action' as const,
        owner: 'tj-actions',
        repo: 'changed-files',
        ref: 'v45',
        pinned: false,
        path: 'jobs.b.steps[1]'
      },
      {
        uses: `org/wf/.github/workflows/x.yml@${sha}`,
        kind: 'reusable-workflow' as const,
        owner: 'org',
        repo: 'wf',
        subpath: '.github/workflows/x.yml',
        ref: sha,
        pinned: true,
        path: 'jobs.c'
      },
      { uses: './local', kind: 'local' as const, pinned: false, path: 'x' },
      {
        uses: 'docker://alpine',
        kind: 'docker' as const,
        pinned: false,
        path: 'y'
      }
    ];
    expect(targetsFromReferences(refs)).toEqual([
      {
        uses: 'tj-actions/changed-files@v45',
        owner: 'tj-actions',
        repo: 'changed-files',
        subpath: undefined,
        ref: 'v45',
        sha: undefined,
        path: 'jobs.a.steps[0]'
      },
      {
        uses: `org/wf/.github/workflows/x.yml@${sha}`,
        owner: 'org',
        repo: 'wf',
        subpath: '.github/workflows/x.yml',
        ref: sha,
        sha,
        path: 'jobs.c'
      }
    ]);
  });

  it('turns inventory actions into targets with their resolved commit', () => {
    expect(
      targetsFromInventory([
        {
          uses: 'a/b@v1',
          kind: 'action',
          owner: 'a',
          repo: 'b',
          ref: 'v1',
          pinned: false,
          resolvedSha: sha,
          paths: ['jobs.a.steps[0]', 'jobs.b.steps[0]']
        }
      ])
    ).toEqual([
      {
        uses: 'a/b@v1',
        owner: 'a',
        repo: 'b',
        subpath: undefined,
        ref: 'v1',
        sha,
        path: 'jobs.a.steps[0]'
      }
    ]);
  });

  it('describes a report for the inventory output', () => {
    const lines = describeReport({
      findings: [
        {
          uses: 'a/b@v1.0.0',
          ghsaId: 'GHSA-1',
          severity: 'critical',
          summary: 'Bad',
          range: '< 2.0.0',
          version: 'v1.0.0',
          approximate: false
        },
        {
          uses: 'a/b@v1.0.0',
          ghsaId: 'GHSA-2',
          severity: 'low',
          summary: 'Meh',
          range: '< 2.0.0',
          version: 'v1.0.0',
          approximate: false
        }
      ],
      unknownVersions: [{ uses: `a/b@${sha}`, advisories: ['GHSA-1'] }],
      unchecked: [{ repo: 'c/d', reason: 'HTTP 404' }],
      stale: ['e/f']
    });
    expect(lines.map((l) => l.level)).toEqual([
      'error',
      'warn',
      'info',
      'warn',
      'warn'
    ]);
    expect(lines.map((l) => l.kind)).toEqual([
      'finding',
      'finding',
      'note',
      'note',
      'note'
    ]);
    expect(lines[2].text).toBe(
      `a/b@${sha}: unknown version (the commit is not at a release tag), so advisories GHSA-1 for a/b could not be checked against it.`
    );
    expect(lines[3].text).toContain('c/d (HTTP 404)');
    expect(lines[4].text).toBe(
      'Used cached security advisories older than 24h for e/f (they could not be refreshed).'
    );
  });
});

describe('checkFileAdvisories', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-adv-wf-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('checks the uses: references of a workflow and applies fail-on', async () => {
    const file = path.join(dir, 'ci.yml');
    fs.writeFileSync(
      file,
      [
        'name: CI',
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: tj-actions/changed-files@v40.0.0'
      ].join('\n')
    );
    const parsed = parseFile(file);
    const checker = () =>
      new AdvisoryChecker({
        apiUrl: 'https://api.github.com',
        token: null,
        httpGet: fakeHttp({
          'tj-actions/changed-files': fixture('tj-actions-changed-files.json'),
          'actions/checkout': '[]'
        }),
        cacheDir: path.join(dir, 'cache'),
        listTags: async () => undefined
      });

    const { errors, report } = await checkFileAdvisories(parsed, checker());
    expect(report.findings).toHaveLength(2);
    expect(errors.map((e) => [e.path, e.severity, e.rule])).toEqual([
      ['jobs.a.steps[1]', 'error', 'secureci/vulnerable-action'],
      ['jobs.a.steps[1]', 'warning', 'secureci/vulnerable-action']
    ]);

    const strict = await checkFileAdvisories(parsed, checker(), 'medium');
    expect(strict.errors.map((e) => e.severity)).toEqual(['error', 'error']);
  });
});

describe('mergeReports', () => {
  it('lists each reference and repository once', () => {
    const finding: AdvisoryFinding = {
      uses: 'a/b@v1.0.0',
      ghsaId: 'GHSA-1',
      severity: 'high',
      summary: '',
      range: '< 2',
      version: 'v1.0.0',
      approximate: false
    };
    const one = {
      findings: [finding],
      unknownVersions: [{ uses: 'c/d@x', advisories: ['GHSA-2'] }],
      unchecked: [{ repo: 'e/f', reason: 'HTTP 404' }],
      stale: ['g/h']
    };
    expect(mergeReports([one, one])).toEqual({
      findings: [finding, finding],
      unknownVersions: one.unknownVersions,
      unchecked: one.unchecked,
      stale: one.stale
    });
  });
});
