import { parseFile } from '../parser/workflow-parser';
import { logger } from '../utils/logger';
import { ParsedWorkflow, ParsedAction } from '../types';
import {
  actionExpressionErrors,
  workflowExpressionErrors
} from '../parser/validator';
import { createContext } from './expression';
import {
  expandMatrix,
  filterMatrix,
  matrixLabel,
  MatrixFilter,
  noMatrixMatchMessage,
  unknownMatrixKeys
} from './job-plan';

export interface DryRunOptions {
  /** Show only this job (`--job`). */
  job?: string;
  /** `--matrix key:value` filters. */
  matrix?: MatrixFilter;
}

// A matrix expression reading a context a dry run doesn't have.
const RUN_TIME_MATRIX = /\$\{\{[^}]*\b(?:needs|inputs|vars|github|secrets)\b/;

export interface DryRunResult {
  success: boolean;
  type: 'workflow' | 'action';
  jobs?: Array<{
    name: string;
    steps: string[];
    /** Matrix combinations that would run, when known before running. */
    matrix?: string[];
  }>;
  inputs?: string[];
  outputs?: string[];
  steps?: string[];
}

/**
 * Perform a dry run of a workflow or action file
 * Shows what would be executed without actually running anything
 */
export function dryRun(
  filePath: string,
  options: DryRunOptions = {}
): DryRunResult {
  try {
    const parsed = parseFile(filePath);

    // A file a real run would reject fails the dry run too.
    const invalid =
      parsed.type === 'workflow'
        ? workflowExpressionErrors(parsed.file)
        : actionExpressionErrors(parsed.file);
    if (invalid.length > 0) {
      logger.error(`Invalid ${parsed.type} file: ${filePath}`);
      for (const error of invalid) {
        logger.error(`  ${error.path}: ${error.message}`);
      }
      return { success: false, type: parsed.type };
    }

    if (parsed.type === 'workflow') {
      return dryRunWorkflow(parsed, options);
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

function dryRunWorkflow(
  parsed: ParsedWorkflow,
  options: DryRunOptions
): DryRunResult {
  const workflow = parsed.file;
  const filter = options.matrix ?? {};
  const definedKeys = new Set<string>();
  let runTimeMatrix = false;
  let unmatched = false;

  logger.info(`Workflow: ${workflow.name}`);
  logger.info(`Trigger: ${JSON.stringify(workflow.on)}`);

  const selectedJobs = Object.entries(workflow.jobs).filter(
    ([jobId]) => !options.job || jobId === options.job
  );
  const jobs = selectedJobs.flatMap(([jobId, job]) => {
    // Matrix combinations, as far as they can be known without running.
    let matrix: string[] | undefined;
    const rawMatrix = job.strategy?.matrix;
    const atRunTime =
      rawMatrix !== undefined &&
      RUN_TIME_MATRIX.test(JSON.stringify(rawMatrix));
    if (atRunTime) {
      runTimeMatrix = true;
    } else if (rawMatrix !== undefined) {
      const combinations = expandMatrix(rawMatrix, createContext());
      combinations.forEach((c) =>
        Object.keys(c).forEach((k) => definedKeys.add(k))
      );
      const { keys, matches } = filterMatrix(combinations, filter);
      if (keys.length > 0 && matches.length === 0) {
        logger.warn(noMatrixMatchMessage(jobId, filter, combinations));
        unmatched = true;
        return [];
      }
      matrix = matches.map((m) => matrixLabel(m.values));
    }

    logger.step(`Job: ${jobId} (${job.name || jobId})`);
    if (atRunTime) {
      logger.info('  Matrix: resolved at run time');
    } else if (matrix) {
      logger.info(`  Matrix (${matrix.length} combination(s)):`);
      matrix.forEach((label) => logger.info(`    ${label}`));
    }

    // Handle reusable workflow calls
    if (job.uses) {
      logger.info(`  Uses workflow: ${job.uses}`);
      if (job.with) {
        logger.info(`  With inputs: ${JSON.stringify(job.with)}`);
      }
      return [
        {
          name: jobId,
          steps: [`Calls reusable workflow: ${job.uses}`],
          ...(matrix ? { matrix } : {})
        }
      ];
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

    return [{ name: jobId, steps, ...(matrix ? { matrix } : {}) }];
  });

  // A key might belong to a matrix only known at run time.
  if (!runTimeMatrix) {
    for (const key of unknownMatrixKeys(filter, definedKeys)) {
      logger.warn(
        `--matrix ${key}: no matrix job defines this key; it was ignored`
      );
    }
  }

  if (unmatched) {
    logger.error('Dry run failed: a --matrix filter matched no combination');
    return { success: false, type: 'workflow', jobs };
  }

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
