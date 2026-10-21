import {
  mergeValidationResults,
  validateWorkflow,
  validateAction
} from './validator';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Validator', () => {
  const fixturesDir = path.join(__dirname, '../../test/fixtures');

  describe('validateWorkflow', () => {
    it('should validate a correct workflow', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = validateWorkflow(workflowPath);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const workflowPath = path.join(fixturesDir, 'invalid-workflow.yml');
      const result = validateWorkflow(workflowPath);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('reports invalid if: expressions with their location', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-if-'));
      const file = path.join(dir, 'wf.yml');
      fs.writeFileSync(
        file,
        [
          'name: If',
          'on: push',
          'permissions: {}',
          'jobs:',
          '  a:',
          '    runs-on: ubuntu-latest',
          "    if: matrix.os == 'linux'",
          '    steps:',
          '      - run: echo ok',
          '        if: ${{ success() }}',
          '      - run: echo bad',
          '        if: github.ref == ',
          '      - run: echo fn',
          '        if: bogus()'
        ].join('\n')
      );
      try {
        const result = validateWorkflow(file);
        expect(result.valid).toBe(false);
        expect(result.errors.map((e) => [e.path, e.message])).toEqual([
          [
            'jobs.a.if',
            expect.stringContaining("Unrecognized named-value: 'matrix'")
          ],
          ['jobs.a.steps[1].if', expect.any(String)],
          [
            'jobs.a.steps[2].if',
            expect.stringContaining("Unrecognized function: 'bogus'")
          ]
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    describe('GITHUB_TOKEN permissions (#45)', () => {
      const write = (content: string[]): { dir: string; file: string } => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-perm-'));
        const file = path.join(dir, 'wf.yml');
        fs.writeFileSync(file, content.join('\n'));
        return { dir, file };
      };
      const jobs = [
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo ok'
      ];

      it('warns about a missing permissions block without failing validation', () => {
        const { dir, file } = write(['name: P', 'on: push', ...jobs]);
        try {
          const result = validateWorkflow(file);
          expect(result.valid).toBe(true);
          expect(result.errors).toEqual([
            expect.objectContaining({
              path: 'permissions',
              severity: 'warning',
              rule: 'secureci/permissions'
            })
          ]);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });

      it('warns about write-all and workflow-level write scopes', () => {
        const { dir, file } = write([
          'name: P',
          'on: push',
          'permissions: write-all',
          ...jobs
        ]);
        try {
          const result = validateWorkflow(file);
          expect(result.valid).toBe(true);
          expect(result.errors.map((e) => e.path)).toEqual(['permissions']);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });

      it('accepts a reusable workflow without a permissions block', () => {
        const { dir, file } = write(['name: P', 'on: workflow_call', ...jobs]);
        try {
          expect(validateWorkflow(file).errors).toEqual([]);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    });

    describe('dangerous triggers (#46)', () => {
      function validate(lines: string[]) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-trig-'));
        const file = path.join(dir, 'wf.yml');
        fs.writeFileSync(file, lines.join('\n'));
        try {
          return validateWorkflow(file);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }

      it('fails a pull_request_target workflow that runs the PR head', () => {
        const result = validate([
          'name: PR',
          'on: pull_request_target',
          'permissions: {}',
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '        with:',
          '          ref: ${{ github.event.pull_request.head.sha }}',
          '      - run: npm test'
        ]);
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual([
          expect.objectContaining({
            path: 'jobs.build.steps[0]',
            severity: 'error',
            rule: 'secureci/dangerous-trigger'
          })
        ]);
      });

      it('passes with a warning when the trigger is used safely', () => {
        const result = validate([
          'name: PR',
          'on:',
          '  pull_request_target:',
          '    types: [opened]',
          'permissions: {}',
          'jobs:',
          '  label:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      - run: echo labelling'
        ]);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([
          expect.objectContaining({
            path: 'on.pull_request_target',
            severity: 'warning'
          })
        ]);
      });
    });

    it('should validate job structure', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = validateWorkflow(workflowPath);

      expect(result.valid).toBe(true);
    });
  });

  describe('validateAction', () => {
    it('should validate a correct action', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = validateAction(actionPath);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const actionPath = path.join(fixturesDir, 'invalid-action.yml');
      const result = validateAction(actionPath);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should validate composite action steps', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = validateAction(actionPath);

      expect(result.valid).toBe(true);
    });
  });

  describe('mergeValidationResults', () => {
    const warning = {
      path: 'permissions',
      message: 'w',
      severity: 'warning' as const,
      rule: 'secureci/permissions'
    };
    const error = { ...warning, message: 'e', severity: 'error' as const };

    it('drops a warning an error at the same path and rule supersedes', () => {
      expect(
        mergeValidationResults(
          { valid: true, errors: [warning] },
          { valid: false, errors: [error] }
        )
      ).toEqual({ valid: false, errors: [error] });
    });

    it('keeps warnings at other paths, of other rules, or without a rule', () => {
      const other = { ...warning, path: 'permissions.contents' };
      const otherRule = { ...warning, rule: 'secureci/contract' };
      const noRule = {
        path: 'permissions',
        message: 'x',
        severity: 'warning' as const
      };
      const noRuleError = { ...noRule, severity: 'error' as const };
      const merged = mergeValidationResults(
        { valid: true, errors: [other, otherRule, noRule] },
        { valid: false, errors: [error, noRuleError] }
      );
      expect(merged.errors).toEqual([
        other,
        otherRule,
        noRule,
        error,
        noRuleError
      ]);
    });

    it('is valid only when every result is valid', () => {
      expect(
        mergeValidationResults(
          { valid: true, errors: [] },
          { valid: true, errors: [warning] }
        ).valid
      ).toBe(true);
    });
  });
});
