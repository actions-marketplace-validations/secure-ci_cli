import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parsePipelineContract } from './pipeline-contract-parser';

describe('parsePipelineContract', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    while (tempFiles.length) {
      fs.rmSync(tempFiles.pop()!, { force: true });
    }
  });

  function writeTemp(content: string): string {
    const file = path.join(
      os.tmpdir(),
      `secureci-contract-test-${Date.now()}-${Math.random()}.yml`
    );
    fs.writeFileSync(file, content);
    tempFiles.push(file);
    return file;
  }

  it('throws when the file does not exist', () => {
    expect(() => parsePipelineContract('/nonexistent/contract.yml')).toThrow(
      /Contract file not found/
    );
  });

  it('parses a well-formed contract', () => {
    const file = writeTemp(
      [
        'ordering: strict',
        'required:',
        '  - uses: org/security-scan',
        '    min-version: v1.2.0',
        '  - uses: org/deploy',
        'forbidden:',
        '  - uses: org/legacy-deploy'
      ].join('\n')
    );
    expect(parsePipelineContract(file)).toEqual({
      ordering: 'strict',
      required: [
        { uses: 'org/security-scan', 'min-version': 'v1.2.0' },
        { uses: 'org/deploy' }
      ],
      forbidden: [{ uses: 'org/legacy-deploy' }]
    });
  });

  it('returns an empty spec for an empty file', () => {
    expect(parsePipelineContract(writeTemp(''))).toEqual({});
  });

  it('throws on invalid YAML', () => {
    expect(() =>
      parsePipelineContract(writeTemp('{ not: valid: yaml'))
    ).toThrow(/Failed to parse contract file/);
  });

  it('throws when the top level is not a mapping', () => {
    expect(() => parsePipelineContract(writeTemp('- a\n- b\n'))).toThrow(
      /must be a YAML mapping/
    );
  });

  it('throws on an invalid ordering value', () => {
    expect(() =>
      parsePipelineContract(writeTemp('ordering: sequential\n'))
    ).toThrow(/"ordering" must be "relative" or "strict"/);
  });

  it('throws when required/forbidden is not a list', () => {
    expect(() =>
      parsePipelineContract(writeTemp('required:\n  uses: org/x\n'))
    ).toThrow(/"required" must be a list of entries/);
  });

  it('throws when an entry is missing "uses"', () => {
    expect(() =>
      parsePipelineContract(writeTemp('required:\n  - min-version: v1\n'))
    ).toThrow(/must be a mapping with a string "uses" field/);
  });

  it('parses lockfile.required', () => {
    expect(
      parsePipelineContract(writeTemp('lockfile:\n  required: true\n'))
    ).toEqual({ lockfile: { required: true } });
    expect(
      parsePipelineContract(writeTemp('lockfile:\n  required: false\n'))
    ).toEqual({ lockfile: { required: false } });
  });

  it('throws when lockfile is not a mapping with a boolean required', () => {
    expect(() =>
      parsePipelineContract(writeTemp('lockfile: required\n'))
    ).toThrow(/"lockfile" must be a mapping/);
    expect(() =>
      parsePipelineContract(writeTemp('lockfile:\n  required: yes-please\n'))
    ).toThrow(/"lockfile.required" must be true or false/);
  });
});
