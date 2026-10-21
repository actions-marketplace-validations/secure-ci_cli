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

  it('parses forbidden-triggers', () => {
    expect(
      parsePipelineContract(
        writeTemp('forbidden-triggers:\n  - pull_request_target\n')
      )
    ).toEqual({ forbiddenTriggers: ['pull_request_target'] });
  });

  it('throws when forbidden-triggers is not a list of strings', () => {
    expect(() =>
      parsePipelineContract(writeTemp('forbidden-triggers: workflow_run\n'))
    ).toThrow(/"forbidden-triggers" must be a list of strings/);
    expect(() =>
      parsePipelineContract(writeTemp('forbidden-triggers:\n  - 1\n'))
    ).toThrow(/"forbidden-triggers" must be a list of strings/);
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

  describe('permissions (#45)', () => {
    it('parses required and max', () => {
      expect(
        parsePipelineContract(
          writeTemp(
            [
              'permissions:',
              '  required: true',
              '  max:',
              '    contents: read',
              '    id-token: write',
              '    issues: none'
            ].join('\n')
          )
        )
      ).toEqual({
        permissions: {
          required: true,
          max: { contents: 'read', 'id-token': 'write', issues: 'none' }
        }
      });
    });

    it('accepts an empty mapping and an empty max', () => {
      expect(parsePipelineContract(writeTemp('permissions: {}\n'))).toEqual({
        permissions: {}
      });
      expect(
        parsePipelineContract(writeTemp('permissions:\n  max: {}\n'))
      ).toEqual({ permissions: { max: {} } });
    });

    it('keeps the other contract keys working alongside it', () => {
      expect(
        parsePipelineContract(
          writeTemp(
            [
              'pins:',
              '  required: true',
              '  allow: [actions]',
              'allowed-owners: [actions]',
              'lockfile:',
              '  required: true',
              'permissions:',
              '  required: false',
              'required:',
              '  - uses: org/scan'
            ].join('\n')
          )
        )
      ).toEqual({
        pins: { required: true, allow: ['actions'] },
        allowedOwners: ['actions'],
        lockfile: { required: true },
        permissions: { required: false },
        required: [{ uses: 'org/scan' }]
      });
    });

    it.each([
      ['permissions: true\n', /"permissions" must be a mapping/],
      ['permissions: [a]\n', /"permissions" must be a mapping/],
      [
        'permissions:\n  requried: true\n',
        /"permissions" has an unknown key "requried" \(expected "required" or "max"\)/
      ],
      [
        'permissions:\n  required: yes-please\n',
        /"permissions.required" must be true or false/
      ],
      [
        'permissions:\n  max: read-all\n',
        /"permissions.max" must be a mapping/
      ],
      [
        'permissions:\n  max: [contents]\n',
        /"permissions.max" must be a mapping/
      ],
      [
        'permissions:\n  max:\n    content: read\n',
        /"permissions.max" has an unknown scope "content"/
      ],
      [
        'permissions:\n  max:\n    contents: admin\n',
        /"permissions.max.contents" must be "read", "write" or "none", got "admin"/
      ]
    ])('rejects %j', (yaml, message) => {
      expect(() => parsePipelineContract(writeTemp(yaml))).toThrow(message);
    });
  });
});
