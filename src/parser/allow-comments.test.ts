import { describe, it, expect } from 'vitest';
import { stepAllowComments } from './allow-comments';

const RULE = 'dangerous-trigger';

function yaml(...lines: string[]): string {
  return lines.join('\n');
}

describe('stepAllowComments', () => {
  it('reads a trailing comment on the step line', () => {
    const content = yaml(
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: echo hi',
      '      - uses: actions/checkout@v4 # secureci-allow dangerous-trigger: on main during migration',
      '        with:',
      '          ref: x'
    );
    expect(stepAllowComments(content, RULE)).toEqual(
      new Map([['jobs.build.steps[1]', 'on main during migration']])
    );
  });

  it('reads comment lines directly above the step', () => {
    const content = yaml(
      'jobs:',
      '  build:',
      '    steps:',
      '      # Reviewed by the platform team.',
      '      #secureci-allow   dangerous-trigger:  reviewed  ',
      '      - uses: actions/checkout@v4',
      '  other:',
      '    steps:',
      '      - run: echo'
    );
    expect(stepAllowComments(content, RULE)).toEqual(
      new Map([['jobs.build.steps[0]', 'reviewed']])
    );
  });

  it('records an empty reason when none is given', () => {
    const content = yaml(
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: actions/checkout@v4 # secureci-allow dangerous-trigger',
      '      - uses: actions/checkout@v4 # secureci-allow dangerous-trigger:'
    );
    expect(stepAllowComments(content, RULE)).toEqual(
      new Map([
        ['jobs.build.steps[0]', ''],
        ['jobs.build.steps[1]', '']
      ])
    );
  });

  it('ignores other rules, separated comments and comments inside a step', () => {
    const content = yaml(
      'jobs:',
      '  build:',
      '    steps:',
      '      - uses: a/b@v1 # secureci-allow other-rule: nope',
      '      # secureci-allow dangerous-trigger: separated by a blank line',
      '',
      '      - uses: actions/checkout@v4',
      '        with: # secureci-allow dangerous-trigger: not the step line',
      '          ref: x',
      '      - run: echo "# secureci-allow dangerous-trigger: in a string"'
    );
    expect(stepAllowComments(content, RULE)).toEqual(new Map());
  });

  it('returns nothing for invalid or step-less YAML', () => {
    expect(stepAllowComments('jobs: [', RULE)).toEqual(new Map());
    expect(stepAllowComments('name: x', RULE)).toEqual(new Map());
  });
});
