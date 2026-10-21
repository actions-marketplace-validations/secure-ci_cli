import { describe, it, expect } from 'vitest';
import { formatValidation, formatReport } from './report';
import type { ValidationResult } from './types';

const bad: ValidationResult = {
  valid: false,
  errors: [
    {
      path: 'jobs.a.steps[0]',
      message: 'Step must have "uses" or "run"',
      severity: 'error'
    },
    {
      path: 'required[1]',
      message: 'must run after "scan"',
      severity: 'warning'
    }
  ]
};
const good: ValidationResult = { valid: true, errors: [] };

describe('formatValidation (single file)', () => {
  it('json: reports file, validity and errors', () => {
    const out = JSON.parse(formatValidation('ci.yml', bad, 'json'));
    expect(out).toMatchObject({ file: 'ci.yml', valid: false });
    expect(out.errors).toHaveLength(2);
    expect(out.errors[0]).toEqual({
      path: 'jobs.a.steps[0]',
      message: 'Step must have "uses" or "run"',
      severity: 'error'
    });
  });

  it('json: clean result', () => {
    const out = JSON.parse(formatValidation('ci.yml', good, 'json'));
    expect(out).toEqual({ file: 'ci.yml', valid: true, errors: [] });
  });

  it('sarif: valid 2.1.0 log with a result per error', () => {
    const log = JSON.parse(formatValidation('wf.yml', bad, 'sarif'));
    expect(log.version).toBe('2.1.0');
    expect(log.runs[0].tool.driver.name).toBe('secureci');
    expect(log.runs[0].tool.driver.informationUri).toBe(
      'https://secure-ci.dev'
    );
    expect(log.runs[0].results).toHaveLength(2);
    expect(log.runs[0].results[0]).toMatchObject({
      level: 'error',
      message: { text: 'jobs.a.steps[0]: Step must have "uses" or "run"' }
    });
    expect(
      log.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri
    ).toBe('wf.yml');
    expect(log.runs[0].results[1].level).toBe('warning');
    const ruleIds = new Set(
      log.runs[0].tool.driver.rules.map((r: { id: string }) => r.id)
    );
    for (const res of log.runs[0].results) {
      expect(ruleIds.has(res.ruleId)).toBe(true);
    }
  });
});

describe('SARIF rule ids', () => {
  it("uses an error's explicit rule over the one derived from its path", () => {
    const result: ValidationResult = {
      valid: false,
      errors: [
        {
          path: 'jobs.a.steps[0].run',
          message: 'untrusted input',
          severity: 'error',
          rule: 'secureci/injection'
        },
        { path: 'jobs.a.if', message: 'bad if', severity: 'error' }
      ]
    };
    const log = JSON.parse(formatValidation('wf.yml', result, 'sarif'));
    expect(
      log.runs[0].results.map((r: { ruleId: string }) => r.ruleId)
    ).toEqual(['secureci/injection', 'secureci/expression']);
  });
});

describe('formatReport (multiple files)', () => {
  const entries = [
    { file: 'a.yml', result: bad },
    { file: 'b.yml', result: good }
  ];

  it('json: object with per-file results and overall validity', () => {
    const out = JSON.parse(formatReport(entries, 'json'));
    expect(out.valid).toBe(false);
    expect(out.files).toHaveLength(2);
    expect(out.files[0]).toMatchObject({ file: 'a.yml', valid: false });
    expect(out.files[1]).toEqual({ file: 'b.yml', valid: true, errors: [] });
  });

  it('json: a single entry keeps the flat single-file shape', () => {
    const out = JSON.parse(
      formatReport([{ file: 'a.yml', result: bad }], 'json')
    );
    expect(out.file).toBe('a.yml');
    expect(out.files).toBeUndefined();
  });

  it('sarif: one run, results from every file, each with its own uri', () => {
    const log = JSON.parse(formatReport(entries, 'sarif'));
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0].results).toHaveLength(2);
    const uris = log.runs[0].results.map(
      (r: {
        locations: {
          physicalLocation: { artifactLocation: { uri: string } };
        }[];
      }) => r.locations[0].physicalLocation.artifactLocation.uri
    );
    expect(uris).toEqual(['a.yml', 'a.yml']);
  });
});

describe('formatReport with a contract', () => {
  const contract = {
    source: 'my-org/standards/contracts/standard.yml@v1',
    ref: 'v1',
    commit: 'c'.repeat(40),
    pinned: false
  };

  it('json: records which contract (and commit) was enforced', () => {
    const one = JSON.parse(
      formatReport([{ file: 'a.yml', result: good }], 'json', { contract })
    );
    expect(one.contract).toEqual(contract);
    const many = JSON.parse(
      formatReport(
        [
          { file: 'a.yml', result: good },
          { file: 'b.yml', result: bad }
        ],
        'json',
        { contract }
      )
    );
    expect(many.contract).toEqual(contract);
  });

  it('sarif: records it in the run properties', () => {
    const log = JSON.parse(
      formatReport([{ file: 'a.yml', result: good }], 'sarif', { contract })
    );
    expect(log.runs[0].properties).toEqual({ contract });
  });

  it('adds nothing when no contract was used', () => {
    expect(
      JSON.parse(formatReport([{ file: 'a.yml', result: good }], 'json'))
        .contract
    ).toBeUndefined();
    expect(
      JSON.parse(formatReport([{ file: 'a.yml', result: good }], 'sarif'))
        .runs[0].properties
    ).toBeUndefined();
  });
});
