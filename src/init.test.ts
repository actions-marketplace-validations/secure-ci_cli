import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import { renderInitWorkflow } from './init';

describe('renderInitWorkflow', () => {
  it('produces a valid workflow using the SecureCI action', () => {
    const yml = renderInitWorkflow({});
    const doc = YAML.parse(yml);
    expect(doc.name).toBe('SecureCI');
    expect(doc.on).toEqual(['pull_request']);
    const steps = doc.jobs.secureci.steps;
    expect(steps[0].uses).toBe('actions/checkout@v4');
    expect(steps[1].uses).toBe('secure-ci/cli@v1');
  });

  it('requests security-events: write and uploads SARIF by default', () => {
    const doc = YAML.parse(renderInitWorkflow({}));
    expect(doc.permissions['security-events']).toBe('write');
    expect(doc.jobs.secureci.steps[1].with?.['upload-sarif']).toBeUndefined();
  });

  it('drops the SARIF permission and upload when upload is off', () => {
    const doc = YAML.parse(renderInitWorkflow({ upload: false }));
    expect(doc.permissions['security-events']).toBeUndefined();
    expect(doc.permissions.contents).toBe('read');
    expect(doc.jobs.secureci.steps[1].with['upload-sarif']).toBe(false);
  });

  it('wires a contract path into the action inputs', () => {
    const doc = YAML.parse(
      renderInitWorkflow({ contract: 'contracts/standard.yml' })
    );
    expect(doc.jobs.secureci.steps[1].with.contract).toBe(
      'contracts/standard.yml'
    );
  });

  it('is deterministic', () => {
    expect(renderInitWorkflow({ contract: 'c.yml' })).toBe(
      renderInitWorkflow({ contract: 'c.yml' })
    );
  });
});
