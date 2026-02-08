import { parseFile } from '../parser/workflow-parser';
import { logger } from '../utils/logger';
import { ParsedWorkflow, ParsedAction } from '../types';

export interface DryRunResult {
  success: boolean;
  type: 'workflow' | 'action';
  jobs?: Array<{
    name: string;
    steps: string[];
  }>;
  inputs?: string[];
  outputs?: string[];
  steps?: string[];
}

/**
 * Perform a dry run of a workflow or action file
 * Shows what would be executed without actually running anything
 */
export function dryRun(filePath: string): DryRunResult {
  try {
    const parsed = parseFile(filePath);

    if (parsed.type === 'workflow') {
      return dryRunWorkflow(parsed);
    } else {
      return dryRunAction(parsed);
    }
  } catch (error) {
    logger.error(
      `Failed to perform dry run: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    return {
      success: false,
      type: 'workflow'
    };
  }
}

function dryRunWorkflow(parsed: ParsedWorkflow): DryRunResult {
  const workflow = parsed.file;

  logger.info(`Workflow: ${workflow.name}`);
  logger.info(`Trigger: ${JSON.stringify(workflow.on)}`);

  const jobs = Object.entries(workflow.jobs).map(([jobId, job]) => {
    logger.step(`Job: ${jobId} (${job.name || jobId})`);

    // Handle reusable workflow calls
    if (job.uses) {
      logger.info(`  Uses workflow: ${job.uses}`);
      if (job.with) {
        logger.info(`  With inputs: ${JSON.stringify(job.with)}`);
      }
      return {
        name: jobId,
        steps: [`Calls reusable workflow: ${job.uses}`]
      };
    }

    // Handle regular jobs
    if (job['runs-on']) {
      logger.info(`  Runs on: ${job['runs-on']}`);
    }

    const steps = (job.steps || []).map((step, idx) => {
      const stepInfo = [];
      stepInfo.push(`  Step ${idx + 1}:`);

      if (step.name) {
        stepInfo.push(step.name);
      }

      if (step.uses) {
        stepInfo.push(`uses: ${step.uses}`);
      } else if (step.run) {
        stepInfo.push(`run: ${step.run}`);
      }

      const stepDesc = stepInfo.join(' ');
      logger.info(stepDesc);
      return stepDesc;
    });

    return {
      name: jobId,
      steps
    };
  });

  logger.success('Dry run completed successfully');

  return {
    success: true,
    type: 'workflow',
    jobs
  };
}

function dryRunAction(parsed: ParsedAction): DryRunResult {
  const action = parsed.file;

  logger.info(`Action: ${action.name}`);
  logger.info(`Description: ${action.description}`);

  const inputs: string[] = [];
  if (action.inputs) {
    logger.step('Inputs:');
    Object.entries(action.inputs).forEach(([name, input]) => {
      const required = input.required ? '(required)' : '(optional)';
      const defaultVal = input.default ? ` [default: ${input.default}]` : '';
      const inputInfo = `  ${name} ${required}${defaultVal}`;
      logger.info(inputInfo);
      inputs.push(inputInfo);
    });
  }

  const outputs: string[] = [];
  if (action.outputs) {
    logger.step('Outputs:');
    Object.keys(action.outputs).forEach((name) => {
      const outputInfo = `  ${name}`;
      logger.info(outputInfo);
      outputs.push(outputInfo);
    });
  }

  const steps: string[] = [];
  if (action.runs.steps) {
    logger.step('Steps:');
    action.runs.steps.forEach((step, idx) => {
      const stepInfo = [];
      stepInfo.push(`  Step ${idx + 1}:`);

      if (step.name) {
        stepInfo.push(step.name);
      }

      if (step.uses) {
        stepInfo.push(`uses: ${step.uses}`);
      } else if (step.run) {
        stepInfo.push(`run: ${step.run}`);
      }

      const stepDesc = stepInfo.join(' ');
      logger.info(stepDesc);
      steps.push(stepDesc);
    });
  }

  logger.success('Dry run completed successfully');

  return {
    success: true,
    type: 'action',
    inputs,
    outputs,
    steps
  };
}
