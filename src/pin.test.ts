import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findUsesSites,
  isPinAllowed,
  localPinTargets,
  pinContent
} from './pin';

const fixtures = path.join(__dirname, '..', 'test', 'fixtures', 'pin');
const sha = (digit: string | number): string => String(digit).repeat(40);

/** A resolver backed by a map; anything else is unresolvable. */
function resolver(map: Record<string, string>) {
  return vi.fn(async (uses: string) => map[uses]);
}

const lines = (...l: string[]): string => l.join('\n') + '\n';
const steps = (...l: string[]): string =>
  lines(
    'on: push',
    'jobs:',
    '  a:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    ...l
  );

describe('pinContent', () => {
  const fixtureMap = {
    'actions/checkout@v4': sha(1),
    'actions/setup-node@v4.1.0': sha(2),
    'github/codeql-action/init@v3': sha(3),
    'org/scan@v1': sha(4),
    'org/deploy@main': sha(5),
    'actions/upload-artifact@v4': sha(6),
    'org/workflows/.github/workflows/build.yml@v1': sha(7),
    'trusted/tool@v2': sha(8)
  };

  it('rewrites the fixture in place, keeping formatting and comments', async () => {
    const input = fs.readFileSync(path.join(fixtures, 'workflow.yml'), 'utf8');
    const expected = fs.readFileSync(
      path.join(fixtures, 'workflow.pinned.yml'),
      'utf8'
    );

    const result = await pinContent(input, resolver(fixtureMap), {
      allow: ['trusted']
    });

    expect(result.content).toBe(expected);
    expect(
      result.changes.map((c) => [c.line, c.uses, c.sha.slice(0, 1), c.ref])
    ).toEqual([
      [9, 'actions/checkout@v4', '1', 'v4'],
      [11, 'actions/setup-node@v4.1.0', '2', 'v4.1.0'],
      [14, 'github/codeql-action/init@v3', '3', 'v3'],
      [15, 'org/scan@v1', '4', 'v1'],
      [16, 'org/deploy@main', '5', 'main'],
      [22, 'actions/upload-artifact@v4', '6', 'v4'],
      [26, 'org/workflows/.github/workflows/build.yml@v1', '7', 'v1']
    ]);
    expect(result.changes[0].pinned).toBe(`actions/checkout@${sha(1)}`);
    expect(result.allowed).toEqual([{ line: 20, uses: 'trusted/tool@v2' }]);
    expect(result.unresolved).toEqual([
      {
        line: 21,
        uses: 'gone/away@v1',
        reason: 'could not be resolved to a commit'
      }
    ]);
  });

  it('is idempotent: an already-pinned file has nothing to change', async () => {
    const pinned = fs.readFileSync(
      path.join(fixtures, 'workflow.pinned.yml'),
      'utf8'
    );
    const resolve = resolver({ 'gone/away@v1': sha(9) });
    const result = await pinContent(pinned, resolve, { allow: ['trusted'] });
    expect(result.changes.map((c) => c.uses)).toEqual(['gone/away@v1']);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('resolves each distinct reference once', async () => {
    const resolve = resolver({ 'a/b@v1': sha(1) });
    const result = await pinContent(
      steps('      - uses: a/b@v1', '      - uses: a/b@v1'),
      resolve
    );
    expect(result.changes).toHaveLength(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['# v3', `# v4`],
    ['# v3.2.1', '# v4'],
    ['#v3', '# v4'],
    ['# tag=v3', '# v4'],
    ['# pin @v3', '# v4'],
    ['# 3.2', '# v4'],
    ['# v4', '# v4'],
    ['# v3 pinned for node16', '# v4 pinned for node16'],
    ['# keep this', '# v4 - keep this'],
    ['#', '# v4']
  ])('replaces an old version comment %j sensibly', async (old, updated) => {
    const result = await pinContent(
      steps(`      - uses: a/b@v4    ${old}`),
      resolver({ 'a/b@v4': sha(1) })
    );
    expect(result.content).toBe(
      steps(`      - uses: a/b@${sha(1)}    ${updated}`)
    );
  });

  it('treats a comment naming the old ref as a version comment', async () => {
    const result = await pinContent(
      steps('      - uses: a/b@main # main'),
      resolver({ 'a/b@main': sha(1) })
    );
    expect(result.content).toBe(steps(`      - uses: a/b@${sha(1)} # main`));
  });

  it('keeps CRLF line endings', async () => {
    const crlf = steps('      - uses: a/b@v1 # v0', '      - uses: c/d@v2')
      .split('\n')
      .join('\r\n');
    const result = await pinContent(
      crlf,
      resolver({ 'a/b@v1': sha(1), 'c/d@v2': sha(2) })
    );
    expect(result.content).toBe(
      steps(
        `      - uses: a/b@${sha(1)} # v1`,
        `      - uses: c/d@${sha(2)} # v2`
      )
        .split('\n')
        .join('\r\n')
    );
  });

  it('pins a value written on the line after its key', async () => {
    const result = await pinContent(
      steps('      - uses:', '          a/b@v1'),
      resolver({ 'a/b@v1': sha(1) })
    );
    expect(result.content).toBe(
      steps('      - uses:', `          a/b@${sha(1)} # v1`)
    );
  });

  it('adds no comment when several flow steps share a line', async () => {
    const result = await pinContent(
      steps('      [{uses: a/b@v1}, {uses: c/d@v2}] # list'),
      resolver({ 'a/b@v1': sha(1), 'c/d@v2': sha(2) })
    );
    expect(result.content).toBe(
      steps(`      [{uses: a/b@${sha(1)}}, {uses: c/d@${sha(2)}}] # list`)
    );
  });

  it('finds a comment after other flow content, ignoring # inside quotes', async () => {
    const result = await pinContent(
      steps('      - {uses: a/b@v1, with: {x: \'a #b\', y: "\\" #c"}} # v0'),
      resolver({ 'a/b@v1': sha(1) })
    );
    expect(result.content).toBe(
      steps(
        `      - {uses: a/b@${sha(1)}, with: {x: 'a #b', y: "\\" #c"}} # v1`
      )
    );
  });

  it('pins the last line of a file with no trailing newline', async () => {
    const result = await pinContent(
      steps('      - uses: a/b@v1').trimEnd(),
      resolver({ 'a/b@v1': sha(1) })
    );
    expect(result.content).toBe(
      steps(`      - uses: a/b@${sha(1)} # v1`).trimEnd()
    );
  });

  it('reports references without a ref, or written as block scalars', async () => {
    const result = await pinContent(
      steps(
        '      - uses: actions/checkout',
        '      - uses: >-',
        '          a/b@v1',
        '      - uses: noslash@v1'
      ),
      resolver({ 'a/b@v1': sha(1) })
    );
    expect(result.changes).toEqual([]);
    expect(result.unresolved).toEqual([
      {
        line: 6,
        uses: 'actions/checkout',
        reason: 'is not an owner/repo@ref reference'
      },
      {
        line: 7,
        uses: 'a/b@v1',
        reason: 'is written as a block scalar; pin it by hand'
      },
      {
        line: 9,
        uses: 'noslash@v1',
        reason: 'is not an owner/repo@ref reference'
      }
    ]);
  });

  it('throws on a file that is not valid YAML', async () => {
    await expect(pinContent('jobs: [unclosed\n', resolver({}))).rejects.toThrow(
      /not valid YAML/
    );
  });

  it('returns the content unchanged when nothing is pinned', async () => {
    const input = steps('      - uses: ./local', '      - uses: docker://x:1');
    const resolve = resolver({});
    const result = await pinContent(input, resolve);
    expect(result.content).toBe(input);
    expect(result.changes).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('findUsesSites', () => {
  it('finds step and job uses, not `uses:` text in scripts or inputs', () => {
    const sites = findUsesSites(
      lines(
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: |',
        '          uses: not/this@v1',
        '      - uses: x/y@v1',
        '        with:',
        '          uses: nor/this@v1',
        '  b:',
        '    uses: o/r/.github/workflows/w.yml@v2',
        '    with:',
        '      uses: not/either@v1'
      )
    );
    expect(sites.map((s) => [s.line, s.uses])).toEqual([
      [8, 'x/y@v1'],
      [12, 'o/r/.github/workflows/w.yml@v2']
    ]);
  });

  it("finds a composite action's step uses", () => {
    const sites = findUsesSites(
      lines(
        'name: a',
        'description: d',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: x/y@v1'
      )
    );
    expect(sites.map((s) => s.uses)).toEqual(['x/y@v1']);
  });

  it('tolerates files without jobs or steps', () => {
    expect(findUsesSites('name: x\n')).toEqual([]);
    expect(findUsesSites('jobs:\n  a: 1\n  b:\n    steps: 2\n')).toEqual([]);
    expect(findUsesSites('')).toEqual([]);
  });
});

describe('isPinAllowed', () => {
  it('matches an owner or an exact action name, case-insensitively (like the contract check)', () => {
    expect(isPinAllowed('Org/repo@v1', ['org'])).toBe(true);
    expect(isPinAllowed('org/repo@v1', ['ORG/Repo'])).toBe(true);
    expect(isPinAllowed('org/repo/sub@v1', ['org/repo/sub'])).toBe(true);
    expect(isPinAllowed('org/repo/sub@v1', ['org/repo'])).toBe(false);
    expect(isPinAllowed('other/repo@v1', ['org'])).toBe(false);
    expect(isPinAllowed('other/repo@v1', [])).toBe(false);
    expect(isPinAllowed('org/repo', ['org'])).toBe(true);
  });
});

describe('localPinTargets', () => {
  let root: string;
  const write = (rel: string, content: string): string => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const composite = (...uses: string[]): string =>
    lines(
      'name: a',
      'description: d',
      'runs:',
      '  using: composite',
      '  steps:',
      ...uses.map((u) => `    - uses: ${u}`)
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-pin-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('adds the local actions and reusable workflows a workflow uses, recursively', () => {
    const ci = write(
      '.github/workflows/ci.yml',
      lines(
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: ./.github/actions/outer',
        '      - uses: ./.github/actions/missing',
        '      - uses: actions/checkout@v4',
        '  b:',
        '    uses: ./.github/workflows/reuse.yml'
      )
    );
    const reuse = write(
      '.github/workflows/reuse.yml',
      lines(
        'on: workflow_call',
        'jobs:',
        '  c:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: ./.github/actions/outer'
      )
    );
    const outer = write(
      '.github/actions/outer/action.yml',
      composite('./.github/actions/inner', 'x/y@v1')
    );
    const inner = write(
      '.github/actions/inner/action.yaml',
      composite('./.github/actions/outer')
    );
    write('.github/workflows/broken.yml', 'jobs: [unclosed\n');

    expect(localPinTargets([ci])).toEqual([ci, outer, inner, reuse]);
    // Files already listed aren't repeated, and unreadable files are kept
    // (so the caller reports them) but not followed.
    const broken = path.join(root, '.github/workflows/broken.yml');
    expect(localPinTargets([ci, reuse, broken])).toEqual([
      ci,
      reuse,
      broken,
      outer,
      inner
    ]);
  });
});
