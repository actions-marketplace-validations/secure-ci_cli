import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
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

    const errorsOf = (result: ReturnType<typeof validatePipelineContract>) =>
      result.errors.filter((e) => e.severity === 'error');

    it('matches required entries and min-version regardless of owner/repo case', () => {
      const result = validatePipelineContract(wf, {
        required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
      });
      expect(errorsOf(result)).toEqual([]);
    });

    it('matches forbidden entries regardless of owner/repo case', () => {
      const result = validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/Legacy-Deploy/sub/Path' }]
      });
      expect(result.valid).toBe(false);
      expect(errorsOf(result)[0].path).toBe('jobs.build.steps[1]');
    });

    it('keeps the path inside the repo, local paths and docker refs case-sensitive', () => {
      const result = validatePipelineContract(wf, {
        forbidden: [
          { uses: 'org/legacy-deploy/sub/path' },
          { uses: './.github/actions/local' },
          { uses: 'docker://alpine:latest' }
        ]
      });
      expect(errorsOf(result)).toEqual([]);
    });
  });

  describe('ordering across jobs follows needs:, not YAML order (#17)', () => {
    const scan = {
      'runs-on': 'ubuntu-latest',
      steps: [{ uses: 'org/security-scan@v1' }]
    };
    const deploy = {
      'runs-on': 'ubuntu-latest',
      steps: [{ uses: 'org/deploy@v1' }]
    };
    const contract = {
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    };

    it('errors for jobs with no needs: relationship, whatever their YAML order', () => {
      for (const wf of [
        workflow({ scan, deploy }),
        workflow({ deploy, scan })
      ]) {
        const result = validatePipelineContract(wf, contract);
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual([
          expect.objectContaining({
            path: 'required[1]',
            message: expect.stringMatching(
              /must run after "org\/security-scan".*no needs: relationship.*may run in parallel/
            )
          })
        ]);
      }
    });

    it('passes when the later job transitively needs the earlier one', () => {
      const wf = workflow({
        deploy: { ...deploy, needs: ['test'] },
        test: { 'runs-on': 'ubuntu-latest', needs: 'scan', steps: [] },
        scan
      });
      expect(validatePipelineContract(wf, contract).errors).toEqual([]);
    });

    it('strict: passes across jobs only for last step -> first step of a job that needs it', () => {
      const strict = { ...contract, ordering: 'strict' as const };
      const ok = workflow({ scan, deploy: { ...deploy, needs: 'scan' } });
      expect(validatePipelineContract(ok, strict).errors).toEqual([]);

      const gap = workflow({
        scan,
        deploy: {
          ...deploy,
          needs: 'scan',
          steps: [{ run: 'echo first' }, ...deploy.steps]
        }
      });
      expect(validatePipelineContract(gap, strict).valid).toBe(false);
    });
  });

  describe('local composite actions and reusable workflows (#25)', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-contract-'));
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    function write(rel: string, content: unknown): string {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, YAML.stringify(content));
      return file;
    }

    function composite(rel: string, steps: unknown[]): void {
      write(`${rel}/action.yml`, {
        name: rel,
        description: 'test',
        runs: { using: 'composite', steps }
      });
    }

    function caller(jobs: ParsedWorkflow['file']['jobs']): ParsedWorkflow {
      const file = { name: 'Caller', on: 'push', jobs };
      return {
        type: 'workflow',
        path: write('.github/workflows/caller.yml', file),
        file
      };
    }

    it('detects a forbidden action wrapped in a local composite action', () => {
      composite('.github/actions/wrapper', [
        { run: 'echo hi', shell: 'bash' },
        { uses: 'org/legacy-deploy@v1' }
      ]);
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/wrapper' }]
        }
      });

      const result = validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/legacy-deploy' }]
      });
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'jobs.build.steps[0] > ./.github/actions/wrapper > steps[1]',
          severity: 'error'
        })
      ]);
    });

    it('detects a forbidden action in a local reusable workflow', () => {
      write('.github/workflows/release.yml', {
        name: 'Release',
        on: 'workflow_call',
        jobs: {
          ship: {
            'runs-on': 'ubuntu-latest',
            steps: [{ uses: 'org/legacy-deploy@v1' }]
          }
        }
      });
      const wf = caller({
        release: { uses: './.github/workflows/release.yml' }
      } as ParsedWorkflow['file']['jobs']);

      const result = validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/legacy-deploy' }]
      });
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'jobs.release > ./.github/workflows/release.yml > jobs.ship.steps[0]'
        })
      ]);
    });

    it('satisfies required actions through a reusable workflow, ordered by needs:', () => {
      write('.github/workflows/release.yml', {
        name: 'Release',
        on: 'workflow_call',
        jobs: {
          build: { 'runs-on': 'ubuntu-latest', steps: [{ run: 'make' }] },
          ship: {
            'runs-on': 'ubuntu-latest',
            needs: 'build',
            steps: [{ uses: 'org/deploy@v2' }]
          }
        }
      });
      const contract = {
        required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
      };
      const scan = {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1' }]
      };

      const ordered = caller({
        scan,
        release: { uses: './.github/workflows/release.yml', needs: 'scan' }
      } as ParsedWorkflow['file']['jobs']);
      expect(validatePipelineContract(ordered, contract).errors).toEqual([]);

      const parallel = caller({
        scan,
        release: { uses: './.github/workflows/release.yml' }
      } as ParsedWorkflow['file']['jobs']);
      expect(validatePipelineContract(parallel, contract).valid).toBe(false);
    });

    it('orders steps inside a composite action within the calling job', () => {
      composite('.github/actions/pipeline', [
        { uses: 'org/security-scan@v1' },
        { uses: 'org/deploy@v1' }
      ]);
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/pipeline' }]
        }
      });

      expect(
        validatePipelineContract(wf, {
          ordering: 'strict',
          required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
        }).errors
      ).toEqual([]);
      expect(
        validatePipelineContract(wf, {
          required: [{ uses: 'org/deploy' }, { uses: 'org/security-scan' }]
        }).valid
      ).toBe(false);
    });

    it('reports a cycle instead of recursing forever', () => {
      composite('.github/actions/a', [{ uses: './.github/actions/b' }]);
      composite('.github/actions/b', [{ uses: './.github/actions/a' }]);
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/a' }]
        }
      });

      const result = validatePipelineContract(wf, {});
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining('cycle'),
          severity: 'error'
        })
      ]);
    });

    it('stops at a maximum nesting depth', () => {
      for (let i = 0; i < 12; i++) {
        composite(`.github/actions/n${i}`, [
          { uses: `./.github/actions/n${i + 1}` }
        ]);
      }
      composite('.github/actions/n12', [{ run: 'true', shell: 'bash' }]);
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/n0' }]
        }
      });

      const result = validatePipelineContract(wf, {});
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('nesting depth');
    });

    it('reports a local action that cannot be parsed instead of throwing', () => {
      const file = path.join(root, '.github/actions/broken/action.yml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'name: [unclosed');
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/broken' }]
        }
      });

      const result = validatePipelineContract(wf, {});
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({
        path: 'jobs.build.steps[0]',
        severity: 'error'
      });
    });

    it('warns when a local action cannot be resolved', () => {
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/missing' }]
        }
      });

      const result = validatePipelineContract(wf, {});
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'jobs.build.steps[0]',
          severity: 'warning',
          message: expect.stringContaining('could not be resolved')
        })
      ]);
    });
  });
});
