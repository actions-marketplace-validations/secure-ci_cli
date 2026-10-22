import { describe, it, expect } from 'vitest';
import {
  dangerousTriggerErrors,
  forbiddenTriggerErrors,
  workflowTriggers
} from './dangerous-triggers';
import { Job, WorkflowFile, WorkflowTrigger } from '../types';

function wf(on: WorkflowTrigger, jobs: Record<string, Job>): WorkflowFile {
  return { name: 'W', on, jobs };
}

const PR_HEAD = '${{ github.event.pull_request.head.sha }}';

function job(steps: Job['steps'], extra: Partial<Job> = {}): Job {
  return { 'runs-on': 'ubuntu-latest', steps, ...extra };
}

describe('workflowTriggers', () => {
  it('reads a single string', () => {
    expect(workflowTriggers('pull_request_target')).toEqual([
      'pull_request_target'
    ]);
  });

  it('reads a list', () => {
    expect(workflowTriggers(['push', 'workflow_run'])).toEqual([
      'push',
      'workflow_run'
    ]);
  });

  it('reads the keys of a map, including null-valued ones', () => {
    expect(
      workflowTriggers({
        push: { branches: ['main'] },
        pull_request_target: null
      })
    ).toEqual(['push', 'pull_request_target']);
  });

  it('returns no triggers for a missing or malformed on:', () => {
    expect(workflowTriggers(undefined)).toEqual([]);
    expect(workflowTriggers(42)).toEqual([]);
    expect(workflowTriggers(['push', 7])).toEqual(['push']);
  });
});

describe('dangerousTriggerErrors', () => {
  describe('untrusted checkout followed by execution (error)', () => {
    it('flags pull_request_target + head.sha checkout + run: step', () => {
      const errors = dangerousTriggerErrors(
        wf('pull_request_target', {
          build: job([
            { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
            { run: 'npm test' }
          ])
        })
      );
      expect(errors).toEqual([
        {
          path: 'jobs.build.steps[0]',
          severity: 'error',
          rule: 'secureci/dangerous-trigger',
          message: expect.stringMatching(
            /checks out untrusted code.*pull_request_target.*steps\[1\] \(run:\)/
          )
        }
      ]);
    });

    it.each([
      ['${{ github.event.pull_request.head.ref }}'],
      ['${{ github.head_ref }}'],
      ['${{ github.event.pull_request.merge_commit_sha }}'],
      ['refs/pull/${{ github.event.pull_request.number }}/merge'],
      ['${{github.event.pull_request.head.sha}}']
    ])('flags pull request ref %s', (ref) => {
      const errors = dangerousTriggerErrors(
        wf(['pull_request_target'], {
          build: job([
            { uses: 'actions/checkout@v4', with: { ref } },
            { run: 'make' }
          ])
        })
      );
      expect(errors.map((e) => e.severity)).toEqual(['error']);
    });

    it.each([
      ['${{ github.event.workflow_run.head_sha }}'],
      ['${{ github.event.workflow_run.head_branch }}'],
      ['${{ github.event.workflow_run.head_commit.id }}']
    ])('flags workflow_run ref %s', (ref) => {
      const errors = dangerousTriggerErrors(
        wf(
          { workflow_run: { workflows: ['CI'], types: ['completed'] } },
          {
            report: job([
              { uses: 'actions/checkout@v4', with: { ref } },
              { run: './report.sh' }
            ])
          }
        )
      );
      expect(errors).toEqual([
        expect.objectContaining({
          path: 'jobs.report.steps[0]',
          severity: 'error',
          message: expect.stringContaining('"workflow_run"')
        })
      ]);
    });

    it("flags a checkout of the fork's repository", () => {
      const errors = dangerousTriggerErrors(
        wf('pull_request_target', {
          build: job([
            {
              uses: 'actions/checkout@v4',
              with: {
                repository:
                  '${{ github.event.pull_request.head.repo.full_name }}'
              }
            },
            { run: 'make' }
          ])
        })
      );
      expect(errors.map((e) => e.severity)).toEqual(['error']);
    });

    it('flags a local action run after the untrusted checkout', () => {
      const errors = dangerousTriggerErrors(
        wf('pull_request_target', {
          build: job([
            { uses: 'actions/setup-node@v4' },
            { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
            { uses: 'actions/cache@v4' },
            { uses: './.github/actions/build' }
          ])
        })
      );
      expect(errors).toEqual([
        expect.objectContaining({
          path: 'jobs.build.steps[1]',
          severity: 'error',
          message: expect.stringContaining(
            'steps[3] (uses: ./.github/actions/build)'
          )
        })
      ]);
    });

    it('matches actions/checkout case-insensitively and without a version', () => {
      const errors = dangerousTriggerErrors(
        wf('pull_request_target', {
          build: job([
            { uses: 'Actions/Checkout', with: { ref: PR_HEAD } },
            { run: 'make' }
          ])
        })
      );
      expect(errors.map((e) => e.severity)).toEqual(['error']);
    });

    it('reports each affected job once and omits the trigger warning', () => {
      const errors = dangerousTriggerErrors(
        wf(
          { pull_request_target: {}, workflow_run: { workflows: ['CI'] } },
          {
            a: job([
              { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
              { run: 'one' },
              { run: 'two' }
            ]),
            b: job([
              { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
              { run: 'three' }
            ]),
            c: job([{ uses: 'actions/checkout@v4' }, { run: 'safe' }])
          }
        )
      );
      expect(errors.map((e) => [e.path, e.severity])).toEqual([
        ['jobs.a.steps[0]', 'error'],
        ['jobs.b.steps[0]', 'error']
      ]);
      expect(errors[0].message).toContain(
        '"pull_request_target", "workflow_run"'
      );
    });
  });

  describe('safe patterns (trigger warning only)', () => {
    const triggerWarning = (trigger: string) => ({
      path: `on.${trigger}`,
      severity: 'warning',
      rule: 'secureci/dangerous-trigger',
      message: expect.stringContaining(`"${trigger}"`)
    });

    it('does not flag a base checkout (no ref)', () => {
      expect(
        dangerousTriggerErrors(
          wf('pull_request_target', {
            build: job([{ uses: 'actions/checkout@v4' }, { run: 'make' }])
          })
        )
      ).toEqual([triggerWarning('pull_request_target')]);
    });

    it('does not flag a checkout of the base ref', () => {
      expect(
        dangerousTriggerErrors(
          wf('pull_request_target', {
            build: job([
              {
                uses: 'actions/checkout@v4',
                with: { ref: '${{ github.event.pull_request.base.sha }}' }
              },
              { run: 'make' }
            ])
          })
        )
      ).toEqual([triggerWarning('pull_request_target')]);
    });

    it('does not flag an untrusted checkout with no later execution', () => {
      expect(
        dangerousTriggerErrors(
          wf('pull_request_target', {
            label: job([
              { run: 'echo before' },
              { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
              { uses: 'actions/labeler@v5' }
            ])
          })
        )
      ).toEqual([triggerWarning('pull_request_target')]);
    });

    it('warns once per dangerous trigger, in every on: form', () => {
      const jobs = { a: job([{ run: 'echo hi' }]) };
      expect(dangerousTriggerErrors(wf('workflow_run', jobs))).toEqual([
        triggerWarning('workflow_run')
      ]);
      expect(
        dangerousTriggerErrors(
          wf(['push', 'pull_request_target', 'workflow_run'], jobs)
        )
      ).toEqual([
        triggerWarning('pull_request_target'),
        triggerWarning('workflow_run')
      ]);
      expect(
        dangerousTriggerErrors(
          wf({ push: null, pull_request_target: { types: ['opened'] } }, jobs)
        )
      ).toEqual([triggerWarning('pull_request_target')]);
    });

    it('ignores workflows without a privileged trigger', () => {
      expect(
        dangerousTriggerErrors(
          wf(['push', 'pull_request'], {
            build: job([
              { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
              { run: 'make' }
            ])
          })
        )
      ).toEqual([]);
    });

    it('ignores reusable-workflow jobs and jobs without steps', () => {
      expect(
        dangerousTriggerErrors(
          wf('pull_request_target', {
            call: { uses: './.github/workflows/build.yml' },
            empty: { 'runs-on': 'ubuntu-latest' }
          })
        )
      ).toEqual([triggerWarning('pull_request_target')]);
    });
  });

  describe('label-gated jobs (downgraded to warning)', () => {
    it.each([
      ["contains(github.event.pull_request.labels.*.name, 'safe to test')"],
      ["github.event.label.name == 'safe to test'"],
      ["${{ github.event.label.name == 'ok-to-test' }}"]
    ])('downgrades a job gated by %s', (condition) => {
      const errors = dangerousTriggerErrors(
        wf('pull_request_target', {
          test: job(
            [
              { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
              { run: 'npm test' }
            ],
            { if: condition }
          )
        })
      );
      expect(errors).toEqual([
        {
          path: 'jobs.test.steps[0]',
          severity: 'warning',
          rule: 'secureci/dangerous-trigger',
          message: expect.stringContaining('gated by a label check')
        }
      ]);
    });

    it('still errors when the job if: is not a label check', () => {
      const errors = dangerousTriggerErrors(
        wf('pull_request_target', {
          test: job(
            [
              { uses: 'actions/checkout@v4', with: { ref: PR_HEAD } },
              { run: 'npm test' }
            ],
            { if: "github.repository == 'org/repo'" }
          )
        })
      );
      expect(errors.map((e) => e.severity)).toEqual(['error']);
    });
  });
});

describe('forbiddenTriggerErrors', () => {
  const jobs = { a: job([{ run: 'echo hi' }]) };

  it('errors once per forbidden trigger the workflow uses', () => {
    expect(
      forbiddenTriggerErrors(
        { name: 'W', on: ['push', 'pull_request_target'], jobs },
        ['pull_request_target', 'workflow_run']
      )
    ).toEqual([
      {
        path: 'on.pull_request_target',
        severity: 'error',
        rule: 'secureci/contract',
        message:
          'Trigger "pull_request_target" is forbidden by the pipeline contract (forbidden-triggers)'
      }
    ]);
  });

  it('checks string and map forms, and passes when nothing matches', () => {
    expect(
      forbiddenTriggerErrors({ name: 'W', on: 'workflow_run', jobs }, [
        'workflow_run'
      ])
    ).toHaveLength(1);
    expect(
      forbiddenTriggerErrors(
        { name: 'W', on: { workflow_run: null, push: null }, jobs },
        ['workflow_run']
      )
    ).toHaveLength(1);
    expect(
      forbiddenTriggerErrors({ name: 'W', on: 'push', jobs }, [
        'pull_request_target'
      ])
    ).toEqual([]);
  });
});
