import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import type { ShaResolver } from './inventory';
import { repositoryRoot } from './utils/repository';

/** A `uses:` value in a workflow or action file, and where it is. */
export interface UsesSite {
  /** 1-based line of the value. */
  line: number;
  uses: string;
  /** Offsets of the value's source text (quotes included). */
  start: number;
  end: number;
  style: 'plain' | 'single' | 'double' | 'block';
}

/** A reference rewritten to a commit SHA. */
export interface PinChange {
  line: number;
  /** The reference as it was, e.g. `actions/checkout@v4`. */
  uses: string;
  /** The tag or branch it pointed at, kept in a trailing comment. */
  ref: string;
  sha: string;
  /** The new reference, `owner/repo@<sha>`. */
  pinned: string;
}

export interface PinProblem {
  line: number;
  uses: string;
  reason: string;
}

export interface PinResult {
  /** The file's text with every resolvable reference pinned. */
  content: string;
  changes: PinChange[];
  /** References that should be pinned but couldn't be (left unchanged). */
  unresolved: PinProblem[];
  /** References left on their tag because a contract's pins.allow lists them. */
  allowed: Array<{ line: number; uses: string }>;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * Every `uses:` a runner reads: `jobs.<id>.uses` (reusable workflows),
 * `jobs.<id>.steps[*].uses` and a composite action's `runs.steps[*].uses`.
 * Read from the YAML syntax tree, so `uses:` inside a script or an input
 * isn't mistaken for one, with source offsets for in-place edits.
 */
export function findUsesSites(content: string): UsesSite[] {
  const doc = parseYaml(content);
  const root = doc.contents;
  if (!YAML.isMap(root)) return [];
  const nodes: YAML.Scalar[] = [];

  const usesOf = (node: unknown): void => {
    if (!YAML.isMap(node)) return;
    const uses = node.get('uses', true);
    if (YAML.isScalar(uses)) nodes.push(uses);
  };
  const stepsOf = (node: unknown): void => {
    if (!YAML.isMap(node)) return;
    const steps = node.get('steps', true);
    if (YAML.isSeq(steps)) steps.items.forEach(usesOf);
  };

  const jobs = root.get('jobs', true);
  if (YAML.isMap(jobs)) {
    for (const pair of jobs.items) {
      usesOf(pair.value);
      stepsOf(pair.value);
    }
  }
  stepsOf(root.get('runs', true));

  return nodes
    .filter((node) => node.range && typeof node.value === 'string')
    .map((node) => {
      const [start, end] = node.range as YAML.Range;
      return {
        line: content.slice(0, start).split('\n').length,
        uses: node.value as string,
        start,
        end,
        style: scalarStyle(node.type)
      };
    })
    .sort((a, b) => a.start - b.start);
}

function parseYaml(content: string): YAML.Document {
  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) {
    throw new Error(`File is not valid YAML: ${doc.errors[0].message}`);
  }
  return doc;
}

function scalarStyle(type: YAML.Scalar['type']): UsesSite['style'] {
  if (type === 'QUOTE_SINGLE') return 'single';
  if (type === 'QUOTE_DOUBLE') return 'double';
  if (type === 'BLOCK_LITERAL' || type === 'BLOCK_FOLDED') return 'block';
  return 'plain';
}

/**
 * Whether a contract's `pins.allow` exempts a reference from pinning: an
 * owner, or the exact action name, case-insensitively for owner and repo.
 * This mirrors the contract's own pins check, so `pin` never leaves a
 * reference on a tag that `validate --contract` would then reject.
 */
export function isPinAllowed(uses: string, allow: string[]): boolean {
  const at = uses.lastIndexOf('@');
  const name = normalizeName(at === -1 ? uses : uses.slice(0, at));
  const owner = name.split('/')[0];
  const allowed = new Set(allow.map(normalizeName));
  return allowed.has(name) || allowed.has(owner);
}

function normalizeName(name: string): string {
  const parts = name.split('/');
  return [
    ...parts.slice(0, 2).map((p) => p.toLowerCase()),
    ...parts.slice(2)
  ].join('/');
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Pin every remote `uses:` reference in a workflow or action file to the
 * commit SHA `resolve` returns, keeping the tag in a trailing comment
 * (`owner/repo@<sha> # v4`) so Dependabot and Renovate can still update
 * it. The text is edited in place (only the value and its comment change),
 * never re-serialised, so formatting and other comments survive.
 *
 * Left alone: local (`./`) and `docker://` references, references already
 * pinned to a full SHA, and those `allow` exempts. A reference that can't
 * be resolved is reported in `unresolved` and not changed.
 */
export async function pinContent(
  content: string,
  resolve: ShaResolver,
  options: { allow?: string[] } = {}
): Promise<PinResult> {
  const sites = findUsesSites(content);
  const result: PinResult = {
    content,
    changes: [],
    unresolved: [],
    allowed: []
  };
  const lineCounts = new Map<number, number>();
  sites.forEach((s) =>
    lineCounts.set(s.line, (lineCounts.get(s.line) ?? 0) + 1)
  );
  const resolved = new Map<string, Promise<string | undefined>>();
  const edits: Edit[] = [];

  for (const site of sites) {
    const { uses, line } = site;
    if (/^(\.\.?\/|docker:\/\/)/.test(uses)) continue;
    const at = uses.lastIndexOf('@');
    const name = at === -1 ? '' : uses.slice(0, at);
    const ref = uses.slice(at + 1);
    const parts = name.split('/');
    if (at === -1 || !ref || parts.length < 2 || parts.some((p) => !p)) {
      result.unresolved.push({
        line,
        uses,
        reason: 'is not an owner/repo@ref reference'
      });
      continue;
    }
    if (FULL_SHA.test(ref)) continue;
    if (isPinAllowed(uses, options.allow ?? [])) {
      result.allowed.push({ line, uses });
      continue;
    }
    if (site.style === 'block') {
      result.unresolved.push({
        line,
        uses,
        reason: 'is written as a block scalar; pin it by hand'
      });
      continue;
    }

    if (!resolved.has(uses)) resolved.set(uses, resolve(uses));
    const sha = (await resolved.get(uses))?.toLowerCase();
    if (!sha || !FULL_SHA.test(sha)) {
      result.unresolved.push({
        line,
        uses,
        reason: 'could not be resolved to a commit'
      });
      continue;
    }

    const pinned = `${name}@${sha}`;
    const quote =
      site.style === 'single' ? "'" : site.style === 'double' ? '"' : '';
    edits.push({
      start: site.start,
      end: site.end,
      text: `${quote}${pinned}${quote}`
    });
    // Several references on one line (a flow sequence) can't each have a
    // trailing comment, so none is written rather than a wrong one.
    if (lineCounts.get(line) === 1) {
      edits.push(commentEdit(content, site.end, ref));
    }
    result.changes.push({ line, uses, ref, sha, pinned });
  }

  result.content = edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (text, e) => text.slice(0, e.start) + e.text + text.slice(e.end),
      content
    );
  return result;
}

/**
 * The edit that leaves `# <ref>` as the comment of the line a value ends
 * on: an old version comment is replaced, any other comment kept after
 * the ref, and with no comment one is added at the end of the line.
 */
function commentEdit(content: string, valueEnd: number, ref: string): Edit {
  let lineEnd = content.indexOf('\n', valueEnd);
  if (lineEnd === -1) lineEnd = content.length;
  if (content[lineEnd - 1] === '\r') lineEnd--;
  const tail = content.slice(valueEnd, lineEnd);
  const hash = commentStart(tail);
  if (hash === -1) {
    const at = valueEnd + tail.trimEnd().length;
    return { start: at, end: at, text: ` # ${ref}` };
  }
  const body = tail.slice(hash + 1).trim();
  return {
    start: valueEnd + hash,
    end: lineEnd,
    text: `# ${ref}${commentRest(body, ref)}`
  };
}

/** Where a YAML comment starts in the rest of a line, or -1. */
function commentStart(tail: string): number {
  let quote: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && i > 0 && /\s/.test(tail[i - 1])) {
      return i;
    }
  }
  return -1;
}

/**
 * What to keep of an existing comment after the new `# <ref>`: the text
 * after an old version (`v3`, `3.2.1`, `tag=v3`, `pin @v3`, or the old
 * ref itself), else the whole comment.
 */
function commentRest(body: string, ref: string): string {
  if (!body) return '';
  const version = body.match(
    /^(?:tag\s*=\s*|pin\s*@?\s*)?@?v?\d[\w.+-]*(.*)$/i
  );
  const rest = version
    ? version[1]
    : body === ref || body.startsWith(`${ref} `)
      ? body.slice(ref.length)
      : undefined;
  if (rest === undefined) return ` - ${body}`;
  return rest.trim() ? ` ${rest.trim()}` : '';
}

/**
 * The given files plus the local composite actions (`./path`) and local
 * reusable workflows they use, recursively, so a whole repository is
 * pinned in one go. `./` resolves against the repository root, as on
 * GitHub. Files are listed once; one that can't be read is kept (for the
 * caller to report) but not followed.
 */
export function localPinTargets(files: string[]): string[] {
  const seen = new Set(files.map((f) => path.resolve(f)));
  const result = [...files];

  const follow = (file: string, root: string): void => {
    let sites: UsesSite[];
    try {
      sites = findUsesSites(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    for (const { uses } of sites) {
      if (!uses.startsWith('./') && !uses.startsWith('../')) continue;
      const target = path.resolve(root, uses);
      const local = [
        target,
        ...['action.yml', 'action.yaml'].map((n) => path.join(target, n))
      ].find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (!local || seen.has(local)) continue;
      seen.add(local);
      result.push(local);
      follow(local, root);
    }
  };

  for (const file of files) follow(file, repositoryRoot(file));
  return result;
}
