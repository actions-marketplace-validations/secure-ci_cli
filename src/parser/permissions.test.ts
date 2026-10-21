import { describe, it, expect } from 'vitest';
import {
  contractPermissionErrors,
  GITHUB_TOKEN_SCOPES,
  workflowPermissionErrors
} from './permissions';
import { Job, WorkflowFile } from '../types';

const job = (extra: Partial<Job> = {}): Job => ({
  'runs-on': 'ubuntu-latest',
  steps: [{ run: 'echo ok' }],
  ...extra
});

function wf(extra: Partial<WorkflowFile> = {}): WorkflowFile {
  return { name: 'W', on: 'push', jobs: { build: job() }, ...extra };
}

describe('workflowPermissionErrors (default checks, warnings)', () => {
  it('warns when neither the workflow nor a job declares permissions', () => {
    const errors = workflowPermissionErrors(
      wf({ jobs: { build: job(), test: job() } })
    );
    expect(errors).toEqual([
      {
        path: 'permissions',
        message: expect.stringMatching(/"build", "test"/),
        severity: 'warning',
        rule: 'secureci/permissions'
      }
    ]);
    expect(errors[0].message).toMatch(/default permissions/);
  });

  it('names only the jobs that declare no permissions of their own', () => {
    const errors = workflowPermissionErrors(
      wf({
        jobs: {
          build: job({ permissions: { contents: 'read' } }),
          test: job()
        }
      })
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('"test"');
    expect(errors[0].message).not.toContain('"build"');
  });

  it('is clean when every job declares its own permissions', () => {
    expect(
      workflowPermissionErrors(
        wf({
          jobs: {
            build: job({ permissions: { contents: 'read' } }),
            deploy: job({ permissions: { contents: 'write' } })
          }
        })
      )
    ).toEqual([]);
  });

  it('treats a reusable-workflow call job like any other job', () => {
    const errors = workflowPermissionErrors(
      wf({ jobs: { call: { uses: './.github/workflows/r.yml' } } })
    );
    expect(errors[0].message).toContain('"call"');
  });

  it('treats an empty permissions: value as undeclared', () => {
    const errors = workflowPermissionErrors(
      wf({ permissions: null as unknown as WorkflowFile['permissions'] })
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('permissions');
  });

  it.each([
    ['{}', {}],
    ['read-all', 'read-all' as const],
    [
      'a read-only mapping',
      { contents: 'read' as const, issues: 'none' as const }
    ]
  ])('accepts top-level permissions: %s', (_label, permissions) => {
    expect(workflowPermissionErrors(wf({ permissions }))).toEqual([]);
  });

  it('warns about top-level write-all', () => {
    expect(workflowPermissionErrors(wf({ permissions: 'write-all' }))).toEqual([
      {
        path: 'permissions',
        message: expect.stringContaining('write-all'),
        severity: 'warning',
        rule: 'secureci/permissions'
      }
    ]);
  });

  it('warns about write-all on a job', () => {
    expect(
      workflowPermissionErrors(
        wf({
          permissions: {},
          jobs: { deploy: job({ permissions: 'write-all' }) }
        })
      )
    ).toEqual([
      {
        path: 'jobs.deploy.permissions',
        message: expect.stringMatching(/Job "deploy".*write-all/),
        severity: 'warning',
        rule: 'secureci/permissions'
      }
    ]);
  });

  it('accepts read-all and {} on a job', () => {
    expect(
      workflowPermissionErrors(
        wf({
          jobs: {
            a: job({ permissions: 'read-all' }),
            b: job({ permissions: {} })
          }
        })
      )
    ).toEqual([]);
  });

  it('warns about each write scope granted at the workflow level', () => {
    const errors = workflowPermissionErrors(
      wf({
        permissions: {
          contents: 'write',
          issues: 'read',
          'id-token': 'write'
        }
      })
    );
    expect(errors.map((e) => [e.path, e.severity, e.rule])).toEqual([
      ['permissions.contents', 'warning', 'secureci/permissions'],
      ['permissions.id-token', 'warning', 'secureci/permissions']
    ]);
    expect(errors[0].message).toMatch(/"contents: write".*job/);
  });

  it('does not check job-level write scopes', () => {
    expect(
      workflowPermissionErrors(
        wf({ jobs: { deploy: job({ permissions: { contents: 'write' } }) } })
      )
    ).toEqual([]);
  });

  describe('reusable workflows (on: workflow_call)', () => {
    it.each([
      ['a string', 'workflow_call'],
      ['a list', ['workflow_call']],
      ['a mapping', { workflow_call: { inputs: {} } }],
      ['a mapping with a null value', { workflow_call: null }]
    ])(
      'does not flag a missing block when workflow_call (as %s) is the only trigger',
      (_label, on) => {
        expect(
          workflowPermissionErrors(wf({ on: on as WorkflowFile['on'] }))
        ).toEqual([]);
      }
    );

    it('flags a missing block when workflow_call is one of several triggers', () => {
      expect(
        workflowPermissionErrors(
          wf({ on: { workflow_call: {}, workflow_dispatch: {} } })
        )
      ).toHaveLength(1);
    });

    it('still warns about write scopes a reusable workflow declares', () => {
      expect(
        workflowPermissionErrors(
          wf({ on: 'workflow_call', permissions: 'write-all' })
        )
      ).toHaveLength(1);
    });
  });

  it('ignores a workflow without a trigger or jobs', () => {
    expect(
      workflowPermissionErrors({
        name: 'W',
        on: undefined as unknown as WorkflowFile['on'],
        jobs: undefined as unknown as WorkflowFile['jobs']
      })
    ).toEqual([]);
  });
});

describe('contractPermissionErrors (contract policy, errors)', () => {
  it('returns nothing for an empty policy', () => {
    expect(contractPermissionErrors(wf(), {})).toEqual([]);
  });

  describe('required: true', () => {
    it('errors when neither the workflow nor a job declares permissions', () => {
      expect(contractPermissionErrors(wf(), { required: true })).toEqual([
        {
          path: 'permissions',
          message: expect.stringMatching(/contract requires.*"build"/),
          severity: 'error',
          rule: 'secureci/permissions'
        }
      ]);
    });

    it('passes with a top-level block', () => {
      expect(
        contractPermissionErrors(wf({ permissions: {} }), { required: true })
      ).toEqual([]);
    });

    it('passes when every job declares permissions', () => {
      expect(
        contractPermissionErrors(
          wf({ jobs: { build: job({ permissions: 'read-all' }) } }),
          { required: true }
        )
      ).toEqual([]);
    });

    it('does not apply to a workflow whose only trigger is workflow_call', () => {
      expect(
        contractPermissionErrors(wf({ on: 'workflow_call' }), {
          required: true
        })
      ).toEqual([]);
    });

    it('reports once when max is also set', () => {
      const errors = contractPermissionErrors(wf(), {
        required: true,
        max: { contents: 'read' }
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(/contract requires/);
    });
  });

  describe('max (top-level ceiling)', () => {
    const max = {
      contents: 'read' as const,
      'pull-requests': 'write' as const
    };

    it('passes when top-level permissions are within the ceiling', () => {
      expect(
        contractPermissionErrors(
          wf({
            permissions: {
              contents: 'read',
              'pull-requests': 'read',
              issues: 'none'
            }
          }),
          { max }
        )
      ).toEqual([]);
      expect(
        contractPermissionErrors(wf({ permissions: {} }), { max })
      ).toEqual([]);
    });

    it('errors for each scope above the ceiling (unlisted scopes are capped at none)', () => {
      const errors = contractPermissionErrors(
        wf({ permissions: { contents: 'write', issues: 'read' } }),
        { max }
      );
      expect(errors.map((e) => [e.path, e.severity, e.rule])).toEqual([
        ['permissions.contents', 'error', 'secureci/permissions'],
        ['permissions.issues', 'error', 'secureci/permissions']
      ]);
      expect(errors[0].message).toMatch(
        /"contents: write".*contents: read, pull-requests: write/
      );
      expect(errors[1].message).toMatch(/"issues: read"/);
    });

    it('ignores scope values it does not recognise', () => {
      expect(
        contractPermissionErrors(
          wf({
            permissions: { contents: 'admin' } as unknown as Record<
              string,
              'read'
            >
          }),
          { max }
        )
      ).toEqual([]);
    });

    it('errors for write-all, and for read-all unless every scope may be read', () => {
      expect(
        contractPermissionErrors(wf({ permissions: 'write-all' }), { max })
      ).toEqual([
        expect.objectContaining({
          path: 'permissions',
          severity: 'error',
          message: expect.stringContaining('"write-all"')
        })
      ]);
      expect(
        contractPermissionErrors(wf({ permissions: 'read-all' }), { max })
      ).toEqual([
        expect.objectContaining({
          path: 'permissions',
          message: expect.stringContaining('"read-all"')
        })
      ]);
      const allRead = Object.fromEntries(
        GITHUB_TOKEN_SCOPES.map((s) => [s, 'read' as const])
      );
      expect(
        contractPermissionErrors(wf({ permissions: 'read-all' }), {
          max: allRead
        })
      ).toEqual([]);
      expect(
        contractPermissionErrors(wf({ permissions: 'write-all' }), {
          max: allRead
        })
      ).toHaveLength(1);
    });

    it('describes an empty ceiling as no permissions', () => {
      const errors = contractPermissionErrors(
        wf({ permissions: { contents: 'read' } }),
        { max: {} }
      );
      expect(errors[0].message).toContain('(none)');
    });

    it('does not cap job-level permissions', () => {
      expect(
        contractPermissionErrors(
          wf({
            permissions: { contents: 'read' },
            jobs: { deploy: job({ permissions: 'write-all' }) }
          }),
          { max }
        )
      ).toEqual([]);
    });

    it('errors when the workflow declares no top-level block and a job relies on the default token', () => {
      expect(contractPermissionErrors(wf(), { max })).toEqual([
        expect.objectContaining({
          path: 'permissions',
          severity: 'error',
          message: expect.stringMatching(/caps workflow-level.*"build"/)
        })
      ]);
    });

    it('passes without a top-level block when every job declares permissions', () => {
      expect(
        contractPermissionErrors(
          wf({ jobs: { build: job({ permissions: { contents: 'write' } }) } }),
          { max }
        )
      ).toEqual([]);
    });

    it('still caps a reusable workflow that declares a top-level block', () => {
      expect(
        contractPermissionErrors(
          wf({ on: 'workflow_call', permissions: { contents: 'write' } }),
          { max }
        )
      ).toHaveLength(1);
      expect(
        contractPermissionErrors(wf({ on: 'workflow_call' }), { max })
      ).toEqual([]);
    });
  });
});
