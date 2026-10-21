import * as fs from 'fs';
import { parseKeyValuePairs } from './key-value';
import { logger } from './logger';

/**
 * Names accepted as keys. Hyphens are allowed because input names may
 * contain them; everything else follows shell variable naming.
 */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: '\n',
  r: '\r',
  t: '\t',
  '"': '"',
  '\\': '\\'
};

/**
 * Parse `.env`-style content into a record (see DOCS.md for the format):
 * `KEY=value` lines, an optional `export ` prefix, `#` comments, single
 * quotes (literal) and double quotes (escapes, may span lines). Later keys
 * win. Errors name `fileName:line` but never echo the line, since it may
 * hold a secret.
 */
export function parseEnvFile(
  content: string,
  fileName: string
): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');

  let next = 0;
  while (next < lines.length) {
    const lineNo = next + 1;
    const line = lines[next++];
    const fail = (reason: string): never => {
      throw new Error(`${fileName}:${lineNo}: ${reason}`);
    };

    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const body = trimmed.replace(/^export\s+/, '');
    const separator = body.indexOf('=');
    if (separator === -1) fail('expected KEY=value');
    const key = body.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) fail('invalid variable name');

    const raw = body.slice(separator + 1);
    const rest = raw.trimStart();
    let value: string;
    let tail = '';

    if (rest.startsWith("'")) {
      const close = rest.indexOf("'", 1);
      if (close === -1) fail('unterminated single-quoted value');
      value = rest.slice(1, close);
      tail = rest.slice(close + 1);
    } else if (rest.startsWith('"')) {
      let text = rest;
      let pos = 1;
      value = '';
      for (;;) {
        if (pos >= text.length) {
          if (next >= lines.length) fail('unterminated double-quoted value');
          value += '\n';
          text = lines[next++];
          pos = 0;
          continue;
        }
        const char = text[pos];
        if (char === '\\' && pos + 1 < text.length) {
          const escaped = text[pos + 1];
          value += DOUBLE_QUOTE_ESCAPES[escaped] ?? `\\${escaped}`;
          pos += 2;
          continue;
        }
        if (char === '"') {
          tail = text.slice(pos + 1);
          break;
        }
        value += char;
        pos++;
      }
    } else {
      // A `#` starts a comment only after whitespace, so `a#b` stays intact.
      const comment = raw.search(/\s#/);
      value = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    }

    const after = tail.trim();
    if (after !== '' && !after.startsWith('#')) {
      fail('unexpected text after closing quote');
    }
    result[key] = value;
  }

  return result;
}

export interface ReadEnvFilesOptions {
  /** The flag the files came from, for error messages (e.g. `--env-file`). */
  flagName: string;
  /** Warn when the file is readable by group/others. */
  secret?: boolean;
  /** Override for tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Read and merge env files in order; later files override earlier ones. */
export function readEnvFiles(
  files: string[],
  options: ReadEnvFilesOptions
): Record<string, string> {
  const platform = options.platform ?? process.platform;
  const result: Record<string, string> = {};
  for (const file of files) {
    if (!fs.existsSync(file)) {
      throw new Error(`${options.flagName}: file not found: ${file}`);
    }
    // POSIX modes don't describe Windows ACLs, so the check would mislead.
    if (options.secret && platform !== 'win32') {
      const mode = fs.statSync(file).mode & 0o777;
      if (mode & 0o077) {
        logger.warn(
          `Secret file ${file} is readable by other users (mode ${mode.toString(8).padStart(4, '0')}). Restrict it with: chmod 600 ${file}`
        );
      }
    }
    Object.assign(result, parseEnvFile(fs.readFileSync(file, 'utf-8'), file));
  }
  return result;
}

export interface LoadKeyValuesOptions {
  /** e.g. `--secret` */
  flagName: string;
  /** e.g. `--secret-file`; minus the `--` it is also the config key. */
  fileFlagName: string;
  /** Values of the repeatable `key=value` flag. */
  pairs?: string | string[];
  /** Values of the repeatable file flag. */
  files?: string[];
  /** Default files from the config file, used when `files` is empty. */
  configFiles?: string | string[];
  /** Redact flag errors and check file permissions. */
  secret?: boolean;
  /** Allow a bare `NAME` flag value, read from this environment. */
  fromEnv?: NodeJS.ProcessEnv;
}

function configFileList(
  value: string | string[] | undefined,
  key: string
): string[] {
  if (value === undefined) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value;
  }
  throw new Error(
    `Invalid ${key} in config: expected a file path or a list of file paths`
  );
}

/**
 * Resolve one family of run values (env, secrets, inputs or vars): files
 * from the flag (or, without one, from the config), merged in order, then
 * explicit `key=value` flags on top.
 */
export function loadKeyValues(
  options: LoadKeyValuesOptions
): Record<string, string> {
  const configKey = options.fileFlagName.replace(/^--/, '');
  const defaults = configFileList(options.configFiles, configKey);
  const files =
    options.files && options.files.length > 0 ? options.files : defaults;
  return {
    ...readEnvFiles(files, {
      flagName: options.fileFlagName,
      secret: options.secret
    }),
    ...parseKeyValuePairs(options.pairs, options.flagName, {
      redact: options.secret,
      fromEnv: options.fromEnv
    })
  };
}
