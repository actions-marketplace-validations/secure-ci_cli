import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveContractSource } from './contract-source';

describe('resolveContractSource', () => {
  let dir: string;
  let warnings: string[];
  let fetched: string[];
  const sha = 'c'.repeat(40);

  const deps = (
    over: Partial<Parameters<typeof resolveContractSource>[1]> = {}
  ) => ({
    fetchFile: async (uses: string) => {
      fetched.push(uses);
      const file = path.join(dir, 'fetched.yml');
      fs.writeFileSync(file, 'required: []\n');
      return file;
    },
    resolveSha: async () => sha,
    warn: (message: string) => warnings.push(message),
    ...over
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-contract-src-'));
    warnings = [];
    fetched = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('uses a local file as is', async () => {
    const local = path.join(dir, 'standard.yml');
    fs.writeFileSync(local, 'required: []\n');
    expect(await resolveContractSource(local, deps())).toEqual({
      file: local
    });
    expect(fetched).toEqual([]);
  });

  it('prefers an existing local file even if its name looks like a ref', async () => {
    const local = path.join(dir, 'org', 'repo', 'standard.yml@v1');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, 'required: []\n');
    expect((await resolveContractSource(local, deps())).remote).toBeUndefined();
    expect(fetched).toEqual([]);
  });

  it('fetches owner/repo/path@sha without a warning', async () => {
    const uses = `my-org/standards/contracts/standard.yml@${sha}`;
    const src = await resolveContractSource(uses, deps());
    expect(fetched).toEqual([uses]);
    expect(src.file).toBe(path.join(dir, 'fetched.yml'));
    expect(src.remote).toEqual({ uses, ref: sha, commit: sha, pinned: true });
    expect(warnings).toEqual([]);
  });

  it('warns on a moving ref and records the commit it resolved to', async () => {
    const uses = 'my-org/standards/contracts/standard.yml@v1';
    const src = await resolveContractSource(uses, deps());
    expect(src.remote).toEqual({ uses, ref: 'v1', commit: sha, pinned: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/moving ref "v1".*commit SHA/);
  });

  it('records no commit when a moving ref cannot be resolved (offline)', async () => {
    const uses = 'my-org/standards/contracts/standard.yml@main';
    const src = await resolveContractSource(
      uses,
      deps({ resolveSha: async () => undefined })
    );
    expect(src.remote?.commit).toBeUndefined();
  });

  it('fails clearly when the remote contract cannot be fetched', async () => {
    await expect(
      resolveContractSource(
        'my-org/standards/missing.yml@v1',
        deps({ fetchFile: async () => null })
      )
    ).rejects.toThrow(
      'Could not fetch contract my-org/standards/missing.yml@v1'
    );
  });

  it('keeps the not-found error for a missing local path', async () => {
    await expect(
      resolveContractSource('contracts/nope.yml', deps())
    ).rejects.toThrow('Contract file not found: contracts/nope.yml');
    // owner/repo@ref with no file path is not a contract reference.
    await expect(
      resolveContractSource('my-org/standards@v1', deps())
    ).rejects.toThrow('Contract file not found');
    expect(fetched).toEqual([]);
  });
});
