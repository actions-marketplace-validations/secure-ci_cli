import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  actionDirInContainer,
  stepDisplayName,
  type JobContainerHandle
} from './job-runtime';
import { CONTAINER_EXCHANGE_DIR } from './container-runtime';
import { createContext } from './expression';

describe('stepDisplayName', () => {
  const ctx = {
    ...createContext({}, {}, {}, {}, { os: 'linux' })
  };

  it('substitutes expressions in a step name', () => {
    expect(stepDisplayName({ name: 'Build ${{ matrix.os }}' }, ctx)).toBe(
      'Build linux'
    );
  });

  it('returns the name verbatim without a context', () => {
    expect(stepDisplayName({ name: 'Plain name' })).toBe('Plain name');
  });

  it('falls back to the uses reference', () => {
    expect(stepDisplayName({ uses: 'actions/checkout@v4' })).toBe(
      'actions/checkout@v4'
    );
  });

  it('falls back to the first non-empty line of run', () => {
    expect(stepDisplayName({ run: '\n  npm ci\n  npm test\n' })).toBe('npm ci');
    expect(stepDisplayName({ run: 'echo ${{ matrix.os }}' }, ctx)).toBe(
      'echo linux'
    );
  });

  it('is "step" for an empty step', () => {
    expect(stepDisplayName({})).toBe('step');
  });
});

describe('actionDirInContainer', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-jobrt-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('copies the action under a SHA-256-derived name (no SHA-1)', () => {
    const actionDir = path.join(tmp, 'action');
    fs.mkdirSync(actionDir);
    fs.writeFileSync(path.join(actionDir, 'action.yml'), 'name: x\n');
    const exchangeDir = path.join(tmp, 'exchange');
    const container = {
      exchangeDir,
      actionDirs: new Map<string, string>()
    } as unknown as JobContainerHandle;

    const hash = crypto
      .createHash('sha256')
      .update(actionDir)
      .digest('hex')
      .slice(0, 12);
    expect(actionDirInContainer(container, actionDir)).toBe(
      `${CONTAINER_EXCHANGE_DIR}/actions/${hash}`
    );
    expect(
      fs.existsSync(path.join(exchangeDir, 'actions', hash, 'action.yml'))
    ).toBe(true);
  });
});
