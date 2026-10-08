import { describe, it, expect } from 'vitest';
import { validatePipelineContract } from './pipeline-contract-validator';
import { ParsedWorkflow } from '../types';

function workflow(jobs: ParsedWorkflow['file']['jobs']): ParsedWorkflow {
  return {
    type: 'workflow',
    path: '/tmp/workflow.yml',
    file: { name: 'Caller', on: 'push', jobs }
  };
}

describe('validatePipelineContract', () => {
  it('passes when required actions are present, in order, with other steps in between (relative)', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: 'actions/checkout@v4' },
          { run: 'echo setup' },
          { uses: 'org/security-scan@v1' },
          { run: 'echo other' },
          { uses: 'org/deploy@v2' }
        ]
      }
    });

    const result = validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('errors when a required action is missing', () => {
    const wf = workflow({
      build: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'org/deploy@v1' }] }
    });

    const result = validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: 'required[0]',
        severity: 'error',
        message: expect.stringContaining('was not found')
      })
    ]);
  });

  it('errors when required actions are out of order (relative)', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/deploy@v1' }, { uses: 'org/security-scan@v1' }]
      }
    });

    const result = validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('required[1]');
  });

  it('strict ordering fails when another step runs in between', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: 'org/security-scan@v1' },
          { run: 'echo noise' },
          { uses: 'org/deploy@v1' }
        ]
      }
    });

    const result = validatePipelineContract(wf, {
      ordering: 'strict',
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('immediately after');
  });

  it('strict ordering passes when required actions are back-to-back', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1' }, { uses: 'org/deploy@v1' }]
      }
    });

    const result = validatePipelineContract(wf, {
      ordering: 'strict',
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(true);
  });

  it('respects needs: job ordering across jobs when building the sequence', () => {
    const wf = workflow({
      deploy: {
        'runs-on': 'ubuntu-latest',
        needs: 'scan',
        steps: [{ uses: 'org/deploy@v1' }]
      },
      scan: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1' }]
      }
    });

    const result = validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(true);
  });

  it('errors when a forbidden action is used (any version)', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/legacy-deploy@v3' }]
      }
    });

    const result = validatePipelineContract(wf, {
      forbidden: [{ uses: 'org/legacy-deploy' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Forbidden action');
  });

  it('forbidden with an exact version only flags that version', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/deploy@v1' }]
      }
    });

    const okResult = validatePipelineContract(wf, {
      forbidden: [{ uses: 'org/deploy', version: 'v0.9' }]
    });
    expect(okResult.valid).toBe(true);

    const badResult = validatePipelineContract(wf, {
      forbidden: [{ uses: 'org/deploy', version: 'v1' }]
    });
    expect(badResult.valid).toBe(false);
  });

  it('errors when a required action is below the minimum version', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1.0.0' }]
      }
    });

    const result = validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('below the required minimum');
  });

  it('passes when a required action meets the minimum version', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1.3.0' }]
      }
    });

    const result = validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
    });

    expect(result.valid).toBe(true);
  });

  it('warns (does not fail) when a required action version is not comparable', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@main' }]
      }
    });

    const result = validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning' })
    ]);
  });

  describe('ordering of required actions below min-version (#38)', () => {
    it('still checks ordering for a required action that fails min-version', () => {
      const wf = workflow({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'acme/deploy@v2' },
            { uses: 'acme/security-scan@v1.1.0' }
          ]
        }
      });

      const result = validatePipelineContract(wf, {
        required: [
          { uses: 'acme/security-scan', 'min-version': 'v1.2.0' },
          { uses: 'acme/deploy' }
        ]
      });

      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'required[0]',
          message: expect.stringContaining('below the required minimum')
        }),
        expect.objectContaining({
          path: 'required[1]',
          message: expect.stringContaining('must run after')
        })
      ]);
    });

    it('uses the contract index in ordering errors when an earlier entry is missing', () => {
      const wf = workflow({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'acme/deploy@v1' }, { uses: 'acme/scan@v1' }]
        }
      });

      const result = validatePipelineContract(wf, {
        required: [
          { uses: 'acme/missing' },
          { uses: 'acme/scan' },
          { uses: 'acme/deploy' }
        ]
      });

      expect(result.errors).toEqual([
        expect.objectContaining({ path: 'required[0]' }),
        expect.objectContaining({
          path: 'required[2]',
          message: expect.stringContaining(
            '"acme/deploy" must run after "acme/scan"'
          )
        })
      ]);
    });
  });

  describe('case-insensitive owner/repo matching (#16)', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: 'Org/Security-Scan@v1.3.0' },
          { uses: 'ORG/legacy-deploy/sub/Path@v1' },
          { uses: './.github/actions/Local' },
          { uses: 'docker://alpine:Latest' }
        ]
      }
    });

    it('matches required entries and min-version regardless of owner/repo case', () => {
      const result = validatePipelineContract(wf, {
        required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
      });
      expect(result.errors).toEqual([]);
    });

    it('matches forbidden entries regardless of owner/repo case', () => {
      const result = validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/Legacy-Deploy/sub/Path' }]
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('jobs.build.steps[1]');
    });

    it('keeps the path inside the repo, local paths and docker refs case-sensitive', () => {
      const result = validatePipelineContract(wf, {
        forbidden: [
          { uses: 'org/legacy-deploy/sub/path' },
          { uses: './.github/actions/local' },
          { uses: 'docker://alpine:latest' }
        ]
      });
      expect(result.errors).toEqual([]);
    });
  });
});
