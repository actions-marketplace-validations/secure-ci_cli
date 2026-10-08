export interface ParseKeyValueOptions {
  /** Omit the raw argument from error messages (e.g. for secrets). */
  redact?: boolean;
  /**
   * Accept a bare `NAME` and read its value from this environment (used for
   * `--secret NAME`, so the value never appears in the process list).
   */
  fromEnv?: NodeJS.ProcessEnv;
}

/**
 * Parse repeatable `key=value` CLI arguments (`--input`, `--secret`) into a
 * record. Splits on the first `=` only, so values may themselves contain `=`
 * (e.g. base64-padded tokens). Empty values are allowed; a missing `=` (unless
 * `fromEnv` is set) or an empty key is an error.
 */
export function parseKeyValuePairs(
  pairs: string | string[] | undefined,
  flagName: string,
  options: ParseKeyValueOptions = {}
): Record<string, string> {
  const result: Record<string, string> = {};
  if (pairs === undefined) {
    return result;
  }

  for (const pair of Array.isArray(pairs) ? pairs : [pairs]) {
    const separator = pair.indexOf('=');
    if (separator === -1 && options.fromEnv && pair !== '') {
      const value = options.fromEnv[pair];
      if (value === undefined) {
        throw new Error(
          `${flagName} ${pair}: environment variable ${pair} is not set`
        );
      }
      result[pair] = value;
      continue;
    }
    if (separator <= 0) {
      const shown = options.redact ? '' : ` "${pair}"`;
      throw new Error(
        `Invalid ${flagName} argument${shown}: expected key=value`
      );
    }
    result[pair.slice(0, separator)] = pair.slice(separator + 1);
  }

  return result;
}
