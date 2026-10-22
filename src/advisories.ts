import * as fs from 'fs';
import * as path from 'path';
import {
  apiUrl as defaultApiUrl,
  getText,
  githubToken,
  lsRemoteTags,
  serverUrl
} from './runner/action-fetcher';
import { collectReferences } from './inventory';
import type { InventoryAction, Reference } from './inventory';
import type { ParsedFile, ValidationError } from './types';

/**
 * Known security advisories for the actions a workflow uses, from the
 * GitHub Advisory Database (`GET /advisories?ecosystem=actions`).
 */

export type AdvisorySeverity =
  'critical' | 'high' | 'medium' | 'low' | 'unknown';

/** Contract `advisories.fail-on` levels, most severe first. */
export const FAIL_ON_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export type FailOn = (typeof FAIL_ON_LEVELS)[number];

export const VULNERABLE_ACTION_RULE = 'secureci/vulnerable-action';

/** Cached advisories are re-fetched after this long. */
export const ADVISORY_TTL_MS = 24 * 60 * 60 * 1000;
const ADVISORY_TIMEOUT_MS = 15000;

export interface AdvisoryVulnerability {
  /** Package name, lower-cased: `owner/repo` or `owner/repo/path`. */
  package: string;
  /** e.g. `< 46.0.1` or `>= 1.0, < 2.3.4`. */
  range: string;
  firstPatched?: string;
}

export interface Advisory {
  ghsaId: string;
  cveId?: string;
  summary: string;
  severity: AdvisorySeverity;
  url?: string;
  /** Only the `actions` ecosystem entries. */
  vulnerabilities: AdvisoryVulnerability[];
}

/** One advisory that applies to one `uses:` reference. */
export interface AdvisoryFinding {
  uses: string;
  ghsaId: string;
  cveId?: string;
  severity: AdvisorySeverity;
  summary: string;
  url?: string;
  range: string;
  firstPatched?: string;
  /** The version compared against the range (a tag name). */
  version: string;
  /**
   * The release can't be pinned down (a moving tag compared by its lower
   * bound, or a range that can't be read): "may be affected".
   */
  approximate: boolean;
  /** Where the reference appears, e.g. `jobs.build.steps[2]`. */
  path?: string;
}

/** A remote action to check. */
export interface AdvisoryTarget {
  uses: string;
  owner: string;
  repo: string;
  subpath?: string;
  ref?: string;
  /** The commit `ref` resolved to, when known. */
  sha?: string;
  path?: string;
}

export interface AdvisoryReport {
  findings: AdvisoryFinding[];
  /** References with advisories whose version couldn't be determined. */
  unknownVersions: Array<{ uses: string; advisories: string[] }>;
  /** `owner/repo` that couldn't be checked, and why. */
  unchecked: Array<{ repo: string; reason: string }>;
  /** `owner/repo` answered from a cache older than the TTL. */
  stale: string[];
}

/** GET `url`; rejects with an error carrying `status` on a non-200. */
export type HttpGet = (
  url: string,
  headers: Record<string, string>
) => Promise<string>;

export interface AdvisoryOptions {
  /** Use only cached advisories; never touch the network. */
  offline?: boolean;
  /** Token for the API; null for none. Default: githubToken(). */
  token?: string | null;
  httpGet?: HttpGet;
  /** REST API base. Default: $GITHUB_API_URL / the server's API. */
  apiUrl?: string;
  /** Default: ~/.secureci/advisories. */
  cacheDir?: string;
  ttlMs?: number;
  now?: () => number;
  /** Called as each repository's advisories are looked up (progress). */
  onLookup?: (repo: string) => void;
  /** Tag name -> commit SHA for a repository, or undefined. */
  listTags?: (
    owner: string,
    repo: string
  ) => Promise<Map<string, string> | undefined>;
}

// ---------------------------------------------------------------------------
// Versions and ranges

export interface Version {
  nums: number[];
  pre: string[];
}

const VERSION =
  /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `v1.2.3`, `1.2`, `v4`, `2.0.0-rc.1`; null for anything else. */
export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (!match) return null;
  return {
    nums: match[1].split('.').map(Number),
    pre: match[2] ? match[2].split('.') : []
  };
}

function comparePre(a: string[], b: string[]): number {
  // A release ranks above its prereleases.
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const d = Number(a[i]) - Number(b[i]);
      if (d !== 0) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Semver order; missing parts count as 0 (`v4` == `4.0.0`). */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length, 3); i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  return comparePre(a.pre, b.pre);
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const CONSTRAINT = /^(<=|>=|<|>|=)?\s*(\S+)$/;

/**
 * Whether `version` satisfies an advisory's `vulnerable_version_range`
 * (comma-separated `<`, `<=`, `>`, `>=`, `=` constraints, all of which
 * must hold), or undefined when either can't be read.
 */
export function versionInRange(
  version: string,
  range: string
): boolean | undefined {
  const v = parseVersion(version);
  if (!v || !range.trim()) return undefined;
  let result = true;
  for (const part of range.split(',')) {
    const match = CONSTRAINT.exec(part.trim());
    const bound = match && parseVersion(match[2]);
    if (!match || !bound) return undefined;
    const d = compareVersions(v, bound);
    const ok =
      match[1] === '<'
        ? d < 0
        : match[1] === '<='
          ? d <= 0
          : match[1] === '>'
            ? d > 0
            : match[1] === '>='
              ? d >= 0
              : d === 0;
    result &&= ok;
  }
  return result;
}

/**
 * The version to compare for a reference:
 * - a full `x.y.z` tag is used as is;
 * - otherwise the commit (`sha`, or what the tag points at in `tags`) is
 *   mapped to the most specific release tag at that commit, so a SHA pin
 *   or a moving `v4` becomes e.g. `v4.2.1`;
 * - a partial tag that can't be mapped (`v4`, `v4.1`) is compared by its
 *   lower bound (`4.0.0`, `4.1.0`) and marked approximate: the release it
 *   points at today is unknown, so it "may be affected";
 * - anything else (an untagged commit, a branch) is undefined.
 */
export function chooseVersion(
  ref: string | undefined,
  sha?: string,
  tags?: Map<string, string>
): { version: string; approximate: boolean } | undefined {
  if (!ref) return undefined;
  const parsed = FULL_SHA.test(ref) ? null : parseVersion(ref);
  if (parsed && parsed.nums.length >= 3) {
    return { version: ref, approximate: false };
  }
  const commit = sha ?? tags?.get(ref);
  if (commit && tags) {
    let best: { name: string; version: Version } | undefined;
    for (const [name, at] of tags) {
      if (at !== commit.toLowerCase()) continue;
      const version = parseVersion(name);
      if (!version || version.nums.length < 3) continue;
      if (!best || compareVersions(version, best.version) > 0) {
        best = { name, version };
      }
    }
    if (best) return { version: best.name, approximate: false };
  }
  if (parsed) return { version: ref, approximate: true };
  return undefined;
}

// ---------------------------------------------------------------------------
// Advisories

const SEVERITIES: Record<string, AdvisorySeverity> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  moderate: 'medium',
  low: 'low'
};

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Advisories from a `GET /advisories` response body, keeping the fields
 * used here. Withdrawn advisories and other ecosystems are dropped.
 */
export function parseAdvisories(body: unknown): Advisory[] {
  if (!Array.isArray(body)) return [];
  const advisories: Advisory[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const ghsaId = asString(item.ghsa_id);
    if (!ghsaId || item.withdrawn_at) continue;
    const vulnerabilities: AdvisoryVulnerability[] = [];
    for (const v of Array.isArray(item.vulnerabilities)
      ? item.vulnerabilities
      : []) {
      if (!v || typeof v !== 'object') continue;
      const vuln = v as Record<string, unknown>;
      const pkg = (vuln.package ?? {}) as Record<string, unknown>;
      const name = asString(pkg.name);
      const range = asString(vuln.vulnerable_version_range);
      if (!name || !range) continue;
      if (pkg.ecosystem !== undefined && pkg.ecosystem !== 'actions') continue;
      // A string in /advisories; an { identifier } object in other APIs.
      const fp = vuln.first_patched_version;
      const firstPatched =
        asString(fp) ??
        asString((fp as { identifier?: unknown } | null)?.identifier);
      vulnerabilities.push({
        package: name.toLowerCase(),
        range,
        ...(firstPatched ? { firstPatched } : {})
      });
    }
    const cveId = asString(item.cve_id);
    const url = asString(item.html_url);
    advisories.push({
      ghsaId,
      ...(cveId ? { cveId } : {}),
      summary: asString(item.summary) ?? '',
      severity:
        SEVERITIES[String(item.severity ?? '').toLowerCase()] ?? 'unknown',
      ...(url ? { url } : {}),
      vulnerabilities
    });
  }
  return advisories;
}

function packageNames(target: AdvisoryTarget): string[] {
  const repo = `${target.owner}/${target.repo}`.toLowerCase();
  return target.subpath
    ? [repo, `${repo}/${target.subpath.toLowerCase()}`]
    : [repo];
}

/** The advisories (of the target's repository) that name this action. */
function relevant(target: AdvisoryTarget, advisories: Advisory[]) {
  const names = packageNames(target);
  return advisories
    .map((advisory) => ({
      advisory,
      vulns: advisory.vulnerabilities.filter((v) => names.includes(v.package))
    }))
    .filter((a) => a.vulns.length > 0);
}

/** The findings for one reference at `version`. */
export function matchAdvisories(
  target: AdvisoryTarget,
  version: { version: string; approximate: boolean },
  advisories: Advisory[]
): AdvisoryFinding[] {
  const findings: AdvisoryFinding[] = [];
  for (const { advisory, vulns } of relevant(target, advisories)) {
    for (const vuln of vulns) {
      const inRange = versionInRange(version.version, vuln.range);
      if (inRange === false) continue;
      findings.push({
        uses: target.uses,
        ghsaId: advisory.ghsaId,
        ...(advisory.cveId ? { cveId: advisory.cveId } : {}),
        severity: advisory.severity,
        summary: advisory.summary,
        ...(advisory.url ? { url: advisory.url } : {}),
        range: vuln.range,
        ...(vuln.firstPatched ? { firstPatched: vuln.firstPatched } : {}),
        version: version.version,
        // An unreadable range can't rule the version out: may be affected.
        approximate: version.approximate || inRange === undefined,
        ...(target.path ? { path: target.path } : {})
      });
      break;
    }
  }
  return findings;
}

const RANK: Record<AdvisorySeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  unknown: 0
};

/**
 * `error` for a finding at or above `failOn` (default `high`, so
 * critical/high fail and medium/low warn). An approximate match is always
 * a warning: which release a moving tag points at isn't known.
 */
export function findingLevel(
  finding: AdvisoryFinding,
  failOn: FailOn = 'high'
): 'error' | 'warning' {
  if (finding.approximate) return 'warning';
  return RANK[finding.severity] >= RANK[failOn] ? 'error' : 'warning';
}

/** A one-line description of a finding. */
export function describeFinding(f: AdvisoryFinding): string {
  const id = `${f.ghsaId} (${f.cveId ? `${f.cveId}, ` : ''}${f.severity})`;
  const head = f.approximate
    ? `${f.uses} may be affected by a known security advisory: ${id}`
    : `${f.uses} has a known security advisory: ${id}`;
  const summary = f.summary ? `: ${f.summary.replace(/\.?\s*$/, '.')}` : '.';
  const fix = f.firstPatched
    ? `first patched version: ${f.firstPatched}`
    : 'no patched version yet';
  const nums = parseVersion(f.version)?.nums ?? [];
  const lowerBound = [...nums, 0, 0].slice(0, Math.max(3, nums.length));
  const approx = !f.approximate
    ? ''
    : nums.length > 0 && nums.length < 3
      ? ` ${f.version} is a moving tag whose release could not be determined, so it was compared as ${lowerBound.join('.')}; pin a release tag or SHA to check it exactly.`
      : ' The affected range could not be read.';
  return `${head}${summary} Affected versions: ${f.range}; ${fix}.${approx}${f.url ? ` ${f.url}` : ''}`;
}

/** Findings as `secureci/vulnerable-action` validation errors. */
export function advisoryValidationErrors(
  report: AdvisoryReport,
  failOn?: FailOn
): ValidationError[] {
  return report.findings.map((f) => ({
    path: f.path ?? f.uses,
    message: describeFinding(f),
    severity: findingLevel(f, failOn),
    rule: VULNERABLE_ACTION_RULE
  }));
}

/** One warning line for repositories that weren't checked, if any. */
export function describeUnchecked(
  unchecked: AdvisoryReport['unchecked']
): string | undefined {
  if (unchecked.length === 0) return undefined;
  const byReason = new Map<string, string[]>();
  for (const { repo, reason } of unchecked) {
    byReason.set(reason, [...(byReason.get(reason) ?? []), repo]);
  }
  return `Security advisories not checked for ${[...byReason]
    .map(([reason, repos]) => `${repos.join(', ')} (${reason})`)
    .join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Fetching and caching

/** Where advisory responses are cached. */
export function getAdvisoryCacheDir(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return path.join(homeDir, '.secureci', 'advisories');
}

const NAME = /^[A-Za-z0-9_.-]+$/;
const validName = (name: string) =>
  NAME.test(name) && name !== '.' && name !== '..';

interface CacheFile {
  api: string;
  fetchedAt: number;
  advisories: Advisory[];
}

export interface AdvisoryLookup {
  advisories?: Advisory[];
  /** Answered from a cache older than the TTL. */
  stale?: boolean;
  /** Why the API couldn't answer. */
  error?: string;
}

function describeError(error: unknown, authenticated: boolean): string {
  const status = (error as { status?: number }).status;
  if (status === 403 || status === 429) {
    return `HTTP ${status}: rate-limited or forbidden${authenticated ? '' : '; set GITHUB_TOKEN for a higher rate limit'}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The advisories naming `owner/repo` in the actions ecosystem, cached per
 * repository for `ttlMs` (default 24h). Offline, the cache is used at any
 * age. If the API fails, a stale cache is used when there is one.
 * Only the first page (100 advisories) is read.
 */
export async function fetchRepoAdvisories(
  owner: string,
  repo: string,
  options: AdvisoryOptions = {}
): Promise<AdvisoryLookup> {
  if (!validName(owner) || !validName(repo)) return { advisories: [] };
  const api = (options.apiUrl ?? defaultApiUrl()).replace(/\/+$/, '');
  const now = (options.now ?? Date.now)();
  const ttl = options.ttlMs ?? ADVISORY_TTL_MS;
  const file = path.join(
    options.cacheDir ?? getAdvisoryCacheDir(),
    owner.toLowerCase(),
    `${repo.toLowerCase()}.json`
  );

  let cached: CacheFile | undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as CacheFile;
    if (data.api === api && Array.isArray(data.advisories)) cached = data;
  } catch {
    cached = undefined;
  }
  const isStale = cached ? now - cached.fetchedAt >= ttl : false;
  if (cached && !isStale) return { advisories: cached.advisories };
  if (options.offline) {
    return cached
      ? { advisories: cached.advisories, stale: true }
      : { error: 'offline and not cached' };
  }

  const httpGet =
    options.httpGet ??
    ((url: string, headers: Record<string, string>) =>
      getText(url, headers, ADVISORY_TIMEOUT_MS));
  const query = new URLSearchParams({
    ecosystem: 'actions',
    affects: `${owner}/${repo}`,
    per_page: '100'
  });
  const url = `${api}/advisories?${query}`;
  const headers = (token: string | null) => ({
    'User-Agent': 'secureci-cli',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  });
  let token = options.token === undefined ? githubToken() : options.token;
  let body: string;
  try {
    try {
      body = await httpGet(url, headers(token));
    } catch (error) {
      // A rejected token shouldn't block public advisories.
      if (!token || (error as { status?: number }).status !== 401) throw error;
      token = null;
      body = await httpGet(url, headers(null));
    }
    const advisories = parseAdvisories(JSON.parse(body));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry: CacheFile = { api, fetchedAt: now, advisories };
    fs.writeFileSync(file, JSON.stringify(entry, null, 2));
    return { advisories };
  } catch (error) {
    const message = describeError(error, !!token);
    return cached
      ? { advisories: cached.advisories, stale: true, error: message }
      : { error: message };
  }
}

/**
 * Checks references against the advisory database, querying each
 * repository at most once (and listing its tags at most once, only when a
 * version has to be worked out for a repository that has advisories).
 */
export class AdvisoryChecker {
  private readonly lookups = new Map<string, Promise<AdvisoryLookup>>();
  private readonly tags = new Map<
    string,
    Promise<Map<string, string> | undefined>
  >();

  constructor(private readonly options: AdvisoryOptions = {}) {}

  private lookup(owner: string, repo: string): Promise<AdvisoryLookup> {
    const key = `${owner}/${repo}`.toLowerCase();
    let found = this.lookups.get(key);
    if (!found) {
      this.options.onLookup?.(`${owner}/${repo}`);
      found = fetchRepoAdvisories(owner, repo, this.options);
      this.lookups.set(key, found);
    }
    return found;
  }

  private tagsOf(
    owner: string,
    repo: string
  ): Promise<Map<string, string> | undefined> {
    const key = `${owner}/${repo}`.toLowerCase();
    let found = this.tags.get(key);
    if (!found) {
      const list =
        this.options.listTags ??
        ((o: string, r: string) =>
          lsRemoteTags(`${serverUrl()}/${o}/${r}.git`));
      found = list(owner, repo);
      this.tags.set(key, found);
    }
    return found;
  }

  async check(targets: AdvisoryTarget[]): Promise<AdvisoryReport> {
    const report: AdvisoryReport = {
      findings: [],
      unknownVersions: [],
      unchecked: [],
      stale: []
    };
    const seen = new Set<string>();
    for (const target of targets) {
      const repoName = `${target.owner}/${target.repo}`;
      const key = repoName.toLowerCase();
      const result = await this.lookup(target.owner, target.repo);
      if (!seen.has(key)) {
        seen.add(key);
        if (!result.advisories) {
          report.unchecked.push({
            repo: repoName,
            reason: result.error as string
          });
        } else if (result.stale) {
          report.stale.push(repoName);
        }
      }
      const advisories = relevant(target, result.advisories ?? []);
      if (advisories.length === 0) continue;

      let version = chooseVersion(target.ref, target.sha);
      if ((!version || version.approximate) && !this.options.offline) {
        const tags = await this.tagsOf(target.owner, target.repo);
        version = chooseVersion(target.ref, target.sha, tags);
      }
      if (!version) {
        report.unknownVersions.push({
          uses: target.uses,
          advisories: advisories.map((a) => a.advisory.ghsaId)
        });
        continue;
      }
      report.findings.push(
        ...matchAdvisories(target, version, result.advisories ?? [])
      );
    }
    return report;
  }
}

// ---------------------------------------------------------------------------
// Wiring for `inventory` and `validate`

/** Distinct remote references as targets (first path kept). */
export function targetsFromReferences(refs: Reference[]): AdvisoryTarget[] {
  const byUses = new Map<string, AdvisoryTarget>();
  for (const ref of refs) {
    if (ref.kind !== 'action' && ref.kind !== 'reusable-workflow') continue;
    if (!ref.owner || !ref.repo || byUses.has(ref.uses)) continue;
    byUses.set(ref.uses, {
      uses: ref.uses,
      owner: ref.owner,
      repo: ref.repo,
      subpath: ref.subpath,
      ref: ref.ref,
      sha: ref.pinned ? ref.ref?.toLowerCase() : undefined,
      path: ref.path
    });
  }
  return [...byUses.values()];
}

/** Inventory actions as targets, with the commit each resolved to. */
export function targetsFromInventory(
  actions: InventoryAction[]
): AdvisoryTarget[] {
  return actions.map((a) => ({
    uses: a.uses,
    owner: a.owner,
    repo: a.repo,
    subpath: a.subpath,
    ref: a.ref,
    sha: a.resolvedSha,
    path: a.paths[0]
  }));
}

export interface ReportLine {
  level: 'error' | 'warn' | 'info';
  /** A finding, or a note about what couldn't be checked. */
  kind: 'finding' | 'note';
  text: string;
}

/** Human-readable lines for a report, with the level to log each at. */
export function describeReport(
  report: AdvisoryReport,
  failOn?: FailOn
): ReportLine[] {
  const lines: ReportLine[] = report.findings.map((f) => ({
    level: findingLevel(f, failOn) === 'error' ? 'error' : 'warn',
    kind: 'finding',
    text: describeFinding(f)
  }));
  for (const u of report.unknownVersions) {
    const name = u.uses.slice(0, u.uses.lastIndexOf('@'));
    const repo = name.split('/').slice(0, 2).join('/');
    lines.push({
      level: 'info',
      kind: 'note',
      text: `${u.uses}: unknown version (the commit is not at a release tag), so advisories ${u.advisories.join(', ')} for ${repo} could not be checked against it.`
    });
  }
  const unchecked = describeUnchecked(report.unchecked);
  if (unchecked) lines.push({ level: 'warn', kind: 'note', text: unchecked });
  if (report.stale.length > 0) {
    lines.push({
      level: 'warn',
      kind: 'note',
      text: `Used cached security advisories older than 24h for ${report.stale.join(', ')} (they could not be refreshed).`
    });
  }
  return lines;
}

/**
 * Check a workflow's (or composite action's) own `uses:` references,
 * including those in local composite actions and reusable workflows it
 * calls, as `secureci/vulnerable-action` validation errors.
 */
export async function checkFileAdvisories(
  parsed: ParsedFile,
  checker: AdvisoryChecker,
  failOn?: FailOn
): Promise<{ errors: ValidationError[]; report: AdvisoryReport }> {
  const report = await checker.check(
    targetsFromReferences(collectReferences(parsed))
  );
  return { errors: advisoryValidationErrors(report, failOn), report };
}

/** Several reports as one, each reference and repository listed once. */
export function mergeReports(reports: AdvisoryReport[]): AdvisoryReport {
  const merged: AdvisoryReport = {
    findings: [],
    unknownVersions: [],
    unchecked: [],
    stale: []
  };
  for (const r of reports) {
    merged.findings.push(...r.findings);
    for (const u of r.unknownVersions) {
      if (!merged.unknownVersions.some((m) => m.uses === u.uses)) {
        merged.unknownVersions.push(u);
      }
    }
    for (const u of r.unchecked) {
      if (!merged.unchecked.some((m) => m.repo === u.repo)) {
        merged.unchecked.push(u);
      }
    }
    for (const s of r.stale) {
      if (!merged.stale.includes(s)) merged.stale.push(s);
    }
  }
  return merged;
}
