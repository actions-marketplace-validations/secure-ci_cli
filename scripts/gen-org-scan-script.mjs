// Embed org-scan.sh in src/org-scan-script.ts, so `secureci org scan` can run
// it from the npm package and from the standalone binary (which has no files
// next to it). src/org-scan.test.ts fails when the two are out of sync.
//
// Usage: node scripts/gen-org-scan-script.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = fs.readFileSync(path.join(root, 'org-scan.sh'), 'utf8');

fs.writeFileSync(
  path.join(root, 'src', 'org-scan-script.ts'),
  `// Generated from org-scan.sh by scripts/gen-org-scan-script.mjs; don't edit.\n` +
    `export const ORG_SCAN_SCRIPT = ${JSON.stringify(script)};\n`
);
