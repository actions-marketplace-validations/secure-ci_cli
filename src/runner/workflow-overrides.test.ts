import { describe, it, expect } from 'vitest';
import { applyWorkflowOverrides } from './workflow-overrides';
import type { WorkflowFile } from '../types';

function workflow(jobs: WorkflowFile['jobs']): WorkflowFile {
  return { name: 'wf', on: 'push', jobs };
}

describe('applyWorkflowOverrides', () => {
  it('leaves the workflow unchanged with no overrides', () => {
    const wf = workflow({ build: { 'runs-on': 'my-runner', steps: [] } });
    const { workflow: out, changes } = applyWorkflowOverrides(wf, {});
    expect(out).toEqual(wf);
    expect(changes).toEqual([]);
  });

  it('replaces every job runs-on with a string', () => {
    const wf = workflow({
      a: { 'runs-on': 'corp-runner', steps: [] },
      b: { 'runs-on': ['self-hosted', 'linux'], steps: [] }
    });
    const { workflow: out, changes } = applyWorkflowOverrides(wf, {
      'runs-on': 'ubuntu-latest'
    });
    expect(out.jobs.a['runs-on']).toBe('ubuntu-latest');
    expect(out.jobs.b['runs-on']).toBe('ubuntu-latest');
    expect(changes).toContain('jobs.a.runs-on: corp-runner -> ubuntu-latest');
    expect(changes).toContain(
      'jobs.b.runs-on: self-hosted, linux -> ubuntu-latest'
    );
  });

  it('does not mutate the input workflow', () => {
    const wf = workflow({
      a: {
        'runs-on': 'corp-runner',
        container: { image: 'corp/img:1' },
        services: { db: 'corp/pg:1' },
        steps: []
      }
    });
    const before = JSON.parse(JSON.stringify(wf));
    applyWorkflowOverrides(wf, {
      'runs-on': 'ubuntu-latest',
      'container-image': 'node:23',
      'service-images': 'postgres:16'
    });
    expect(wf).toEqual(before);
  });

  it('with a map, replaces runs-on only when a key equals the value or any label', () => {
    const wf = workflow({
      a: { 'runs-on': 'corp-runner', steps: [] },
      b: { 'runs-on': ['self-hosted', 'gpu'], steps: [] },
      c: { 'runs-on': 'ubuntu-22.04', steps: [] }
    });
    const { workflow: out } = applyWorkflowOverrides(wf, {
      'runs-on': { 'corp-runner': 'ubuntu-latest', gpu: 'ubuntu-24.04' }
    });
    expect(out.jobs.a['runs-on']).toBe('ubuntu-latest');
    expect(out.jobs.b['runs-on']).toBe('ubuntu-24.04');
    expect(out.jobs.c['runs-on']).toBe('ubuntu-22.04');
  });

  it('matches labels of the runs-on group/labels object form', () => {
    const wf = workflow({
      a: {
        'runs-on': { group: 'corp', labels: ['big'] } as unknown as string,
        steps: []
      }
    });
    const { workflow: out } = applyWorkflowOverrides(wf, {
      'runs-on': { big: 'ubuntu-latest' }
    });
    expect(out.jobs.a['runs-on']).toBe('ubuntu-latest');
  });

  it('skips jobs without runs-on (reusable workflow calls)', () => {
    const wf = workflow({ call: { uses: './.github/workflows/x.yml' } });
    const { workflow: out, changes } = applyWorkflowOverrides(wf, {
      'runs-on': 'ubuntu-latest'
    });
    expect(out.jobs.call['runs-on']).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it('replaces job container images (string and object form), keeping other container settings', () => {
    const wf = workflow({
      a: { 'runs-on': 'x', container: 'corp/img:1', steps: [] },
      b: {
        'runs-on': 'x',
        container: { image: 'corp/img:2', env: { A: '1' } },
        steps: []
      },
      c: { 'runs-on': 'x', steps: [] }
    });
    const { workflow: out, changes } = applyWorkflowOverrides(wf, {
      'container-image': 'node:23'
    });
    expect(out.jobs.a.container).toBe('node:23');
    expect(out.jobs.b.container).toEqual({ image: 'node:23', env: { A: '1' } });
    // A job without container: doesn't get one.
    expect(out.jobs.c.container).toBeUndefined();
    expect(changes).toContain('jobs.a.container: corp/img:1 -> node:23');
  });

  it('with a map, replaces only matching container images', () => {
    const wf = workflow({
      a: { 'runs-on': 'x', container: 'corp/img:1', steps: [] },
      b: { 'runs-on': 'x', container: { image: 'other:1' }, steps: [] }
    });
    const { workflow: out } = applyWorkflowOverrides(wf, {
      'container-image': { 'corp/img:1': 'node:23' }
    });
    expect(out.jobs.a.container).toBe('node:23');
    expect(out.jobs.b.container).toEqual({ image: 'other:1' });
  });

  it('replaces service images, by string or by original image', () => {
    const wf = workflow({
      a: {
        'runs-on': 'x',
        services: {
          db: { image: 'corp/pg:1', ports: [5432] },
          cache: 'corp/redis:7'
        },
        steps: []
      }
    });
    const all = applyWorkflowOverrides(wf, { 'service-images': 'busybox' });
    expect(all.workflow.jobs.a.services).toEqual({
      db: { image: 'busybox', ports: [5432] },
      cache: 'busybox'
    });
    const mapped = applyWorkflowOverrides(wf, {
      'service-images': { 'corp/pg:1': 'postgres:16' }
    });
    expect(mapped.workflow.jobs.a.services).toEqual({
      db: { image: 'postgres:16', ports: [5432] },
      cache: 'corp/redis:7'
    });
    expect(mapped.changes).toEqual([
      'jobs.a.services.db: corp/pg:1 -> postgres:16'
    ]);
  });
});
