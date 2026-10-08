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

/**
 * Render a validation result for `--format`. `json` is a compact object;
 * `sarif` is a SARIF 2.1.0 log suitable for GitHub code scanning (upload
 * with `github/codeql-action/upload-sarif`).
 */
export function formatValidation(
  file: string,
  result: ValidationResult,
  format: Exclude<ReportFormat, 'text'>
): string {
  if (format === 'json') {
    return JSON.stringify(
      {
        file,
        valid: result.valid,
        errors: result.errors.map((e) => ({
          path: e.path,
          message: e.message,
          severity: e.severity
        }))
      },
      null,
      2
    );
  }

  const results: SarifResult[] = result.errors.map((error) => ({
    ruleId: ruleIdFor(error),
    level: error.severity === 'warning' ? 'warning' : 'error',
    message: { text: `${error.path}: ${error.message}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: file } } }]
  }));

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'secureci',
              informationUri: 'https://www.secure-ci.dev',
              rules: Object.entries(RULES).map(([id, name]) => ({
                id,
                name
              }))
            }
          },
          results
        }
      ]
    },
    null,
    2
  );
}
