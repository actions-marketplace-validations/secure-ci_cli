import * as fs from 'fs';
import * as path from 'path';
import { ORG_SCAN_SCRIPT } from './org-scan-script';

/**
 * `secureci org scan`: run org-scan.sh (embedded as ORG_SCAN_SCRIPT) to scan
 * every workflow in an organisation for a SecureCI supply-chain assessment. The script is
 * the source of truth, so what people read before running it is exactly
 * what runs; this module only writes it to a temporary file and starts bash.
 */

export interface OrgScanOptions {
  repos?: string;
  out?: string;
  contract?: string;
  includeForks?: boolean;
}

/** The script's arguments for `org` and the command's options. */
export function orgScanArgs(org: string, options: OrgScanOptions): string[] {
  const args: string[] = [];
  if (options.repos) args.push('--repos', options.repos);
  if (options.out) args.push('--out', options.out);
  if (options.contract) args.push('--contract', options.contract);
  if (options.includeForks) args.push('--include-forks');
  return [...args, org];
}

/**
 * How the script should run this same CLI: the standalone binary directly,
 * or node with the CLI's entry file when installed with npm.
 */
export function orgScanEnv(self: {
  sea: boolean;
  execPath: string;
  entry?: string;
}): Record<string, string> {
  if (self.sea || !self.entry) return { SECURECI: self.execPath };
  return { SECURECI: self.execPath, SECURECI_ENTRY: self.entry };
}

/** A started child process: only the events runOrgScan listens to. */
interface Child {
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

export interface OrgScanDeps {
  spawn: (
    command: string,
    args: string[],
    options: { stdio: 'inherit'; env: NodeJS.ProcessEnv }
  ) => Child;
  /** Where to create the temporary directory for the script. */
  tmpdir: () => string;
  sea: boolean;
  execPath: string;
  entry?: string;
  env: NodeJS.ProcessEnv;
}

/** Run the scan; resolves with the script's exit status. */
export async function runOrgScan(
  org: string,
  options: OrgScanOptions,
  deps: OrgScanDeps
): Promise<number> {
  const dir = fs.mkdtempSync(path.join(deps.tmpdir(), 'secureci-org-scan-'));
  const script = path.join(dir, 'org-scan.sh');
  try {
    fs.writeFileSync(script, ORG_SCAN_SCRIPT, { mode: 0o700 });
    const env = { ...deps.env, ...orgScanEnv(deps) };
    return await new Promise<number>((resolve, reject) => {
      const child = deps.spawn('bash', [script, ...orgScanArgs(org, options)], {
        stdio: 'inherit',
        env
      });
      child.on('error', (error) => {
        reject(
          error.code === 'ENOENT'
            ? new Error(
                '`secureci org scan` needs bash. On Windows, run it from Git Bash or WSL.'
              )
            : error
        );
      });
      child.on('close', (code) => resolve(code ?? 1));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
