import * as fs from 'fs';

/** A contract fetched from another repository. */
export interface RemoteContract {
  /** The reference as given: `owner/repo/path/to/contract.yml@ref`. */
  uses: string;
  ref: string;
  /** The commit the ref resolved to; undefined if it couldn't be resolved. */
  commit?: string;
  /** Whether `ref` is a full commit SHA. */
  pinned: boolean;
}

export interface ContractSource {
  /** Local path to read the contract from. */
  file: string;
  remote?: RemoteContract;
}

export interface ContractSourceDeps {
  /** Download `owner/repo/path@ref` and return its local path, or null. */
  fetchFile: (uses: string) => Promise<string | null>;
  /** Resolve `owner/repo/path@ref` to a commit SHA. */
  resolveSha: (uses: string) => Promise<string | undefined>;
  warn: (message: string) => void;
}

// owner/repo/path/to/file@ref: the same form as a remote reusable workflow.
const REMOTE_CONTRACT = /^[^/.][^/]*\/[^/@]+\/[^@]+@([^@]+)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Where to read `--contract` from. An existing local file always wins;
 * otherwise `owner/repo/path@ref` is fetched like a remote reusable workflow.
 * A ref that isn't a commit SHA can change under you, so it warns.
 */
export async function resolveContractSource(
  value: string,
  deps: ContractSourceDeps
): Promise<ContractSource> {
  if (fs.existsSync(value)) return { file: value };

  const match = REMOTE_CONTRACT.exec(value);
  if (!match) throw new Error(`Contract file not found: ${value}`);
  const ref = match[1];
  const pinned = FULL_SHA.test(ref);

  if (!pinned) {
    deps.warn(
      `Contract ${value} uses the moving ref "${ref}": its owner can change the standard without a change in this repository. Pin it to a commit SHA to control when it changes.`
    );
  }

  const file = await deps.fetchFile(value);
  if (!file) throw new Error(`Could not fetch contract ${value}`);

  const commit = pinned ? ref : await deps.resolveSha(value);
  return { file, remote: { uses: value, ref, commit, pinned } };
}
