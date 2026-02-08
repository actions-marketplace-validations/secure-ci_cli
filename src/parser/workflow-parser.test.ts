import { parseWorkflow, parseAction, parseFile } from './workflow-parser';
import * as fs from 'fs';
import * as path from 'path';

describe('Workflow Parser', () => {
  const fixturesDir = path.join(__dirname, '../../test/fixtures');

  describe('parseWorkflow', () => {
    it('should parse a simple workflow file', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = parseWorkflow(workflowPath);

      expect(result.type).toBe('workflow');
      expect(result.file.name).toBe('Simple CI Workflow');
      expect(result.file.jobs).toHaveProperty('test');
      expect(result.file.jobs.test.steps).toHaveLength(4);
    });

    it('should extract job information correctly', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = parseWorkflow(workflowPath);

      const testJob = result.file.jobs.test;
      expect(testJob['runs-on']).toBe('ubuntu-latest');
      expect(testJob.steps).toBeDefined();
      expect(testJob.steps![0].name).toBe('Checkout code');
      expect(testJob.steps![0].uses).toBe('actions/checkout@v3');
    });

    it('should extract step information correctly', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = parseWorkflow(workflowPath);

      const setupStep = result.file.jobs.test.steps![1];
      expect(setupStep.name).toBe('Setup Node.js');
      expect(setupStep.uses).toBe('actions/setup-node@v3');
      expect(setupStep.with).toEqual({ 'node-version': '18' });
    });

    it('should handle run steps correctly', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = parseWorkflow(workflowPath);

      const installStep = result.file.jobs.test.steps![2];
      expect(installStep.name).toBe('Install dependencies');
      expect(installStep.run).toBe('npm install');
    });

    it('should throw error for non-existent file', () => {
      expect(() => {
        parseWorkflow('/non/existent/file.yml');
      }).toThrow('Workflow file not found');
    });

    it('should throw error for invalid YAML', () => {
      const invalidPath = path.join(fixturesDir, 'invalid.yml');
      fs.writeFileSync(invalidPath, 'invalid: yaml: content: [');

      expect(() => {
        parseWorkflow(invalidPath);
      }).toThrow('Failed to parse workflow');

      fs.unlinkSync(invalidPath);
    });

    it('should throw error for workflow without name', () => {
      const invalidPath = path.join(fixturesDir, 'no-name.yml');
      fs.writeFileSync(
        invalidPath,
        'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi'
      );

      expect(() => {
        parseWorkflow(invalidPath);
      }).toThrow('Workflow must have a name');

      fs.unlinkSync(invalidPath);
    });

    it('should throw error for workflow without jobs', () => {
      const invalidPath = path.join(fixturesDir, 'no-jobs.yml');
      fs.writeFileSync(invalidPath, 'name: Test\non: push');

      expect(() => {
        parseWorkflow(invalidPath);
      }).toThrow('Workflow must have at least one job');

      fs.unlinkSync(invalidPath);
    });
  });

  describe('parseAction', () => {
    it('should parse a simple action file', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = parseAction(actionPath);

      expect(result.type).toBe('action');
      expect(result.file.name).toBe('Hello World Action');
      expect(result.file.description).toBe('A simple hello world action');
    });

    it('should extract input information correctly', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = parseAction(actionPath);

      expect(result.file.inputs).toHaveProperty('who-to-greet');
      expect(result.file.inputs!['who-to-greet'].required).toBe(true);
      expect(result.file.inputs!['who-to-greet'].default).toBe('World');
    });

    it('should extract output information correctly', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = parseAction(actionPath);

      expect(result.file.outputs).toHaveProperty('greeting');
      expect(result.file.outputs!.greeting.description).toBe(
        'The greeting message'
      );
    });

    it('should extract runs information correctly', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = parseAction(actionPath);

      expect(result.file.runs.using).toBe('composite');
      expect(result.file.runs.steps).toHaveLength(2);
      expect(result.file.runs.steps![0].name).toBe('Greet');
    });

    it('should throw error for non-existent file', () => {
      expect(() => {
        parseAction('/non/existent/action.yml');
      }).toThrow('Action file not found');
    });

    it('should throw error for action without name', () => {
      const invalidPath = path.join(fixturesDir, 'action-no-name.yml');
      fs.writeFileSync(
        invalidPath,
        'description: Test\nruns:\n  using: composite\n  steps: []'
      );

      expect(() => {
        parseAction(invalidPath);
      }).toThrow('Action must have a name');

      fs.unlinkSync(invalidPath);
    });

    it('should throw error for action without description', () => {
      const invalidPath = path.join(fixturesDir, 'action-no-desc.yml');
      fs.writeFileSync(
        invalidPath,
        'name: Test\nruns:\n  using: composite\n  steps: []'
      );

      expect(() => {
        parseAction(invalidPath);
      }).toThrow('Action must have a description');

      fs.unlinkSync(invalidPath);
    });
  });

  describe('parseFile', () => {
    it('should auto-detect workflow file', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = parseFile(workflowPath);

      expect(result.type).toBe('workflow');
    });

    it('should auto-detect action file', () => {
      const actionPath = path.join(fixturesDir, 'simple-action.yml');
      const result = parseFile(actionPath);

      expect(result.type).toBe('action');
    });

    it('should throw error for non-existent file', () => {
      expect(() => {
        parseFile('/non/existent/file.yml');
      }).toThrow('File not found');
    });

    it('should throw error for unknown file type', () => {
      const invalidPath = path.join(fixturesDir, 'unknown-type.yml');
      fs.writeFileSync(invalidPath, 'name: Test\ndescription: Test');

      expect(() => {
        parseFile(invalidPath);
      }).toThrow('Unable to determine file type');

      fs.unlinkSync(invalidPath);
    });
  });
});
