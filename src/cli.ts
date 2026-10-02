#!/usr/bin/env node

import { Command } from 'commander';
import { dryRun } from './runner/dry-run';
import { executeWorkflow } from './runner/executor';
import { validateWorkflow, validateAction } from './parser/validator';
import { parseFile } from './parser/workflow-parser';
import { logger, LogLevel } from './utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();

program
  .name('actly')
  .description('CLI tool to locally test GitHub Actions and workflows')
  .version('0.1.0');

program
  .argument('[file]', 'Path to workflow or action YAML file')
  .option('-d, --dry-run', 'Perform a dry run without executing')
  .option('-v, --validate', 'Validate the YAML file syntax')
  .option(
    '-i, --input <key=value...>',
    'Pass input values (can be used multiple times)'
  )
  .option(
    '-s, --secret <key=value...>',
    'Pass secret values (can be used multiple times)'
  )
  .option('-j, --job <name>', 'Run a specific job')
  .option('--verbose', 'Enable verbose logging')
  .option('-l, --list', 'List available workflows in .github/workflows/')
  .option(
    '--container-runtime <name>',
    'Isolate run: steps in a container: auto|docker|podman|none (default: none)',
    'none'
  )
  .option(
    '--container-image <image>',
    'Container image to run steps in (default: ubuntu:22.04)'
  )
  .option(
    '--container-timeout <ms>',
    'Per-step timeout in milliseconds when containerized'
  )
  .option(
    '--container-memory <limit>',
    'Memory limit for the container, e.g. 512m'
  )
  .option(
    '--allow-network',
    'Allow container network access (disabled by default)'
  )
  .action(async (file, options) => {
    // Set log level
    if (options.verbose) {
      logger.setLevel(LogLevel.DEBUG);
    }

    // List workflows
    if (options.list) {
      listWorkflows();
      return;
    }

    // Require file argument if not listing
    if (!file) {
      logger.error('Please provide a workflow or action file path');
      program.help();
      process.exit(1);
    }

    // Check if file exists
    if (!fs.existsSync(file)) {
      logger.error(`File not found: ${file}`);
      process.exit(1);
    }

    try {
      // Validate mode
      if (options.validate) {
        validateFile(file);
        return;
      }

      // Dry run mode
      if (options.dryRun) {
        const result = dryRun(file);
        if (!result.success) {
          process.exit(1);
        }
        return;
      }

      // Parse inputs
      const inputs: Record<string, string> = {};
      if (options.input) {
        const inputArray = Array.isArray(options.input)
          ? options.input
          : [options.input];
        inputArray.forEach((input: string) => {
          const [key, value] = input.split('=');
          if (key && value) {
            inputs[key] = value;
          }
        });
      }

      // Parse secrets
      const secrets: Record<string, string> = {};
      if (options.secret) {
        const secretArray = Array.isArray(options.secret)
          ? options.secret
          : [options.secret];
        secretArray.forEach((secret: string) => {
          const [key, value] = secret.split('=');
          if (key && value) {
            secrets[key] = value;
          }
        });
      }

      // Execute the workflow/action
      const result = await executeWorkflow(file, {
        dryRun: false,
        inputs,
        secrets,
        job: options.job,
        verbose: options.verbose,
        containerRuntime: options.containerRuntime,
        containerImage: options.containerImage,
        containerTimeoutMs: options.containerTimeout
          ? Number(options.containerTimeout)
          : undefined,
        containerMemoryLimit: options.containerMemory,
        networkDisabled: !options.allowNetwork
      });

      if (!result.success) {
        process.exit(1);
      }
    } catch (error) {
      logger.error(
        `Failed to process file: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  });

function validateFile(filePath: string): void {
  try {
    const parsed = parseFile(filePath);
    let result;

    if (parsed.type === 'workflow') {
      result = validateWorkflow(filePath);
      logger.info('Validating workflow...');
    } else {
      result = validateAction(filePath);
      logger.info('Validating action...');
    }

    if (result.valid) {
      logger.success('Validation passed!');
    } else {
      logger.error('Validation failed:');
      result.errors.forEach((error) => {
        logger.error(
          `  [${error.severity.toUpperCase()}] ${error.path}: ${error.message}`
        );
      });
      process.exit(1);
    }
  } catch (error) {
    logger.error(
      `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
    process.exit(1);
  }
}

function listWorkflows(): void {
  const workflowsDir = path.join(process.cwd(), '.github', 'workflows');

  if (!fs.existsSync(workflowsDir)) {
    logger.warn('No .github/workflows directory found in current directory');
    return;
  }

  const files = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  if (files.length === 0) {
    logger.info('No workflow files found');
    return;
  }

  logger.info('Available workflows:');
  files.forEach((file) => {
    const filePath = path.join(workflowsDir, file);
    try {
      const parsed = parseFile(filePath);
      if (parsed.type === 'workflow') {
        logger.info(`  - ${file}: ${parsed.file.name}`);
      }
    } catch (error) {
      logger.warn(`  - ${file}: (failed to parse)`);
    }
  });
}

program.parse();
