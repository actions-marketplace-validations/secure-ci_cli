// Bundle the CLI's CommonJS output (dist/) and its dependencies into one
// file, as Node's single executable applications (SEA) need: inside a SEA,
// `require` only loads built-in modules.
//
// Deliberately tiny instead of a bundler dependency (this is a security
// tool; see CONTRIBUTING.md): it inlines every statically `require()`d file,
// resolving each with Node's own resolver from the requiring file, wraps
// each in a CommonJS function wrapper, and leaves built-ins to the real
// `require`. It refuses anything it can't resolve statically, so a missing
// module fails the build, not the binary at run time.
//
// Usage: node scripts/bundle.mjs <entry.js> <out.cjs> [version]

import { builtinModules, createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRE_CALL = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
const ANY_REQUIRE_CALL = /\brequire\s*\(/g;

function isBuiltin(spec) {
  return spec.startsWith('node:') || builtinModules.includes(spec);
}

/** Module source as the body of a CommonJS wrapper function. */
function moduleBody(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    return `module.exports = ${JSON.stringify(JSON.parse(source))};`;
  }
  return source
    .replace(/^#!.*/, '')
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
}

/**
 * Bundle `entry` and everything it requires into one CommonJS script.
 * `version`, when given, is defined as `__SECURECI_VERSION__` for the
 * bundled modules (see src/version.ts).
 */
export function bundle(entry, { version } = {}) {
  const ids = new Map();
  const modules = [];

  const add = (file) => {
    if (ids.has(file)) return ids.get(file);
    const id = modules.length;
    ids.set(file, id);
    const module = { file, body: moduleBody(file), deps: {} };
    modules.push(module);

    const literal = [...module.body.matchAll(REQUIRE_CALL)];
    const all = module.body.match(ANY_REQUIRE_CALL) || [];
    if (all.length !== literal.length) {
      throw new Error(`dynamic require() the bundler can't follow in ${file}`);
    }
    const resolve = createRequire(file).resolve;
    for (const [, , spec] of literal) {
      if (isBuiltin(spec) || spec in module.deps) continue;
      let resolved;
      try {
        resolved = resolve(spec);
      } catch (error) {
        throw new Error(`cannot resolve require("${spec}") in ${file}`, {
          cause: error
        });
      }
      module.deps[spec] = add(resolved);
    }
    return id;
  };
  add(path.resolve(entry));

  const table = modules
    .map(
      ({ file, body, deps }, id) =>
        `// ${path.relative(process.cwd(), file).replace(/\\/g, '/')}\n` +
        `${id}: [function (exports, require, module, __filename, __dirname) {\n${body}\n}, ${JSON.stringify(deps)}]`
    )
    .join(',\n');

  return `${version === undefined ? '' : `var __SECURECI_VERSION__ = ${JSON.stringify(version)};\n`}(function (modules, nativeRequire, filename, dirname) {
  var cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = (cache[id] = { exports: {} });
    var deps = modules[id][1];
    var localRequire = function (spec) {
      return Object.prototype.hasOwnProperty.call(deps, spec)
        ? load(deps[spec])
        : nativeRequire(spec);
    };
    modules[id][0].call(module.exports, module.exports, localRequire, module, filename, dirname);
    return module.exports;
  }
  load(0);
})({
${table}
}, require, __filename, __dirname);
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [entry, out, version] = process.argv.slice(2);
  if (!entry || !out) {
    console.error(
      'usage: node scripts/bundle.mjs <entry.js> <out.cjs> [version]'
    );
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bundle(entry, { version }));
}
