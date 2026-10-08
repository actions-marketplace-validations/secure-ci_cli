import { describe, it, expect } from 'vitest';
import { formatValidation } from './report';
import type { ValidationResult } from './types';

const result: ValidationResult = {
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

describe('formatValidation', () => {
  it('json: reports file, validity and errors', () => {
    const out = JSON.parse(
      formatValidation('.github/workflows/ci.yml', result, 'json')
    );
    expect(out).toMatchObject({
      file: '.github/workflows/ci.yml',
      valid: false
    });
    expect(out.errors).toHaveLength(2);
    expect(out.errors[0]).toEqual({
      path: 'jobs.a.steps[0]',
      message: 'Step must have "uses" or "run"',
      severity: 'error'
    });
  });

  it('json: a clean result has valid true and no errors', () => {
    const out = JSON.parse(
      formatValidation('ci.yml', { valid: true, errors: [] }, 'json')
    );
    expect(out).toEqual({ file: 'ci.yml', valid: true, errors: [] });
  });

  it('sarif: is a valid 2.1.0 log with one run and a result per error', () => {
    const log = JSON.parse(formatValidation('wf.yml', result, 'sarif'));
    expect(log.version).toBe('2.1.0');
    expect(log.$schema).toContain('sarif');
    expect(log.runs).toHaveLength(1);
    const run = log.runs[0];
    expect(run.tool.driver.name).toBe('secureci');
    expect(run.tool.driver.rules.length).toBeGreaterThan(0);
    expect(run.results).toHaveLength(2);
    expect(run.results[0]).toMatchObject({
      level: 'error',
      message: { text: 'jobs.a.steps[0]: Step must have "uses" or "run"' }
    });
    expect(
      run.results[0].locations[0].physicalLocation.artifactLocation.uri
    ).toBe('wf.yml');
    expect(run.results[1].level).toBe('warning');
    // Every result's ruleId is declared in the driver's rules.
    const ruleIds = new Set(
      run.tool.driver.rules.map((r: { id: string }) => r.id)
    );
    for (const res of run.results) expect(ruleIds.has(res.ruleId)).toBe(true);
  });

  it('sarif: a clean result produces an empty results array', () => {
    const log = JSON.parse(
      formatValidation('wf.yml', { valid: true, errors: [] }, 'sarif')
    );
    expect(log.runs[0].results).toEqual([]);
  });
});
