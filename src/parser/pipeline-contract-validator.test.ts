import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const fetchActionMock = vi.fn();
const fetchRepoFileMock = vi.fn();
vi.mock('../runner/action-fetcher', () => ({
  fetchAction: (...args: unknown[]) => fetchActionMock(...args),
  fetchRepoFile: (...args: unknown[]) => fetchRepoFileMock(...args)
}));
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
  it('passes when required actions are present, in order, with other steps in between (relative)', async () => {
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

    const result = await validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('errors when a required action is missing', async () => {
    const wf = workflow({
      build: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'org/deploy@v1' }] }
    });

    const result = await validatePipelineContract(wf, {
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

  it('errors when required actions are out of order (relative)', async () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/deploy@v1' }, { uses: 'org/security-scan@v1' }]
      }
    });

    const result = await validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].path).toBe('required[1]');
  });

  it('strict ordering fails when another step runs in between', async () => {
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

    const result = await validatePipelineContract(wf, {
      ordering: 'strict',
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('immediately after');
  });

  it('strict ordering passes when required actions are back-to-back', async () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1' }, { uses: 'org/deploy@v1' }]
      }
    });

    const result = await validatePipelineContract(wf, {
      ordering: 'strict',
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(true);
  });

  it('respects needs: job ordering across jobs when building the sequence', async () => {
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

    const result = await validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
    });

    expect(result.valid).toBe(true);
  });

  it('errors when a forbidden action is used (any version)', async () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/legacy-deploy@v3' }]
      }
    });

    const result = await validatePipelineContract(wf, {
      forbidden: [{ uses: 'org/legacy-deploy' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Forbidden action');
  });

  it('forbidden with an exact version only flags that version', async () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/deploy@v1' }]
      }
    });

    const okResult = await validatePipelineContract(wf, {
      forbidden: [{ uses: 'org/deploy', version: 'v0.9' }]
    });
    expect(okResult.valid).toBe(true);

    const badResult = await validatePipelineContract(wf, {
      forbidden: [{ uses: 'org/deploy', version: 'v1' }]
    });
    expect(badResult.valid).toBe(false);
  });

  it('errors when a required action is below the minimum version', async () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1.0.0' }]
      }
    });

    const result = await validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('below the required minimum');
  });

  it('passes when a required action meets the minimum version', async () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@v1.3.0' }]
      }
    });

    const result = await validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
    });

    expect(result.valid).toBe(true);
  });

  it('warns (does not fail) when a required action version is not comparable', async () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/security-scan@main' }]
      }
    });

    const result = await validatePipelineContract(wf, {
      required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ severity: 'warning' })
    ]);
  });

  describe('ordering of required actions below min-version (#38)', () => {
    it('still checks ordering for a required action that fails min-version', async () => {
      const wf = workflow({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'acme/deploy@v2' },
            { uses: 'acme/security-scan@v1.1.0' }
          ]
        }
      });

      const result = await validatePipelineContract(wf, {
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

    it('uses the contract index in ordering errors when an earlier entry is missing', async () => {
      const wf = workflow({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'acme/deploy@v1' }, { uses: 'acme/scan@v1' }]
        }
      });

      const result = await validatePipelineContract(wf, {
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

    const errorsOf = (
      result: Awaited<ReturnType<typeof validatePipelineContract>>
    ) => result.errors.filter((e) => e.severity === 'error');

    it('matches required entries and min-version regardless of owner/repo case', async () => {
      const result = await validatePipelineContract(wf, {
        required: [{ uses: 'org/security-scan', 'min-version': 'v1.2.0' }]
      });
      expect(errorsOf(result)).toEqual([]);
    });

    it('matches forbidden entries regardless of owner/repo case', async () => {
      const result = await validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/Legacy-Deploy/sub/Path' }]
      });
      expect(result.valid).toBe(false);
      expect(errorsOf(result)[0].path).toBe('jobs.build.steps[1]');
    });

    it('keeps the path inside the repo, local paths and docker refs case-sensitive', async () => {
      const result = await validatePipelineContract(wf, {
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

    it('errors for jobs with no needs: relationship, whatever their YAML order', async () => {
      for (const wf of [
        workflow({ scan, deploy }),
        workflow({ deploy, scan })
      ]) {
        const result = await validatePipelineContract(wf, contract);
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

    it('passes when the later job transitively needs the earlier one', async () => {
      const wf = workflow({
        deploy: { ...deploy, needs: ['test'] },
        test: { 'runs-on': 'ubuntu-latest', needs: 'scan', steps: [] },
        scan
      });
      expect((await validatePipelineContract(wf, contract)).errors).toEqual([]);
    });

    it('strict: passes across jobs only for last step -> first step of a job that needs it', async () => {
      const strict = { ...contract, ordering: 'strict' as const };
      const ok = workflow({ scan, deploy: { ...deploy, needs: 'scan' } });
      expect((await validatePipelineContract(ok, strict)).errors).toEqual([]);

      const gap = workflow({
        scan,
        deploy: {
          ...deploy,
          needs: 'scan',
          steps: [{ run: 'echo first' }, ...deploy.steps]
        }
      });
      expect((await validatePipelineContract(gap, strict)).valid).toBe(false);
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

    it('detects a forbidden action wrapped in a local composite action', async () => {
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

      const result = await validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/legacy-deploy' }]
      });
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'jobs.build.steps[0] > ./.github/actions/wrapper > steps[1]',
          severity: 'error'
        })
      ]);
    });

    it('detects a forbidden action in a local reusable workflow', async () => {
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

      const result = await validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/legacy-deploy' }]
      });
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'jobs.release > ./.github/workflows/release.yml > jobs.ship.steps[0]'
        })
      ]);
    });

    it('satisfies required actions through a reusable workflow, ordered by needs:', async () => {
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
      expect(
        (await validatePipelineContract(ordered, contract)).errors
      ).toEqual([]);

      const parallel = caller({
        scan,
        release: { uses: './.github/workflows/release.yml' }
      } as ParsedWorkflow['file']['jobs']);
      expect((await validatePipelineContract(parallel, contract)).valid).toBe(
        false
      );
    });

    it('orders steps inside a composite action within the calling job', async () => {
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
        (
          await validatePipelineContract(wf, {
            ordering: 'strict',
            required: [{ uses: 'org/security-scan' }, { uses: 'org/deploy' }]
          })
        ).errors
      ).toEqual([]);
      expect(
        (
          await validatePipelineContract(wf, {
            required: [{ uses: 'org/deploy' }, { uses: 'org/security-scan' }]
          })
        ).valid
      ).toBe(false);
    });

    it('reports a cycle instead of recursing forever', async () => {
      composite('.github/actions/a', [{ uses: './.github/actions/b' }]);
      composite('.github/actions/b', [{ uses: './.github/actions/a' }]);
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/a' }]
        }
      });

      const result = await validatePipelineContract(wf, {});
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        expect.objectContaining({
          message: expect.stringContaining('cycle'),
          severity: 'error'
        })
      ]);
    });

    it('stops at a maximum nesting depth', async () => {
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

      const result = await validatePipelineContract(wf, {});
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('nesting depth');
    });

    it('reports a local action that cannot be parsed instead of throwing', async () => {
      const file = path.join(root, '.github/actions/broken/action.yml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'name: [unclosed');
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/broken' }]
        }
      });

      const result = await validatePipelineContract(wf, {});
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatchObject({
        path: 'jobs.build.steps[0]',
        severity: 'error'
      });
    });

    it('warns when a local action cannot be resolved', async () => {
      const wf = caller({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: './.github/actions/missing' }]
        }
      });

      const result = await validatePipelineContract(wf, {});
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

  describe('recursion into remote actions and workflows (#39)', () => {
    let root: string;
    let remote: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-contract-'));
      remote = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-remote-'));
      fetchActionMock.mockReset();
      fetchRepoFileMock.mockReset();
      // Any other remote action is a plain JavaScript action.
      const jsAction = write(remote, 'js/action.yml', {
        name: 'js',
        description: 'd',
        runs: { using: 'node20', main: 'index.js' }
      });
      fetchActionMock.mockResolvedValue(jsAction);
    });
    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(remote, { recursive: true, force: true });
    });

    function write(base: string, rel: string, content: unknown): string {
      const file = path.join(base, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, YAML.stringify(content));
      return file;
    }

    function caller(jobs: ParsedWorkflow['file']['jobs']): ParsedWorkflow {
      const file = { name: 'Caller', on: 'push', jobs };
      return {
        type: 'workflow',
        path: write(root, '.github/workflows/caller.yml', file),
        file
      };
    }

    const forbidden = { forbidden: [{ uses: 'org/legacy-deploy' }] };
    const wrapperJob = {
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [{ uses: 'org/wrap@v1' }]
      }
    };

    it('does not fetch remote refs by default', async () => {
      const result = await validatePipelineContract(
        caller(wrapperJob),
        forbidden
      );
      expect(fetchActionMock).not.toHaveBeenCalled();
      expect(result.errors).toEqual([]);
    });

    it('with recurse: all, finds a forbidden action in a remote composite action', async () => {
      fetchActionMock.mockResolvedValueOnce(
        write(remote, 'action.yml', {
          name: 'wrap',
          description: 'd',
          runs: {
            using: 'composite',
            steps: [{ uses: 'org/legacy-deploy@v1' }]
          }
        })
      );

      const result = await validatePipelineContract(
        caller(wrapperJob),
        forbidden,
        { recurse: 'all' }
      );
      expect(fetchActionMock).toHaveBeenCalledWith('org/wrap@v1');
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'jobs.build.steps[0] > org/wrap@v1 > steps[0]',
          severity: 'error'
        })
      ]);
    });

    it('with recurse: all, follows a remote reusable workflow and its own ./ workflow refs', async () => {
      write(remote, '.github/workflows/inner.yml', {
        name: 'inner',
        on: 'workflow_call',
        jobs: {
          ship: {
            'runs-on': 'ubuntu-latest',
            steps: [{ uses: 'org/legacy-deploy@v1' }]
          }
        }
      });
      fetchRepoFileMock.mockResolvedValueOnce(
        write(remote, '.github/workflows/outer.yml', {
          name: 'outer',
          on: 'workflow_call',
          jobs: { inner: { uses: './.github/workflows/inner.yml' } }
        })
      );

      const result = await validatePipelineContract(
        caller({
          release: { uses: 'org/shared/.github/workflows/outer.yml@v1' }
        } as ParsedWorkflow['file']['jobs']),
        forbidden,
        { recurse: 'all' }
      );
      expect(result.errors).toEqual([
        expect.objectContaining({
          path: 'jobs.release > org/shared/.github/workflows/outer.yml@v1 > jobs.inner > ./.github/workflows/inner.yml > jobs.ship.steps[0]'
        })
      ]);
    });

    it('warns when a remote ref cannot be fetched', async () => {
      fetchActionMock.mockResolvedValueOnce(null);
      const result = await validatePipelineContract(
        caller(wrapperJob),
        forbidden,
        { recurse: 'all' }
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([
        expect.objectContaining({
          severity: 'warning',
          message: expect.stringContaining('could not be fetched')
        })
      ]);
    });

    it('with recurse: none, does not resolve local actions either', async () => {
      write(root, '.github/actions/wrap/action.yml', {
        name: 'w',
        description: 'd',
        runs: { using: 'composite', steps: [{ uses: 'org/legacy-deploy@v1' }] }
      });
      const result = await validatePipelineContract(
        caller({
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [{ uses: './.github/actions/wrap' }]
          }
        }),
        forbidden,
        { recurse: 'none' }
      );
      expect(result.errors).toEqual([]);
    });
  });

  describe('conditional steps and jobs (#14)', () => {
    const contract = { required: [{ uses: 'org/security-scan' }] };

    it('warns when a required action only runs under an if:', async () => {
      for (const wf of [
        workflow({
          build: {
            'runs-on': 'ubuntu-latest',
            steps: [
              { uses: 'org/security-scan@v1', if: "matrix.os == 'linux'" }
            ]
          }
        }),
        workflow({
          build: {
            'runs-on': 'ubuntu-latest',
            if: "github.ref == 'refs/heads/main'",
            steps: [{ uses: 'org/security-scan@v1' }]
          }
        })
      ]) {
        const result = await validatePipelineContract(wf, contract);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([
          expect.objectContaining({
            path: 'required[0]',
            severity: 'warning',
            message: expect.stringContaining('may be skipped')
          })
        ]);
      }
    });

    it('does not warn when an unconditional occurrence exists', async () => {
      const wf = workflow({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: 'org/security-scan@v1', if: 'false' },
            { uses: 'org/security-scan@v1' }
          ]
        }
      });
      expect((await validatePipelineContract(wf, contract)).errors).toEqual([]);
    });

    it('still errors for a forbidden action under an if:', async () => {
      const wf = workflow({
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ uses: 'org/legacy@v1', if: 'false' }]
        }
      });
      const result = await validatePipelineContract(wf, {
        forbidden: [{ uses: 'org/legacy' }]
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('supply-chain pinning rules (#9)', () => {
    const wf = workflow({
      build: {
        'runs-on': 'ubuntu-latest',
        steps: [
          { uses: 'actions/checkout@v4' },
          { uses: 'org/scan@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
          { uses: 'evil/tool@main' },
          { uses: './.github/actions/local' },
          { uses: 'docker://alpine:3.20' },
          { run: 'echo hi' }
        ]
      }
    });

    it('pins.required flags remote actions not pinned to a commit SHA', async () => {
      const result = await validatePipelineContract(wf, {
        pins: { required: true }
      });
      const msgs = result.errors
        .filter((e) => e.severity === 'error')
        .map((e) => e.message);
      // checkout@v4 and evil/tool@main are unpinned; org/scan@<sha> is fine.
      expect(msgs).toHaveLength(2);
      expect(msgs.join('\n')).toContain('actions/checkout@v4');
      expect(msgs.join('\n')).toContain('evil/tool@main');
      expect(msgs.join('\n')).toContain('commit SHA');
      // local and docker refs are not subject to SHA pinning.
      expect(msgs.join('\n')).not.toContain('local');
      expect(msgs.join('\n')).not.toContain('docker');
    });

    it('pins.allow exempts listed owners/repos (case-insensitive)', async () => {
      const result = await validatePipelineContract(wf, {
        pins: { required: true, allow: ['Actions'] }
      });
      const msgs = result.errors
        .filter((e) => e.severity === 'error')
        .map((e) => e.message);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toContain('evil/tool@main');
    });

    it('allowed-owners restricts which owners may be used at all', async () => {
      const result = await validatePipelineContract(wf, {
        allowedOwners: ['actions', 'org']
      });
      const errs = result.errors.filter((e) => e.severity === 'error');
      expect(errs).toHaveLength(1);
      expect(errs[0].message).toContain('evil');
      expect(errs[0].message).toContain('not allowed');
      expect(errs[0].path).toBe('jobs.build.steps[2]');
    });

    it('applies pinning inside a composite action via the flattened sequence', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-pin-'));
      try {
        fs.mkdirSync(path.join(root, '.github/actions/wrap'), {
          recursive: true
        });
        fs.writeFileSync(
          path.join(root, '.github/actions/wrap/action.yml'),
          YAML.stringify({
            name: 'wrap',
            description: 'd',
            runs: {
              using: 'composite',
              steps: [{ uses: 'sneaky/action@v1' }]
            }
          })
        );
        const file = path.join(root, '.github/workflows/caller.yml');
        const wfObj = {
          name: 'C',
          on: 'push',
          jobs: {
            build: {
              'runs-on': 'ubuntu-latest',
              steps: [{ uses: './.github/actions/wrap' }]
            }
          }
        };
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, YAML.stringify(wfObj));
        const result = await validatePipelineContract(
          { type: 'workflow', path: file, file: wfObj },
          { pins: { required: true } }
        );
        const errs = result.errors.filter((e) => e.severity === 'error');
        expect(errs).toHaveLength(1);
        expect(errs[0].message).toContain('sneaky/action@v1');
        expect(errs[0].path).toContain('> ./.github/actions/wrap >');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe('lockfile.required', () => {
  let root: string;
  const sha = 'a'.repeat(40);
  const steps = [
    { uses: 'Actions/Checkout@v4' },
    { uses: `org/scan@${sha}` },
    { uses: './.github/actions/local' },
    { uses: 'docker://alpine:3' }
  ];
  const wfAt = (): ParsedWorkflow => {
    const file = path.join(root, '.github', 'workflows', 'ci.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const wfObj = {
      name: 'CI',
      on: 'push',
      jobs: { build: { 'runs-on': 'x', steps } }
    } as ParsedWorkflow['file'];
    fs.writeFileSync(file, YAML.stringify(wfObj));
    return { type: 'workflow', path: file, file: wfObj };
  };
  const errors = async () =>
    (
      await validatePipelineContract(
        wfAt(),
        { lockfile: { required: true } },
        { recurse: 'none' }
      )
    ).errors.filter((e) => e.severity === 'error');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-lockrule-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('fails when the repository has no lockfile', async () => {
    const errs = await errors();
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('lockfile');
    expect(errs[0].message).toMatch(/requires a lockfile.*secureci.lock/);
  });

  it('passes when secureci.lock covers every remote reference (owner/repo case-insensitive)', async () => {
    fs.writeFileSync(
      path.join(root, 'secureci.lock'),
      JSON.stringify({
        version: 1,
        actions: { 'actions/checkout@v4': sha, [`org/scan@${sha}`]: sha }
      })
    );
    expect(await errors()).toEqual([]);
  });

  it('flags each remote reference missing from the lockfile', async () => {
    fs.writeFileSync(
      path.join(root, 'secureci.lock'),
      JSON.stringify({
        version: 2,
        actions: { 'actions/checkout@v4': { commit: sha } }
      })
    );
    const errs = await errors();
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('jobs.build.steps[1]');
    expect(errs[0].message).toContain(`org/scan@${sha}`);
    expect(errs[0].message).toContain('secureci.lock');
  });

  it("accepts GitHub's actions.lock when it is the only lockfile", async () => {
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.github', 'workflows', 'actions.lock'),
      [
        "version: 'v0.0.3'",
        'dependencies:',
        "  'actions/checkout@v4':",
        `    commit: 'sha1-${sha}'`
      ].join('\n')
    );
    const errs = await errors();
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain('actions.lock');
  });

  it('reports an unreadable lockfile', async () => {
    fs.writeFileSync(path.join(root, 'secureci.lock'), '{ nope');
    const errs = await errors();
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('lockfile');
    expect(errs[0].message).toMatch(/Could not read secureci.lock/);
  });
});
