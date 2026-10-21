// Build the standalone `secureci` binary for this machine's OS and CPU with
// Node's single executable applications (SEA): bundle dist/ into one script,
// turn it into a SEA blob, and inject the blob into a copy of the Node binary
// running this script. Run `npm run build` first.
//
// Usage: node scripts/build-sea.mjs [output path]
//   default output: build/sea/secureci (secureci.exe on Windows)
//
// The binary embeds whichever Node.js runs this script; CI uses the version
// in package.json's volta.node, like every other job.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from './bundle.mjs';

// From the Node.js SEA docs: the fuse postject flips to enable the blob.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = path.join(root, 'build', 'sea');
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const output = path.resolve(
  process.argv[2] ?? path.join(workDir, isWindows ? 'secureci.exe' : 'secureci')
);

const run = (command, args) =>
  execFileSync(command, args, { stdio: 'inherit', cwd: root });

const entry = path.join(root, 'dist', 'cli.js');
if (!fs.existsSync(entry)) {
  console.error('dist/cli.js not found: run `npm run build` first.');
  process.exit(1);
}
const { version } = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8')
);

fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(path.dirname(output), { recursive: true });

// 1. One CommonJS file, with the version embedded (package.json isn't on
//    disk next to a standalone binary).
const main = path.join(workDir, 'secureci.cjs');
fs.writeFileSync(main, bundle(entry, { version }));

// 2. The SEA preparation blob. No code cache or snapshot: they tie the blob
//    to the exact Node build, and startup is fast enough without them.
const blob = path.join(workDir, 'sea-prep.blob');
const config = path.join(workDir, 'sea-config.json');
fs.writeFileSync(
  config,
  JSON.stringify(
    {
      main,
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false
    },
    null,
    2
  )
);
run(process.execPath, ['--experimental-sea-config', config]);

// 3. A copy of this Node binary, with the blob injected. macOS binaries
//    must be re-signed (ad hoc) after injection or the OS kills them.
fs.copyFileSync(process.execPath, output);
fs.chmodSync(output, 0o755);
if (isMac) run('codesign', ['--remove-signature', output]);

const { inject } = await import('postject');
await inject(output, 'NODE_SEA_BLOB', fs.readFileSync(blob), {
  sentinelFuse: SEA_FUSE,
  machoSegmentName: isMac ? 'NODE_SEA' : undefined
});

if (isMac) run('codesign', ['--sign', '-', output]);

const size = (fs.statSync(output).size / 1024 / 1024).toFixed(1);
console.log(
  `Built ${path.relative(root, output)} (${size} MB, Node ${process.version}, secureci ${version})`
);
