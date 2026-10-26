import * as fs from 'fs';
import { parseWorkflow, parseAction } from './workflow-parser';
import {
  ActionFile,
  ValidationResult,
  ValidationError,
  WorkflowFile
} from '../types';
import { validateExpression } from '../runner/expression';
import { actionInjectionErrors, workflowInjectionErrors } from './injection';
import { workflowPermissionErrors } from './permissions';
import { dangerousTriggerErrors } from './dangerous-triggers';
import { stepAllowComments } from './allow-comments';

/**
 * Invalid `if:` expressions in a workflow: syntax errors, or contexts and
 * functions not available where they're used. GitHub rejects such a
 * workflow before running any job.
 */
export function workflowExpressionErrors(
  workflow: WorkflowFile
): ValidationError[] {
  const errors: ValidationError[] = [];
  const check = (
    condition: unknown,
    location: Parameters<typeof validateExpression>[1],
    at: string
  ) => {
    const message = validateExpression(
      condition as string | boolean | undefined,
      location
    );
    if (message) errors.push({ path: at, message, severity: 'error' });
  };
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    check(job.if, 'job-if', `jobs.${jobId}.if`);
    (job.steps ?? []).forEach((step, i) =>
      check(step.if, 'step-if', `jobs.${jobId}.steps[${i}].if`)
    );
  }
  return errors;
}

/** Invalid `if:` expressions in a composite action's steps. */
export function actionExpressionErrors(action: ActionFile): ValidationError[] {
  const errors: ValidationError[] = [];
  (action.runs?.steps ?? []).forEach((step, i) => {
    const message = validateExpression(step.if, 'composite-step-if');
    if (message) {
      errors.push({ path: `runs.steps[${i}].if`, message, severity: 'error' });
    }
  });
  return errors;
}

/**
 * Validate a workflow file
 */
export function validateWorkflow(filePath: string): ValidationResult {
  const errors: ValidationError[] = [];

  try {
    const parsed = parseWorkflow(filePath);
    const workflow = parsed.file;

    // Validate name
    if (!workflow.name || workflow.name.trim() === '') {
      errors.push({
        path: 'name',
        message: 'Workflow name is required',
        severity: 'error'
      });
    }

    // Validate trigger
    if (!workflow.on) {
      errors.push({
        path: 'on',
        message: 'Workflow trigger (on) is required',
        severity: 'error'
      });
    }

    // Validate jobs
    if (!workflow.jobs || Object.keys(workflow.jobs).length === 0) {
      errors.push({
        path: 'jobs',
        message: 'At least one job is required',
        severity: 'error'
      });
    } else {
      // Validate each job
      Object.entries(workflow.jobs).forEach(([jobId, job]) => {
        // Check if it's a reusable workflow call
        if (job.uses) {
          // Reusable workflow - only needs 'uses'
          if (!job.uses.trim()) {
            errors.push({
              path: `jobs.${jobId}.uses`,
              message: 'Reusable workflow path cannot be empty',
              severity: 'error'
            });
          }
        } else {
          // Regular job - needs runs-on and steps
          if (!job['runs-on']) {
            errors.push({
              path: `jobs.${jobId}.runs-on`,
              message: 'Job must specify runs-on',
              severity: 'error'
            });
          }

          if (!job.steps || job.steps.length === 0) {
            errors.push({
              path: `jobs.${jobId}.steps`,
              message: 'Job must have at least one step',
              severity: 'error'
            });
          } else {
            // Validate each step
            job.steps.forEach((step, idx) => {
              if (!step.uses && !step.run) {
                errors.push({
                  path: `jobs.${jobId}.steps[${idx}]`,
                  message: 'Step must have either "uses" or "run"',
                  severity: 'error'
                });
              }

              if (step.uses && step.run) {
                errors.push({
                  path: `jobs.${jobId}.steps[${idx}]`,
                  message: 'Step cannot have both "uses" and "run"',
                  severity: 'error'
                });
              }
            });
          }
        }
      });
    }

    errors.push(...workflowExpressionErrors(workflow));
    errors.push(...workflowInjectionErrors(workflow, filePath));
    errors.push(...workflowPermissionErrors(workflow));
    errors.push(
      ...dangerousTriggerErrors(
        workflow,
        stepAllowComments(
          fs.readFileSync(filePath, 'utf-8'),
          'dangerous-trigger'
        )
      )
    );
  } catch (error) {
    errors.push({
      path: 'root',
      message: error instanceof Error ? error.message : 'Unknown error',
      severity: 'error'
    });
  }

  return {
    valid: errors.every((e) => e.severity !== 'error'),
    errors
  };
}

/**
 * Combine validation results (e.g. syntax checks and a contract). A warning
 * is dropped when an error with the same rule and path supersedes it, such
 * as a default permissions warning the contract turns into an error.
 */
export function mergeValidationResults(
  ...results: ValidationResult[]
): ValidationResult {
  const all = results.flatMap((r) => r.errors);
  const superseding = new Set(
    all
      .filter((e) => e.severity === 'error' && e.rule)
      .map((e) => `${e.rule}\0${e.path}`)
  );
  return {
    valid: results.every((r) => r.valid),
    errors: all.filter(
      (e) =>
        e.severity !== 'warning' ||
        !e.rule ||
        !superseding.has(`${e.rule}\0${e.path}`)
    )
  };
}

/**
 * Validate an action file
 */
export function validateAction(filePath: string): ValidationResult {
  const errors: ValidationError[] = [];

  try {
    const parsed = parseAction(filePath);
    const action = parsed.file;

    // Validate name
    if (!action.name || action.name.trim() === '') {
      errors.push({
        path: 'name',
        message: 'Action name is required',
        severity: 'error'
      });
    }

    // Validate description
    if (!action.description || action.description.trim() === '') {
      errors.push({
        path: 'description',
        message: 'Action description is required',
        severity: 'error'
      });
    }

    // Validate runs
    if (!action.runs) {
      errors.push({
        path: 'runs',
        message: 'Action must have a runs section',
        severity: 'error'
      });
    } else {
      if (!action.runs.using) {
        errors.push({
          path: 'runs.using',
          message: 'Action must specify runs.using',
          severity: 'error'
        });
      }

      // Validate composite actions
      if (action.runs.using === 'composite') {
        if (!action.runs.steps || action.runs.steps.length === 0) {
          errors.push({
            path: 'runs.steps',
            message: 'Composite action must have at least one step',
            severity: 'error'
          });
        } else {
          // Validate each step
          action.runs.steps.forEach((step, idx) => {
            if (!step.uses && !step.run) {
              errors.push({
                path: `runs.steps[${idx}]`,
                message: 'Step must have either "uses" or "run"',
                severity: 'error'
              });
            }

            if (step.run && !step.shell) {
              errors.push({
                path: `runs.steps[${idx}]`,
                message: 'Composite action step with "run" must specify shell',
                severity: 'error'
              });
            }
          });
          errors.push(...actionExpressionErrors(action));
          errors.push(...actionInjectionErrors(action, filePath));
        }
      }
    }

    // Validate inputs
    if (action.inputs) {
      Object.entries(action.inputs).forEach(([inputName, input]) => {
        if (!input.description) {
          errors.push({
            path: `inputs.${inputName}.description`,
            message: 'Input description is required',
            severity: 'warning'
          });
        }
      });
    }
  } catch (error) {
    errors.push({
      path: 'root',
      message: error instanceof Error ? error.message : 'Unknown error',
      severity: 'error'
    });
  }

  return {
    valid: errors.length === 0 || errors.every((e) => e.severity === 'warning'),
    errors
  };
}
