import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  builtinActionFor,
  collectFiles,
  containerFileSystem,
  downloadArtifact,
  hostFileSystem,
  runCacheAction,
  uploadArtifact
} from './builtin-actions';

describe('builtin-actions', () => {
  let work: string;

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-builtin-'));
    for (const file of [
      'dist/a.txt',
      'dist/sub/b.txt',
      'dist/.hidden/c.txt',
      'docs/d.md'
    ]) {
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), file);
    }
  });
  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  it('recognises the built-in actions', () => {
    expect(builtinActionFor('actions/upload-artifact@v4')).toBe(
      'upload-artifact'
    );
    expect(builtinActionFor('actions/download-artifact@v3')).toBe(
      'download-artifact'
    );
    expect(builtinActionFor('actions/cache@v4')).toBe('cache');
    expect(builtinActionFor('actions/cache/restore@v4')).toBe('cache-restore');
    expect(builtinActionFor('actions/cache/save@v4')).toBe('cache-save');
    expect(builtinActionFor('actions/checkout@v4')).toBeUndefined();
    expect(builtinActionFor('someone/cache@v4')).toBeUndefined();
  });

  describe('collectFiles', () => {
    const rel = (root: string, files: Array<{ logical: string }>) =>
      files.map((f) => path.relative(root, f.logical)).sort();

    it('uses a directory as the root and skips hidden files by default', async () => {
      const { root, files } = await collectFiles(hostFileSystem(work), 'dist', {
        includeHidden: false
      });
      expect(root).toBe(path.join(work, 'dist'));
      expect(rel(root, files)).toEqual(['a.txt', path.join('sub', 'b.txt')]);
    });

    it('includes hidden files when asked', async () => {
      const { root, files } = await collectFiles(hostFileSystem(work), 'dist', {
        includeHidden: true
      });
      expect(rel(root, files)).toContain(path.join('.hidden', 'c.txt'));
    });

    it('roots multiple paths at their common ancestor, with exclusions', async () => {
      const { root, files } = await collectFiles(
        hostFileSystem(work),
        'dist/**/*.txt\ndocs/d.md\n!dist/sub/**',
        { includeHidden: false }
      );
      expect(root).toBe(work);
      expect(rel(root, files)).toEqual([
        path.join('dist', 'a.txt'),
        path.join('docs', 'd.md')
      ]);
    });

    it('uses the parent directory as the root of a single file', async () => {
      const { root, files } = await collectFiles(
        hostFileSystem(work),
        'docs/d.md',
        {
          includeHidden: false
        }
      );
      expect(root).toBe(path.join(work, 'docs'));
      expect(rel(root, files)).toEqual(['d.md']);
    });
  });

  describe('containerFileSystem', () => {
    /** A fake container whose filesystem is a host directory. */
    function fakeContainer() {
      const containerRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'secureci-ctr-')
      );
      const inside = (p: string) => path.join(containerRoot, p);
      const calls: string[] = [];
      const fsys = containerFileSystem({
        workspace: '/secureci-workspace',
        hostWorkspace: work,
        home: '/root',
        copyFrom: async (from, to) => {
          calls.push(`from ${from}`);
          if (!fs.existsSync(inside(from))) return false;
          fs.cpSync(inside(from), to, { recursive: true });
          return true;
        },
        copyTo: async (from, to) => {
          calls.push(`to ${to}`);
          fs.cpSync(from, inside(to), { recursive: true });
          return true;
        },
        mkdir: async (dir) => {
          fs.mkdirSync(inside(dir), { recursive: true });
        }
      });
      return { fsys, inside, calls, containerRoot };
    }

    it('reads the workspace directly and copies other paths out', async () => {
      const { fsys, inside, calls, containerRoot } = fakeContainer();
      fs.mkdirSync(inside('/root/.tool'), { recursive: true });
      fs.writeFileSync(inside('/root/.tool/t'), 't');
      try {
        const { files } = await collectFiles(fsys, 'dist/a.txt\n~/.tool', {
          includeHidden: true
        });
        expect(files.map((f) => f.logical).sort()).toEqual([
          '/root/.tool/t',
          '/secureci-workspace/dist/a.txt'
        ]);
        expect(calls).toEqual(['from /root/.tool']);
        expect(await fsys.readable('/nope')).toBeNull();
      } finally {
        fsys.cleanup();
        fs.rmSync(containerRoot, { recursive: true, force: true });
      }
    });

    it('writes outside the workspace by copying into the container', async () => {
      const { fsys, inside, containerRoot } = fakeContainer();
      try {
        await fsys.writeInto('/tmp/out', (dir) =>
          fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
        );
        await fsys.writeInto('/secureci-workspace/w', (dir) =>
          fs.writeFileSync(path.join(dir, 'y.txt'), 'y')
        );
        expect(fs.readFileSync(inside('/tmp/out/x.txt'), 'utf8')).toBe('x');
        expect(fs.readFileSync(path.join(work, 'w', 'y.txt'), 'utf8')).toBe(
          'y'
        );
      } finally {
        fsys.cleanup();
        fs.rmSync(containerRoot, { recursive: true, force: true });
      }
    });
  });

  describe('container steps cannot reach the host through symlinks', () => {
    let home: string;
    let outside: string;
    let savedHome: string | undefined;
    const fsysFor = () =>
      containerFileSystem({
        workspace: '/secureci-workspace',
        hostWorkspace: work,
        home: '/root',
        copyFrom: async () => false,
        copyTo: async () => false,
        mkdir: async () => undefined
      });

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-symhome-'));
      outside = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-outside-'));
      fs.writeFileSync(path.join(outside, 'id_rsa'), 'HOST-SECRET');
      savedHome = process.env.HOME;
      process.env.HOME = home;
    });
    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    const stored = () => {
      const store = path.join(home, '.secureci');
      const found: string[] = [];
      const walk = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else found.push(fs.readFileSync(full, 'utf8'));
        }
      };
      walk(store);
      return found.join('\n');
    };

    for (const [label, setup, pattern] of [
      [
        'a directory symlink',
        () => fs.symlinkSync(outside, path.join(work, 'leak')),
        'leak'
      ],
      [
        'a file symlink',
        () =>
          fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(work, 'key')),
        'key'
      ],
      [
        'a symlinked parent',
        () => fs.symlinkSync(outside, path.join(work, 'up')),
        'up/id_rsa'
      ],
      [
        'a glob under a symlink',
        () => fs.symlinkSync(outside, path.join(work, 'g')),
        'g/**'
      ]
    ] as const) {
      it(`upload-artifact does not read host files via ${label}`, async () => {
        setup();
        const result = await uploadArtifact(
          fsysFor(),
          { name: 'a', path: pattern, 'if-no-files-found': 'error' },
          'run1'
        );
        expect(result.success).toBe(false);
        expect(stored()).not.toContain('HOST-SECRET');
      });

      it(`cache save does not read host files via ${label}`, async () => {
        setup();
        await runCacheAction(
          'cache-save',
          fsysFor(),
          { key: 'k', path: pattern },
          'o/r'
        );
        expect(stored()).not.toContain('HOST-SECRET');
      });
    }

    it('still uploads symlinks that stay inside the workspace', async () => {
      fs.symlinkSync('dist', path.join(work, 'alias'));
      const result = await uploadArtifact(
        fsysFor(),
        { name: 'a', path: 'alias/a.txt' },
        'run1'
      );
      expect(result.success).toBe(true);
    });

    it('download-artifact does not write through symlinks to the host', async () => {
      fs.mkdirSync(path.join(work, 'pay', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(work, 'pay', 'x.txt'), 'PWN-FILE');
      fs.writeFileSync(path.join(work, 'pay', 'sub', 'y.txt'), 'PWN-DIR');
      expect(
        (await uploadArtifact(fsysFor(), { name: 'p', path: 'pay' }, 'run1'))
          .success
      ).toBe(true);

      fs.mkdirSync(path.join(work, 'out'));
      fs.symlinkSync(
        path.join(outside, 'id_rsa'),
        path.join(work, 'out', 'x.txt')
      );
      fs.symlinkSync(outside, path.join(work, 'out', 'sub'));
      const result = await downloadArtifact(
        fsysFor(),
        { name: 'p', path: 'out' },
        'run1'
      );
      expect(result.success).toBe(true);
      expect(fs.readdirSync(outside)).toEqual(['id_rsa']);
      expect(fs.readFileSync(path.join(outside, 'id_rsa'), 'utf8')).toBe(
        'HOST-SECRET'
      );
      // The symlinks were replaced by the artifact's real files.
      expect(fs.readFileSync(path.join(work, 'out', 'x.txt'), 'utf8')).toBe(
        'PWN-FILE'
      );
      expect(fs.lstatSync(path.join(work, 'out', 'sub')).isDirectory()).toBe(
        true
      );
    });

    it.skipIf(process.platform === 'win32')(
      'keeps file modes when writing into the workspace',
      async () => {
        fs.mkdirSync(path.join(work, 'bin'));
        fs.writeFileSync(path.join(work, 'bin', 'tool'), '#!/bin/sh\n');
        fs.chmodSync(path.join(work, 'bin', 'tool'), 0o755);
        await uploadArtifact(fsysFor(), { name: 'b', path: 'bin' }, 'run1');
        await downloadArtifact(fsysFor(), { name: 'b', path: 'got' }, 'run1');
        expect(fs.statSync(path.join(work, 'got', 'tool')).mode & 0o777).toBe(
          0o755
        );
      }
    );

    it('download-artifact refuses a destination that leaves the workspace', async () => {
      fs.mkdirSync(path.join(work, 'pay'));
      fs.writeFileSync(path.join(work, 'pay', 'x.txt'), 'PWN');
      await uploadArtifact(fsysFor(), { name: 'p', path: 'pay' }, 'run1');
      fs.symlinkSync(outside, path.join(work, 'out'));
      await expect(
        downloadArtifact(fsysFor(), { name: 'p', path: 'out/deeper' }, 'run1')
      ).rejects.toThrow(/outside the workspace/);
      await expect(
        downloadArtifact(fsysFor(), { name: 'p', path: 'out' }, 'run1')
      ).rejects.toThrow(/outside the workspace/);
      expect(fs.readdirSync(outside)).toEqual(['id_rsa']);
    });
  });

  describe('artifact name is confined to the store (no path traversal)', () => {
    let home: string;
    let savedHome: string | undefined;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-arthome-'));
      savedHome = process.env.HOME;
      process.env.HOME = home;
      fs.writeFileSync(path.join(work, 'dist', 'a.txt'), 'payload');
    });
    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    for (const name of [
      '../../../escape',
      '..',
      'sub/../../escape',
      '/abs/evil',
      'a/b',
      'a\\\\b'
    ]) {
      it(`rejects upload-artifact name ${JSON.stringify(name)}`, async () => {
        const before = fs.existsSync(path.join(home, '.ssh'))
          ? fs.readdirSync(path.join(home, '.ssh'))
          : null;
        const result = await uploadArtifact(
          hostFileSystem(work),
          { name, path: 'dist/a.txt' },
          'run1'
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/[Ii]nvalid artifact name/);
        // Nothing was written outside the per-run store.
        const store = path.join(home, '.secureci', 'artifacts', 'run1');
        const leaked = path.resolve(store, name);
        expect(
          leaked.startsWith(store + path.sep) || !fs.existsSync(leaked)
        ).toBe(true);
        expect(
          before
            ? fs.readdirSync(path.join(home, '.ssh'))
            : fs.existsSync(path.join(home, '.ssh'))
        ).toEqual(before ?? false);
      });

      it(`rejects download-artifact name ${JSON.stringify(name)}`, async () => {
        const result = await downloadArtifact(
          hostFileSystem(work),
          { name, path: 'out' },
          'run1'
        );
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/[Ii]nvalid artifact name|not found/);
      });
    }

    it('still accepts a normal artifact name', async () => {
      const result = await uploadArtifact(
        hostFileSystem(work),
        { name: 'my-bundle.v2', path: 'dist/a.txt' },
        'run1'
      );
      expect(result.success).toBe(true);
    });
  });

  describe('concurrent jobs (#49)', () => {
    let home: string;
    let savedHome: string | undefined;
    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-cchome-'));
      savedHome = process.env.HOME;
      process.env.HOME = home;
    });
    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      fs.rmSync(home, { recursive: true, force: true });
    });

    it('lets two jobs save the same cache key at once', async () => {
      const save = () =>
        runCacheAction(
          'cache-save',
          hostFileSystem(work),
          { key: 'deps-1', path: 'dist' },
          'owner/repo'
        );
      const results = await Promise.all([save(), save()]);
      expect(results.map((r) => r.success)).toEqual([true, true]);
      const restored = await runCacheAction(
        'cache-restore',
        hostFileSystem(work),
        { key: 'deps-1', path: 'dist', 'lookup-only': 'true' },
        'owner/repo'
      );
      expect(restored.outputs?.['cache-hit']).toBe('true');
      // No staging directories are left behind.
      const leftovers = (dir: string): string[] =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .flatMap((e) =>
            e.isDirectory()
              ? [
                  ...(e.name.includes('.tmp-') ? [e.name] : []),
                  ...leftovers(path.join(dir, e.name))
                ]
              : []
          );
      expect(leftovers(path.join(home, '.secureci'))).toEqual([]);
    });
  });
});
