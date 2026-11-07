import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as YAML from 'yaml';
import { renderInitWorkflow } from './init';
import { validateWorkflow } from './parser/validator';

describe('renderInitWorkflow', () => {
  it('produces a valid workflow using the SecureCI action', () => {
    const yml = renderInitWorkflow({ version: '1.2.3' });
    const doc = YAML.parse(yml);
    expect(doc.name).toBe('SecureCI');
    expect(doc.on).toEqual(['pull_request']);
    const steps = doc.jobs.secureci.steps;
    expect(steps[0].uses).toBe('actions/checkout@v4');
    // Pinned to the release tag of the CLI that generated it: the action has
    // no moving major tag, so `@v1`-style refs would not resolve.
    expect(steps[1].uses).toBe('secure-ci/cli@v1.2.3');
  });

  it('requests actions: read and security-events: write on the job and uploads SARIF by default', () => {
    const doc = YAML.parse(renderInitWorkflow({ version: '1.2.3' }));
    // Write scopes go on the job, not the workflow (#45). Job-level
    // permissions replace the top-level ones, so contents: read is repeated.
    expect(doc.permissions).toEqual({ contents: 'read' });
    // upload-sarif needs actions: read (workflow run info, private repos)
    // and security-events: write (the upload itself).
    expect(doc.jobs.secureci.permissions).toEqual({
      contents: 'read',
      actions: 'read',
      'security-events': 'write'
    });
    expect(doc.jobs.secureci.steps[1].with?.['upload-sarif']).toBeUndefined();
  });

  it('notes in a comment that code scanning must be enabled for the SARIF upload', () => {
    const yml = renderInitWorkflow({ version: '1.2.3' });
    const comments = yml
      .split('\n')
      .filter((line) => line.trimStart().startsWith('#'))
      .join('\n');
    expect(comments).toMatch(/code scanning/i);
    expect(comments).toMatch(/enabled/i);
    expect(comments).toContain('upload-sarif: false');
  });

  it('omits the code scanning comment when upload is off', () => {
    const yml = renderInitWorkflow({ version: '1.2.3', upload: false });
    expect(yml).not.toMatch(/code scanning/i);
  });

  it('drops the SARIF permission and upload when upload is off', () => {
    const doc = YAML.parse(
      renderInitWorkflow({ version: '1.2.3', upload: false })
    );
    expect(doc.permissions).toEqual({ contents: 'read' });
    expect(doc.jobs.secureci.permissions).toBeUndefined();
    expect(doc.jobs.secureci.steps[1].with['upload-sarif']).toBe(false);
  });

  it('wires a contract path into the action inputs', () => {
    const doc = YAML.parse(
      renderInitWorkflow({
        version: '1.2.3',
        contract: 'contracts/standard.yml'
      })
    );
    expect(doc.jobs.secureci.steps[1].with.contract).toBe(
      'contracts/standard.yml'
    );
  });

  it('is deterministic', () => {
    expect(renderInitWorkflow({ version: '1.2.3', contract: 'c.yml' })).toBe(
      renderInitWorkflow({ version: '1.2.3', contract: 'c.yml' })
    );
  });

  it.each([true, false])(
    'passes secureci validate with no findings (upload: %s)',
    (upload) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secureci-init-'));
      const file = path.join(dir, 'secureci.yml');
      try {
        fs.writeFileSync(
          file,
          renderInitWorkflow({ version: '1.2.3', upload })
        );
        expect(validateWorkflow(file)).toEqual({ valid: true, errors: [] });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
