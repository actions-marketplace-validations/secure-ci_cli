import * as fs from 'fs';
import * as YAML from 'yaml';
import {
  ParsedWorkflow,
  ParsedAction,
  WorkflowFile,
  ActionFile
} from '../types';

/**
 * Parse a GitHub workflow YAML file
 */
export function parseWorkflow(filePath: string): ParsedWorkflow {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Workflow file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  try {
    const parsed = YAML.parse(content) as WorkflowFile;

    if (!parsed.name) {
      throw new Error('Workflow must have a name');
    }

    if (!parsed.jobs || Object.keys(parsed.jobs).length === 0) {
      throw new Error('Workflow must have at least one job');
    }

    return {
      type: 'workflow',
      file: parsed,
      path: filePath
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse workflow: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Parse a GitHub action YAML file
 */
export function parseAction(filePath: string): ParsedAction {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Action file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  try {
    const parsed = YAML.parse(content) as ActionFile;

    if (!parsed.name) {
      throw new Error('Action must have a name');
    }

    if (!parsed.description) {
      throw new Error('Action must have a description');
    }

    if (!parsed.runs) {
      throw new Error('Action must have a runs section');
    }

    return {
      type: 'action',
      file: parsed,
      path: filePath
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to parse action: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Auto-detect and parse either workflow or action file
 */
export function parseFile(filePath: string): ParsedWorkflow | ParsedAction {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(content);

  // Detect if it's a workflow or action based on structure
  if (parsed.jobs) {
    return parseWorkflow(filePath);
  } else if (parsed.runs) {
    return parseAction(filePath);
  } else {
    throw new Error(
      'Unable to determine file type. Must be either a workflow (with jobs) or action (with runs)'
    );
  }
}
