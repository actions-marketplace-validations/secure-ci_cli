import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// @ts-expect-error -- plain ESM build script, no type declarations
import { bundle } from './bundle.mjs';

const tmpDirs: string[] = [];
function project(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-bundle-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

/** Bundle `entry`, move the result away from its sources, and run it. */
function runBundled(code: string): string {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-bundled-'));
  tmpDirs.push(out);
  const file = path.join(out, 'bundle.cjs');
  fs.writeFileSync(file, code);
  return execFileSync(process.execPath, [file], { encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('bundle', () => {
  it('inlines relative files, packages and JSON into one runnable file', () => {
    const dir = project({
      'dist/cli.js':
        '#!/usr/bin/env node\n"use strict";\nconst a = require("./lib/a");\nconst pkg = require("dep");\nconst data = require("./data.json");\nconsole.log(a.name, pkg.hello(), data.n);\n//# sourceMappingURL=cli.js.map\n',
      'dist/lib/a.js': 'exports.name = "a";\n',
      'dist/data.json': '{ "n": 42 }\n',
      'node_modules/dep/package.json':
        '{ "name": "dep", "exports": { "require": "./cjs/index.js", "import": "./esm/index.mjs" } }',
      'node_modules/dep/cjs/index.js':
        'const os = require("node:os");\nconst path = require("path");\nmodule.exports = { hello: () => typeof os.platform() + "-" + typeof path.join };\n'
    });
    const code = bundle(path.join(dir, 'dist/cli.js'));
    expect(code.startsWith('#!')).toBe(false);
    expect(code).not.toContain('sourceMappingURL');
    expect(runBundled(code)).toBe('a string-function 42\n');
  });

  it('keeps CommonJS semantics: one instance per module, cycles see partial exports', () => {
    const dir = project({
      'main.js':
        'const a = require("./a");\nconst again = require("./a.js");\nconsole.log(a === again, a.fromB);\n',
      'a.js':
        'exports.early = "early";\nexports.fromB = require("./b").seen;\n',
      'b.js': 'exports.seen = require("./a").early;\n'
    });
    expect(runBundled(bundle(path.join(dir, 'main.js')))).toBe('true early\n');
  });

  it('defines __SECURECI_VERSION__ for the bundled modules', () => {
    const dir = project({
      'main.js':
        'console.log(typeof __SECURECI_VERSION__ === "string" ? __SECURECI_VERSION__ : "none");\n'
    });
    expect(runBundled(bundle(path.join(dir, 'main.js')))).toBe('none\n');
    expect(
      runBundled(bundle(path.join(dir, 'main.js'), { version: '1.2.3' }))
    ).toBe('1.2.3\n');
  });

  it('refuses requires it cannot resolve statically', () => {
    const dir = project({
      'main.js': 'const name = "./x";\nrequire(name);\n'
    });
    expect(() => bundle(path.join(dir, 'main.js'))).toThrow(
      /dynamic require.*main\.js/
    );
  });

  it('reports modules that cannot be found', () => {
    const dir = project({ 'main.js': 'require("./missing");\n' });
    expect(() => bundle(path.join(dir, 'main.js'))).toThrow(/\.\/missing/);
  });
});
