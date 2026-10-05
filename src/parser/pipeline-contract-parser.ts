import * as fs from 'fs';
import * as YAML from 'yaml';
import { PipelineContractEntry, PipelineContractSpec } from '../types';

/**
 * Parse a pipeline contract file (`ghact --contract <file>`).
 *
 * Shape:
 * ```yaml
 * ordering: relative   # or "strict" (default: relative)
 * required:
 *   - uses: org/security-scan
 *     min-version: v1.2.0
 *   - uses: org/deploy
 * forbidden:
 *   - uses: org/legacy-deploy
 * ```
 */
export function parsePipelineContract(filePath: string): PipelineContractSpec {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Contract file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse contract file: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'Contract file must be a YAML mapping with optional "ordering", "required", and "forbidden" sections'
    );
  }

  const spec = parsed as Record<string, unknown>;

  if (
    spec.ordering !== undefined &&
    spec.ordering !== 'relative' &&
    spec.ordering !== 'strict'
  ) {
    throw new Error(
      `Contract "ordering" must be "relative" or "strict", got "${String(spec.ordering)}"`
    );
  }

  const result: PipelineContractSpec = {};
  if (spec.ordering) result.ordering = spec.ordering as 'relative' | 'strict';
  if (spec.required !== undefined) {
    result.required = parseEntryList(spec.required, 'required');
  }
  if (spec.forbidden !== undefined) {
    result.forbidden = parseEntryList(spec.forbidden, 'forbidden');
  }

  return result;
}

function parseEntryList(
  value: unknown,
  section: string
): PipelineContractEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Contract "${section}" must be a list of entries`);
  }

  return value.map((entry, idx) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>).uses !== 'string'
    ) {
      throw new Error(
        `Contract "${section}[${idx}]" must be a mapping with a string "uses" field`
      );
    }
    const e = entry as Record<string, unknown>;
    const parsedEntry: PipelineContractEntry = { uses: e.uses as string };
    if (e['min-version'] !== undefined) {
      parsedEntry['min-version'] = String(e['min-version']);
    }
    if (e.version !== undefined) {
      parsedEntry.version = String(e.version);
    }
    return parsedEntry;
  });
}
