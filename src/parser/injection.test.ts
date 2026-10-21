import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  UNTRUSTED_CONTEXTS,
  actionInjectionErrors,
  workflowInjectionErrors
} from './injection';
import { validateAction, validateWorkflow } from './validator';
import { parseAction, parseWorkflow } from './workflow-parser';
import { formatReport } from '../report';

describe('template injection checks', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-injection-'));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  /** Write a file under the temp repository and return its path. */
  const write = (relative: string, lines: string[]): string => {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n'));
    return file;
  };

  /** A workflow at .github/workflows/ci.yml with the given job lines. */
  const workflow = (jobLines: string[], on = 'push'): string =>
    write('.github/workflows/ci.yml', [
      'name: CI',
      `on: ${on}`,
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      ...jobLines.map((l) => `    ${l}`)
    ]);

  /** A workflow whose only job runs one script. */
  const runScript = (script: string, on = 'push'): string =>
    workflow(['steps:', `  - run: ${script}`], on);

  const check = (file: string) =>
    workflowInjectionErrors(parseWorkflow(file).file, file);

  describe('run: steps', () => {
    it('flags untrusted input expanded into a run: script', () => {
      const errors = check(
        runScript('echo "${{ github.event.pull_request.title }}"')
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        path: 'jobs.a.steps[0].run',
        severity: 'error',
        rule: 'secureci/injection'
      });
      expect(errors[0].message).toContain('github.event.pull_request.title');
    });

    it('suggests passing the value through env: and quoting the variable', () => {
      const [error] = check(runScript('echo "${{ github.head_ref }}"'));
      expect(error.message).toContain(
        'env: (e.g. env: HEAD_REF: ${{ github.head_ref }})'
      );
      expect(error.message).toContain('"$HEAD_REF"');
    });

    it('flags each untrusted expression in a step separately', () => {
      const errors = check(
        runScript(
          '"echo ${{ github.event.issue.title }} ${{ github.sha }} ${{ github.event.issue.body }}"'
        )
      );
      expect(errors.map((e) => e.message)).toEqual([
        expect.stringContaining('github.event.issue.title'),
        expect.stringContaining('github.event.issue.body')
      ]);
      expect(errors.every((e) => e.path === 'jobs.a.steps[0].run')).toBe(true);
    });

    it('flags multi-line scripts and later steps at their own path', () => {
      const file = workflow([
        'steps:',
        '  - run: echo ok',
        '  - run: |',
        '      echo start',
        '      git checkout "${{ github.event.pull_request.head.ref }}"'
      ]);
      expect(check(file).map((e) => e.path)).toEqual(['jobs.a.steps[1].run']);
    });

    it.each([
      'github.event.issue.title',
      'github.event.issue.body',
      'github.event.comment.body',
      'github.event.review.body',
      'github.event.head_commit.message',
      'github.event.head_commit.author.email',
      'github.event.head_commit.author.name',
      'github.event.commits[0].message',
      'github.event.commits.*.author.name',
      'github.event.pages[1].page_name',
      'github.event.pull_request.head.label',
      'github.event.pull_request.head.repo.default_branch',
      'github.event.pull_request.labels[0].name',
      'github.event.workflow_run.head_branch',
      'github.event.discussion.title',
      'GITHUB.HEAD_REF',
      "github.event['issue']['title']"
    ])('flags %s', (expr) => {
      expect(check(runScript(`echo "\${{ ${expr} }}"`))).toHaveLength(1);
    });

    it.each([
      'github.sha',
      'github.run_id',
      'github.run_number',
      'github.repository',
      'github.actor',
      'github.ref',
      'github.event_name',
      'github.workspace',
      'github.event.pull_request.number',
      'github.event.pull_request.head.sha',
      'github.event.issue.number',
      'github.event.pull_request',
      'secrets.TOKEN',
      'steps.build.outputs.version',
      'matrix.os',
      'env.NAME',
      'runner.os',
      'inputs.name',
      "'literal'"
    ])('does not flag %s', (expr) => {
      expect(check(runScript(`echo "\${{ ${expr} }}"`))).toEqual([]);
    });

    it('does not flag untrusted input in env: values, the recommended fix', () => {
      const file = write('.github/workflows/ci.yml', [
        'name: CI',
        'on: pull_request',
        'env:',
        '  WF_TITLE: ${{ github.event.pull_request.title }}',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      JOB_TITLE: ${{ github.event.pull_request.title }}',
        '    steps:',
        '      - run: echo "$TITLE"',
        '        env:',
        '          TITLE: ${{ github.event.pull_request.title }}'
      ]);
      expect(check(file)).toEqual([]);
    });

    it('does not flag the with: inputs of other actions', () => {
      const file = workflow([
        'steps:',
        '  - uses: some/action@v1',
        '    with:',
        '      title: ${{ github.event.issue.title }}'
      ]);
      expect(check(file)).toEqual([]);
    });

    it('skips an expression with a syntax error', () => {
      expect(check(runScript('echo "${{ github.head_ref == }}"'))).toEqual([]);
    });
  });

  describe('expressions with functions and operators', () => {
    it.each([
      'toJSON(github.event)',
      'toJSON(github.event.pull_request)',
      'toJSON(github)',
      "format('Title={0}', github.event.issue.title)",
      "join(github.event.commits.*.message, ' ')",
      "github.event.issue.title || 'untitled'",
      'fromJSON(toJSON(github.event)).issue.title',
      '(github.event.pull_request || github.event.issue).title'
    ])('flags %s', (expr) => {
      expect(check(runScript(`echo "\${{ ${expr} }}"`))).toHaveLength(1);
    });

    it.each([
      "contains(github.event.issue.title, 'bug')",
      "startsWith(github.head_ref, 'release/')",
      "github.event.pull_request.title == 'x'",
      '!github.event.issue.body',
      'toJSON(github.event.pull_request.number)',
      'toJSON(matrix)',
      "format('{0}', github.sha)"
    ])('does not flag %s', (expr) => {
      expect(check(runScript(`echo "\${{ ${expr} }}"`))).toEqual([]);
    });
  });

  describe('actions/github-script', () => {
    it('flags untrusted input in with.script', () => {
      const file = workflow([
        'steps:',
        '  - uses: actions/github-script@v7',
        '    with:',
        "      script: console.log('${{ github.event.issue.body }}')"
      ]);
      const errors = check(file);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('jobs.a.steps[0].with.script');
      expect(errors[0].message).toContain('github.event.issue.body');
      expect(errors[0].message).toContain('process.env.BODY');
    });

    it('does not flag github-script inputs other than script', () => {
      const file = workflow([
        'steps:',
        '  - uses: actions/github-script@v7',
        '    with:',
        '      github-token: ${{ github.event.issue.title }}',
        '      script: console.log(process.env.TITLE)'
      ]);
      expect(check(file)).toEqual([]);
    });
  });

  describe('workflow inputs', () => {
    const dispatch = [
      '',
      '  workflow_dispatch:',
      '    inputs:',
      '      name:',
      '        description: Name',
      '      flag:',
      '        type: boolean',
      '      count:',
      '        type: number',
      '      level:',
      '        type: choice',
      '        options: [a, b]',
      '      target:',
      '        type: environment'
    ].join('\n');

    it('flags string inputs of workflow_dispatch', () => {
      const errors = check(runScript('echo "${{ inputs.name }}"', dispatch));
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('inputs.name');
    });

    it('flags github.event.inputs for string inputs', () => {
      expect(
        check(runScript('echo "${{ github.event.inputs.name }}"', dispatch))
      ).toHaveLength(1);
    });

    it.each(['inputs.flag', 'inputs.count', 'inputs.level', 'inputs.target'])(
      'does not flag the typed input %s',
      (expr) => {
        expect(check(runScript(`echo "\${{ ${expr} }}"`, dispatch))).toEqual(
          []
        );
      }
    );

    it('flags toJSON(inputs) when there is a string input', () => {
      expect(
        check(runScript('echo "${{ toJSON(inputs) }}"', dispatch))
      ).toHaveLength(1);
    });

    it('flags string inputs of workflow_call', () => {
      const on = [
        '',
        '  push:',
        '  workflow_call:',
        '    inputs:',
        '      tag:',
        '        type: string',
        '        required: true'
      ].join('\n');
      expect(check(runScript('echo "${{ inputs.tag }}"', on))).toHaveLength(1);
    });

    it('does not flag inputs the workflow does not declare', () => {
      expect(
        check(runScript('echo "${{ inputs.tag }}"', '[push, workflow_call]'))
      ).toEqual([]);
    });
  });

  describe('local composite actions', () => {
    const greet = (runLine: string, extra: string[] = []) =>
      write('.github/actions/greet/action.yml', [
        'name: Greet',
        'description: Says hello',
        ...extra,
        'runs:',
        '  using: composite',
        '  steps:',
        `    - run: ${runLine}`,
        '      shell: bash'
      ]);

    const nameInput = ['inputs:', '  name:', '    description: Who to greet'];

    it('flags untrusted input used inside a local composite action', () => {
      greet('echo "${{ github.event.issue.title }}"');
      const errors = check(
        workflow(['steps:', '  - uses: ./.github/actions/greet'])
      );
      expect(errors.map((e) => e.path)).toEqual([
        'jobs.a.steps[0] > ./.github/actions/greet > steps[0].run'
      ]);
    });

    it('flags an action input the caller fills with untrusted input', () => {
      greet('echo "${{ inputs.name }}"', nameInput);
      const errors = check(
        workflow([
          'steps:',
          '  - uses: ./.github/actions/greet',
          '    with:',
          '      name: ${{ github.event.issue.title }}'
        ])
      );
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe(
        'jobs.a.steps[0] > ./.github/actions/greet > steps[0].run'
      );
      expect(errors[0].message).toContain('inputs.name');
    });

    it('does not flag an action input the caller fills with trusted data', () => {
      greet('echo "${{ inputs.name }}"', nameInput);
      expect(
        check(
          workflow([
            'steps:',
            '  - uses: ./.github/actions/greet',
            '    with:',
            '      name: ${{ github.sha }}'
          ])
        )
      ).toEqual([]);
    });

    it('flags an input whose default is untrusted when the caller omits it', () => {
      greet('echo "${{ inputs.name }}"', [
        ...nameInput,
        '    default: ${{ github.head_ref }}'
      ]);
      expect(
        check(workflow(['steps:', '  - uses: ./.github/actions/greet']))
      ).toHaveLength(1);
    });

    it('follows nested local composite actions', () => {
      write('.github/actions/outer/action.yml', [
        'name: Outer',
        'description: Wraps greet',
        'inputs:',
        '  title:',
        '    description: Title',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: ./.github/actions/greet',
        '      with:',
        '        name: ${{ inputs.title }}'
      ]);
      greet('echo "${{ inputs.name }}"', nameInput);
      const errors = check(
        workflow([
          'steps:',
          '  - uses: ./.github/actions/outer',
          '    with:',
          '      title: ${{ github.event.pull_request.title }}'
        ])
      );
      expect(errors.map((e) => e.path)).toEqual([
        'jobs.a.steps[0] > ./.github/actions/outer > steps[0] > ./.github/actions/greet > steps[0].run'
      ]);
    });

    it('stops at cycles and ignores actions it cannot find or parse', () => {
      write('.github/actions/loop/action.yml', [
        'name: Loop',
        'description: Calls itself',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: ./.github/actions/loop'
      ]);
      write('.github/actions/broken/action.yml', ['name: [unclosed']);
      write('.github/actions/js/action.yml', [
        'name: JS',
        'description: A JavaScript action',
        'runs:',
        '  using: node20',
        '  main: index.js'
      ]);
      const file = workflow([
        'steps:',
        '  - uses: ./.github/actions/loop',
        '  - uses: ./.github/actions/missing',
        '  - uses: ./.github/actions/broken',
        '  - uses: ./.github/actions/js',
        '    with:',
        '      title: ${{ github.event.issue.title }}'
      ]);
      expect(check(file)).toEqual([]);
    });

    it('checks a standalone composite action, without flagging its inputs', () => {
      const file = greet(
        'echo "${{ github.event.issue.title }} ${{ inputs.name }}"',
        nameInput
      );
      const errors = actionInjectionErrors(parseAction(file).file, file);
      expect(errors).toHaveLength(1);
      expect(errors[0].path).toBe('runs.steps[0].run');
      expect(errors[0].message).toContain('github.event.issue.title');
    });
  });

  describe('local reusable workflows', () => {
    it('flags untrusted input inside a called local workflow', () => {
      write('.github/workflows/reusable.yml', [
        'name: Reusable',
        'on: workflow_call',
        'jobs:',
        '  x:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo "${{ github.head_ref }}"'
      ]);
      const file = write('.github/workflows/ci.yml', [
        'name: CI',
        'on: pull_request',
        'jobs:',
        '  call:',
        '    uses: ./.github/workflows/reusable.yml'
      ]);
      expect(check(file).map((e) => e.path)).toEqual([
        'jobs.call > ./.github/workflows/reusable.yml > jobs.x.steps[0].run'
      ]);
    });
  });

  it('ignores remote, missing, cyclic and non-workflow called workflows', () => {
    write('action.yml', [
      'name: A',
      'description: Not a workflow',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - run: echo "${{ github.head_ref }}"',
      '      shell: bash'
    ]);
    const file = write('.github/workflows/ci.yml', [
      'name: CI',
      'on: pull_request',
      'jobs:',
      '  remote:',
      '    uses: org/repo/.github/workflows/x.yml@v1',
      '  missing:',
      '    uses: ./.github/workflows/missing.yml',
      '  self:',
      '    uses: ./.github/workflows/ci.yml',
      '  action:',
      '    uses: ./action.yml',
      '  empty:',
      '    runs-on: ubuntu-latest'
    ]);
    expect(check(file)).toEqual([]);
  });

  it('finds nothing in an action without steps', () => {
    const file = write('action.yml', [
      'name: A',
      'description: B',
      'runs:',
      '  using: node20',
      '  main: index.js'
    ]);
    expect(actionInjectionErrors(parseAction(file).file, file)).toEqual([]);
  });

  describe('validator and report integration', () => {
    it('makes validateWorkflow fail with the finding', () => {
      const result = validateWorkflow(
        runScript('echo "${{ github.event.issue.title }}"')
      );
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.rule)).toEqual(['secureci/injection']);
    });

    it('makes validateAction fail with the finding', () => {
      const file = write('action.yml', [
        'name: A',
        'description: B',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - run: echo "${{ github.event.comment.body }}"',
        '      shell: bash'
      ]);
      const result = validateAction(file);
      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.path)).toEqual(['runs.steps[0].run']);
    });

    it('reports the finding under the secureci/injection SARIF rule', () => {
      const file = runScript('echo "${{ github.head_ref }}"');
      const sarif = JSON.parse(
        formatReport([{ file, result: validateWorkflow(file) }], 'sarif')
      );
      const run = sarif.runs[0];
      expect(run.results.map((r: { ruleId: string }) => r.ruleId)).toEqual([
        'secureci/injection'
      ]);
      expect(run.tool.driver.rules).toContainEqual({
        id: 'secureci/injection',
        name: 'Untrusted input in a shell or script'
      });
    });

    it('includes the finding in --format json', () => {
      const file = runScript('echo "${{ github.head_ref }}"');
      const json = JSON.parse(
        formatReport([{ file, result: validateWorkflow(file) }], 'json')
      );
      expect(json.valid).toBe(false);
      expect(json.errors[0]).toMatchObject({
        path: 'jobs.a.steps[0].run',
        severity: 'error'
      });
    });
  });

  it('documents the untrusted contexts as a constant', () => {
    expect(UNTRUSTED_CONTEXTS).toEqual(
      expect.arrayContaining([
        'github.head_ref',
        'github.event.pull_request.title',
        'github.event.commits.*.message'
      ])
    );
  });
});
