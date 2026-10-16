import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  collectReferences,
  buildInventory,
  addTransitive,
  diffLock,
  type Lockfile
} from './inventory';
import type { ParsedWorkflow } from './types';

function workflow(root: string, jobs: unknown): ParsedWorkflow {
  const file = { name: 'WF', on: 'push', jobs };
  const p = path.join(root, '.github/workflows/ci.yml');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, YAML.stringify(file));
  return { type: 'workflow', path: p, file } as ParsedWorkflow;
}

describe('collectReferences', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-inv-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('classifies remote, local, docker and reusable references with call paths', () => {
    fs.mkdirSync(path.join(root, '.github/actions/local'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.github/actions/local/action.yml'),
      YAML.stringify({
        name: 'l',
        description: 'd',
        runs: { using: 'composite', steps: [{ uses: 'nested/action@v2' }] }
      })
    );
    const wf = workflow(root, {
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: 'actions/checkout@v4' },
          { uses: 'org/scan@' + 'a'.repeat(40) },
          { uses: './.github/actions/local' },
          { uses: 'docker://alpine:3.20' },
          { run: 'echo hi' }
        ]
      }
    });

    const refs = collectReferences(wf);
    const byUses = Object.fromEntries(refs.map((r) => [r.uses, r]));

    expect(byUses['actions/checkout@v4']).toMatchObject({
      kind: 'action',
      owner: 'actions',
      repo: 'checkout',
      ref: 'v4',
      pinned: false
    });
    expect(byUses['org/scan@' + 'a'.repeat(40)].pinned).toBe(true);
    expect(byUses['docker://alpine:3.20'].kind).toBe('docker');
    expect(byUses['./.github/actions/local'].kind).toBe('local');
    // Recurses into the local composite action.
    expect(byUses['nested/action@v2']).toMatchObject({ kind: 'action' });
    expect(byUses['nested/action@v2'].path).toContain(
      '> ./.github/actions/local >'
    );
  });

  it('recurses into local reusable workflows', () => {
    fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.github/workflows/reuse.yml'),
      YAML.stringify({
        name: 'r',
        on: 'workflow_call',
        jobs: {
          ship: {
            'runs-on': 'ubuntu-latest',
            steps: [{ uses: 'deploy/action@v1' }]
          }
        }
      })
    );
    const wf = workflow(root, {
      call: { uses: './.github/workflows/reuse.yml' }
    });
    const refs = collectReferences(wf);
    expect(refs.map((r) => r.uses)).toContain('deploy/action@v1');
  });
});

describe('buildInventory', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-inv-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('resolves each remote action to a commit SHA via the resolver', async () => {
    const wf = workflow(root, {
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: 'actions/checkout@v4' },
          { uses: 'org/scan@' + 'b'.repeat(40) }
        ]
      }
    });
    const resolver = async (uses: string) =>
      uses.startsWith('actions/checkout') ? 'c'.repeat(40) : undefined;
    const inv = await buildInventory(wf, resolver);

    const checkout = inv.actions.find((a) => a.owner === 'actions')!;
    expect(checkout.resolvedSha).toBe('c'.repeat(40));
    expect(checkout.pinned).toBe(false);
    // An already-pinned SHA is its own resolved value.
    const scan = inv.actions.find((a) => a.owner === 'org')!;
    expect(scan.resolvedSha).toBe('b'.repeat(40));
    // Docker/local are listed but not SHA-resolved.
    expect(inv.workflow).toContain('ci.yml');
  });
});

describe('addTransitive', () => {
  let root: string;
  const sha = (c: string) => c.repeat(40);
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-trans-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** Write a fetched repository's file under root/<name>/ and return it. */
  const repoFile = (name: string, rel: string, content: unknown): string => {
    const file = path.join(root, name, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, YAML.stringify(content));
    return file;
  };
  const composite = (steps: unknown[]) => ({
    name: 'c',
    description: 'd',
    runs: { using: 'composite', steps }
  });

  it('follows remote composite actions and reusable workflows, recording via', async () => {
    const files: Record<string, string> = {
      [`org/wrap@${sha('1')}`]: repoFile(
        'wrap',
        'action.yml',
        composite([
          { uses: 'org/inner@v2' },
          { uses: './local-in-remote' },
          { run: 'echo' }
        ])
      ),
      [`org/inner@${sha('2')}`]: repoFile(
        'inner',
        'action.yml',
        composite([{ uses: `org/leaf@${sha('3')}` }])
      ),
      [`org/leaf@${sha('3')}`]: repoFile('leaf', 'action.yml', {
        name: 'n',
        description: 'd',
        runs: { using: 'node20', main: 'index.js' }
      }),
      [`org/flows/.github/workflows/ship.yml@${sha('4')}`]: repoFile(
        'flows',
        '.github/workflows/ship.yml',
        {
          name: 's',
          on: 'workflow_call',
          jobs: {
            nested: { uses: './.github/workflows/sub.yml' },
            go: { 'runs-on': 'x', steps: [{ uses: 'org/inner@v2' }] }
          }
        }
      )
    };
    // A local reusable workflow inside a remote one is read from that repo.
    repoFile('flows', '.github/workflows/sub.yml', {
      name: 'sub',
      on: 'workflow_call',
      jobs: { j: { 'runs-on': 'x', steps: [{ uses: 'org/deep@v5' }] } }
    });

    const wf = workflow(root, {
      a: {
        'runs-on': 'x',
        steps: [{ uses: 'org/wrap@v1' }]
      },
      b: { uses: 'org/flows/.github/workflows/ship.yml@v4' }
    });
    const resolved: Record<string, string> = {
      'org/wrap@v1': sha('1'),
      'org/flows/.github/workflows/ship.yml@v4': sha('4'),
      'org/inner@v2': sha('2'),
      'org/deep@v5': sha('5')
    };
    const resolveSha = async (uses: string) => resolved[uses];
    const fetched: string[] = [];
    const queued: string[] = [];
    const inv = await buildInventory(wf, resolveSha);
    const all = await addTransitive(inv.actions, {
      resolveSha,
      onQueue: (a) => queued.push(a.uses),
      fetch: async (uses) => {
        fetched.push(uses);
        return files[uses] ?? null;
      },
      warn: () => {}
    });
    const by = Object.fromEntries(all.map((a) => [a.uses, a]));

    // Fetched at the locked commit, never by tag.
    expect(fetched).toContain(`org/wrap@${sha('1')}`);
    expect(fetched).toContain(
      `org/flows/.github/workflows/ship.yml@${sha('4')}`
    );
    expect(by['org/wrap@v1'].via).toBeUndefined();
    expect(by['org/inner@v2']).toMatchObject({
      kind: 'action',
      resolvedSha: sha('2'),
      via: ['org/flows/.github/workflows/ship.yml@v4', 'org/wrap@v1']
    });
    expect(by['org/inner@v2'].paths).toContain('org/wrap@v1 > steps[0]');
    expect(by[`org/leaf@${sha('3')}`]).toMatchObject({
      resolvedSha: sha('3'),
      via: ['org/inner@v2']
    });
    expect(by['org/deep@v5'].via).toEqual([
      'org/flows/.github/workflows/ship.yml@v4'
    ]);
    // Each new dependency is announced once, as it's queued.
    expect(queued.sort()).toEqual(
      ['org/deep@v5', 'org/inner@v2', `org/leaf@${sha('3')}`].sort()
    );
    // Local actions inside a remote action aren't followed or listed.
    expect(Object.keys(by).some((u) => u.startsWith('.'))).toBe(false);
  });

  it('warns and carries on when a dependency cannot be fetched', async () => {
    const wf = workflow(root, {
      a: { 'runs-on': 'x', steps: [{ uses: `org/gone@${sha('9')}` }] }
    });
    const warnings: string[] = [];
    const inv = await buildInventory(wf);
    const all = await addTransitive(inv.actions, {
      fetch: async () => null,
      warn: (m) => warnings.push(m)
    });
    expect(all.map((a) => a.uses)).toEqual([`org/gone@${sha('9')}`]);
    expect(warnings[0]).toMatch(/org\/gone@9+.*not listed/);
  });

  it('stops at a cycle', async () => {
    const files: Record<string, string> = {
      [`org/a@${sha('a')}`]: repoFile(
        'a',
        'action.yml',
        composite([{ uses: `org/b@${sha('b')}` }])
      ),
      [`org/b@${sha('b')}`]: repoFile(
        'b',
        'action.yml',
        composite([{ uses: `org/a@${sha('a')}` }])
      )
    };
    const wf = workflow(root, {
      a: { 'runs-on': 'x', steps: [{ uses: `org/a@${sha('a')}` }] }
    });
    const inv = await buildInventory(wf);
    const all = await addTransitive(inv.actions, {
      fetch: async (u) => files[u] ?? null,
      warn: () => {}
    });
    expect(all.map((a) => a.uses).sort()).toEqual([
      `org/a@${sha('a')}`,
      `org/b@${sha('b')}`
    ]);
  });
});

describe('diffLock', () => {
  const lock: Lockfile = {
    version: 2,
    actions: {
      'actions/checkout@v4': { commit: 'a'.repeat(40), ownerId: 1, repoId: 2 },
      'org/old@v1': { commit: 'd'.repeat(40) }
    }
  };

  it('reports drift, additions and removals', () => {
    const current = {
      'actions/checkout@v4': { commit: 'e'.repeat(40) }, // moved
      'org/new@v2': { commit: 'f'.repeat(40) } // added
      // org/old@v1 removed
    };
    const diff = diffLock(current, lock);
    expect(diff.drifted).toEqual([
      {
        uses: 'actions/checkout@v4',
        from: 'a'.repeat(40),
        to: 'e'.repeat(40)
      }
    ]);
    expect(diff.added).toEqual(['org/new@v2']);
    expect(diff.removed).toEqual(['org/old@v1']);
    expect(diff.identity).toEqual([]);
    expect(diff.changed).toBe(true);
  });

  it('is clean when nothing moved', () => {
    const diff = diffLock(
      {
        'actions/checkout@v4': {
          commit: 'a'.repeat(40),
          ownerId: 1,
          repoId: 2
        },
        'org/old@v1': { commit: 'd'.repeat(40) }
      },
      lock
    );
    expect(diff.changed).toBe(false);
    expect(diff.drifted).toEqual([]);
  });

  it('reports a repository whose identity changed, at the same commit', () => {
    const diff = diffLock(
      {
        'actions/checkout@v4': {
          commit: 'a'.repeat(40),
          ownerId: 9,
          repoId: 3
        },
        'org/old@v1': { commit: 'd'.repeat(40) }
      },
      lock
    );
    expect(diff.identity).toEqual([
      { uses: 'actions/checkout@v4', field: 'owner_id', from: 1, to: 9 },
      { uses: 'actions/checkout@v4', field: 'repo_id', from: 2, to: 3 }
    ]);
    expect(diff.changed).toBe(true);
  });

  it('skips the identity check when either side has no identity', () => {
    const diff = diffLock(
      {
        'actions/checkout@v4': { commit: 'a'.repeat(40) },
        'org/old@v1': { commit: 'd'.repeat(40), ownerId: 5, repoId: 6 }
      },
      lock
    );
    expect(diff.identity).toEqual([]);
    expect(diff.changed).toBe(false);
  });
});
