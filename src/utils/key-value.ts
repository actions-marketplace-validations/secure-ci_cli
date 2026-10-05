export interface ParseKeyValueOptions {
  /** Omit the raw argument from error messages (e.g. for secrets). */
  redact?: boolean;
}

/**
 * Parse repeatable `key=value` CLI arguments (`--input`, `--secret`) into a
 * record. Splits on the first `=` only, so values may themselves contain `=`
 * (e.g. base64-padded tokens). Empty values are allowed; a missing `=` or an
 * empty key is an error.
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
