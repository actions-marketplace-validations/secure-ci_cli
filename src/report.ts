import type { ValidationError, ValidationResult } from './types';

/** Output formats for `secureci validate`. */
export type ReportFormat = 'text' | 'json' | 'sarif';

/** A SARIF rule id per error, so code-scanning can group findings. */
function ruleIdFor(error: ValidationError): string {
  if (/^required\[|^forbidden\[/.test(error.path)) return 'secureci/contract';
  if (/\.if$|\bif:/.test(error.path)) return 'secureci/expression';
  return 'secureci/validation';
}

const RULES: Record<string, string> = {
  'secureci/validation': 'Workflow or action structure',
  'secureci/contract': 'Pipeline contract',
  'secureci/expression': 'Expression / if: condition'
};

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning';
  message: { text: string };
  locations: Array<{
    physicalLocation: { artifactLocation: { uri: string } };
  }>;
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
  format: Exclude<ReportFormat, 'text'>
): string {
  if (format === 'json') {
    const body =
      entries.length === 1
        ? jsonForFile(entries[0])
        : {
            valid: entries.every((e) => e.result.valid),
            files: entries.map(jsonForFile)
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
          results: entries.flatMap(sarifResults)
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
