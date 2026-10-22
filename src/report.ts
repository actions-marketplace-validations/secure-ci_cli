import type { ValidationError, ValidationResult } from './types';

/** Output formats for `secureci validate`. */
export type ReportFormat = 'text' | 'json' | 'sarif';

/** A SARIF rule id per error, so code-scanning can group findings. */
function ruleIdFor(error: ValidationError): string {
  if (error.rule) return error.rule;
  if (/^required\[|^forbidden\[/.test(error.path)) return 'secureci/contract';
  if (/\.if$|\bif:/.test(error.path)) return 'secureci/expression';
  return 'secureci/validation';
}

const RULES: Record<string, string> = {
  'secureci/validation': 'Workflow or action structure',
  'secureci/contract': 'Pipeline contract',
  'secureci/expression': 'Expression / if: condition',
  'secureci/injection': 'Untrusted input in a shell or script',
  'secureci/permissions': 'GITHUB_TOKEN permissions',
  'secureci/dangerous-trigger': 'Privileged trigger with untrusted code',
  'secureci/vulnerable-action': 'Action with a known security advisory'
};

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning';
  message: { text: string };
  locations: Array<{
    physicalLocation: { artifactLocation: { uri: string } };
  }>;
}

/** The contract a run was checked against, recorded for audit. */
export interface ContractInfo {
  /** Local path or `owner/repo/path@ref` as given to --contract. */
  source: string;
  ref?: string;
  /** Commit the remote contract resolved to. */
  commit?: string;
  pinned?: boolean;
}

export interface ReportMeta {
  contract?: ContractInfo;
}

/** One validated file and its result. */
export interface ReportEntry {
  file: string;
  result: ValidationResult;
}

function jsonForFile(entry: ReportEntry) {
  return {
    file: entry.file,
    valid: entry.result.valid,
    errors: entry.result.errors.map((e) => ({
      path: e.path,
      message: e.message,
      severity: e.severity
    }))
  };
}

function sarifResults(entry: ReportEntry): SarifResult[] {
  return entry.result.errors.map((error) => ({
    ruleId: ruleIdFor(error),
    level: error.severity === 'warning' ? 'warning' : 'error',
    message: { text: `${error.path}: ${error.message}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: entry.file } } }]
  }));
}

/**
 * Render one or more validated files for `--format`. `json` is a compact
 * object (a single file keeps the flat `{ file, valid, errors }` shape; many
 * files become `{ valid, files: [...] }`). `sarif` is one SARIF 2.1.0 run
 * carrying every file's findings, suitable for GitHub code scanning (upload
 * with `github/codeql-action/upload-sarif`).
 */
export function formatReport(
  entries: ReportEntry[],
  format: Exclude<ReportFormat, 'text'>,
  meta: ReportMeta = {}
): string {
  const contract = meta.contract ? { contract: meta.contract } : {};
  if (format === 'json') {
    const body =
      entries.length === 1
        ? { ...jsonForFile(entries[0]), ...contract }
        : {
            valid: entries.every((e) => e.result.valid),
            files: entries.map(jsonForFile),
            ...contract
          };
    return JSON.stringify(body, null, 2);
  }

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'secureci',
              informationUri: 'https://secure-ci.dev',
              rules: Object.entries(RULES).map(([id, name]) => ({ id, name }))
            }
          },
          results: entries.flatMap(sarifResults),
          ...(meta.contract ? { properties: contract } : {})
        }
      ]
    },
    null,
    2
  );
}

/** Render a single validated file (see formatReport). */
export function formatValidation(
  file: string,
  result: ValidationResult,
  format: Exclude<ReportFormat, 'text'>
): string {
  return formatReport([{ file, result }], format);
}
