import * as fs from 'fs';
import * as YAML from 'yaml';
import { PipelineContractEntry, PipelineContractSpec } from '../types';

/**
 * Parse a pipeline contract file (`secureci validate --contract <file>`).
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
  if (spec.pins !== undefined) {
    if (typeof spec.pins !== 'object' || spec.pins === null) {
      throw new Error('Contract "pins" must be a mapping');
    }
    const pins = spec.pins as Record<string, unknown>;
    result.pins = {};
    if (pins.required !== undefined) {
      result.pins.required = pins.required === true;
    }
    if (pins.allow !== undefined) {
      result.pins.allow = parseStringList(pins.allow, 'pins.allow');
    }
  }
  if (spec.lockfile !== undefined) {
    if (
      typeof spec.lockfile !== 'object' ||
      spec.lockfile === null ||
      Array.isArray(spec.lockfile)
    ) {
      throw new Error('Contract "lockfile" must be a mapping');
    }
    const lockfile = spec.lockfile as Record<string, unknown>;
    result.lockfile = {};
    if (lockfile.required !== undefined) {
      if (typeof lockfile.required !== 'boolean') {
        throw new Error('Contract "lockfile.required" must be true or false');
      }
      result.lockfile.required = lockfile.required;
    }
  }
  if (spec['allowed-owners'] !== undefined) {
    result.allowedOwners = parseStringList(
      spec['allowed-owners'],
      'allowed-owners'
    );
  }

  return result;
}

function parseStringList(value: unknown, section: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`Contract "${section}" must be a list of strings`);
  }
  return value as string[];
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
