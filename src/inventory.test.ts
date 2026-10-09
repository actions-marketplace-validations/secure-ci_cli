import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import {
  collectReferences,
  buildInventory,
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

describe('diffLock', () => {
  const lock: Lockfile = {
    version: 1,
    actions: {
      'actions/checkout@v4': 'a'.repeat(40),
      'org/old@v1': 'd'.repeat(40)
    }
  };

  it('reports drift, additions and removals', () => {
    const current = {
      'actions/checkout@v4': 'e'.repeat(40), // moved
      'org/new@v2': 'f'.repeat(40) // added
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
    expect(diff.changed).toBe(true);
  });

  it('is clean when nothing moved', () => {
    const diff = diffLock(
      { 'actions/checkout@v4': 'a'.repeat(40), 'org/old@v1': 'd'.repeat(40) },
      lock
    );
    expect(diff.changed).toBe(false);
    expect(diff.drifted).toEqual([]);
  });
});
