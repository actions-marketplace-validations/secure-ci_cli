#!/usr/bin/env node

import { Command, Option } from 'commander';
import { dryRun } from './runner/dry-run';
import { executeWorkflow } from './runner/executor';
import { validateWorkflow, validateAction } from './parser/validator';
import { parseFile } from './parser/workflow-parser';
import { parsePipelineContract } from './parser/pipeline-contract-parser';
import { validatePipelineContract } from './parser/pipeline-contract-validator';
import { logger, LogLevel } from './utils/logger';
import { parseKeyValuePairs } from './utils/key-value';
import {
  loadConfig,
  saveConfig,
  getConfigFilePath,
  getDefaultContainerRuntime,
  isValidConfigKey,
  parseConfigValue,
  CONFIG_KEYS
} from './config';
import * as fs from 'fs';
import * as path from 'path';

const program = new Command();
const globalConfig = loadConfig();

program
  .name('ghact')
  .description('CLI tool to locally test GitHub Actions and workflows')
  .version('0.1.0');

program
  .argument('[file]', 'Path to workflow or action YAML file')
  .option('-d, --dry-run', 'Perform a dry run without executing')
  .option('-v, --validate', 'Validate the YAML file syntax')
  .option(
    '--contract <file>',
    'Validate the workflow against a central pipeline contract (required/forbidden actions, ordering)'
  )
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
  .addOption(
    new Option(
      '--container-runtime <name>',
      `Isolate run: steps in a container (default: "${getDefaultContainerRuntime(globalConfig)}", from ~/.ghact/config.yml or built-in default; use "none" for the old host-execution default)`
    )
      .choices(['auto', 'docker', 'podman', 'containerd', 'none'])
      .default(getDefaultContainerRuntime(globalConfig))
  )
  .option(
    '--container-image <image>',
    'Container image to run steps in (default: ubuntu:22.04)',
    globalConfig['container-image']
  )
  .option(
    '--container-timeout <ms>',
    'Per-step timeout in milliseconds when containerized',
    globalConfig['container-timeout'] !== undefined
      ? String(globalConfig['container-timeout'])
      : undefined
  )
  .option(
    '--container-memory <limit>',
    'Memory limit for the container, e.g. 512m',
    globalConfig['container-memory']
  )
  .option(
    '--allow-network',
    'Allow container network access (disabled by default)',
    globalConfig['allow-network'] ?? false
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
      // Validate mode (also triggered by --contract on its own)
      if (options.validate || options.contract) {
        validateFile(file, options.contract);
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

      const inputs = parseKeyValuePairs(options.input, '--input');
      const secrets = parseKeyValuePairs(options.secret, '--secret', {
        redact: true
      });

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

function validateFile(filePath: string, contractFile?: string): void {
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

    if (contractFile) {
      logger.info(`Validating against pipeline contract: ${contractFile}`);
      if (parsed.type !== 'workflow') {
        result = {
          valid: false,
          errors: [
            ...result.errors,
            {
              path: 'root',
              message:
                'Pipeline contracts validate job/step sequences and only apply to workflow files, not actions',
              severity: 'error' as const
            }
          ]
        };
      } else {
        const spec = parsePipelineContract(contractFile);
        const contractResult = validatePipelineContract(parsed, spec);
        result = {
          valid: result.valid && contractResult.valid,
          errors: [...result.errors, ...contractResult.errors]
        };
      }
    }

    if (result.valid) {
      logger.success('Validation passed!');
      result.errors.forEach((error) => {
        logger.warn(
          `  [${error.severity.toUpperCase()}] ${error.path}: ${error.message}`
        );
      });
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

const configCmd = program
  .command('config')
  .description('Manage ghact global configuration (~/.ghact/config.yml)');

configCmd
  .command('path')
  .description('Print the path to the global config file')
  .action(() => {
    logger.info(getConfigFilePath());
  });

configCmd
  .command('list')
  .description('List effective config values (config file + built-in defaults)')
  .action(() => {
    const config = loadConfig();
    for (const key of CONFIG_KEYS) {
      const value = config[key];
      logger.info(`${key}=${value === undefined ? '(unset)' : value}`);
    }
  });

configCmd
  .command('get <key>')
  .description('Print the value of a config key')
  .action((key: string) => {
    if (!isValidConfigKey(key)) {
      logger.error(
        `Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`
      );
      process.exit(1);
    }
    const value = loadConfig()[key];
    logger.info(value === undefined ? '(unset)' : String(value));
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config key and persist it to the global config file')
  .action((key: string, value: string) => {
    if (!isValidConfigKey(key)) {
      logger.error(
        `Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`
      );
      process.exit(1);
    }
    try {
      const parsedValue = parseConfigValue(key, value);
      const config = loadConfig();
      config[key] = parsedValue as never;
      saveConfig(config);
      logger.success(`Set ${key}=${parsedValue} in ${getConfigFilePath()}`);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : 'Invalid value');
      process.exit(1);
    }
  });

configCmd
  .command('unset <key>')
  .description('Remove a config key, reverting to the built-in default')
  .action((key: string) => {
    if (!isValidConfigKey(key)) {
      logger.error(
        `Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}`
      );
      process.exit(1);
    }
    const config = loadConfig();
    delete config[key];
    saveConfig(config);
    logger.success(`Unset ${key} in ${getConfigFilePath()}`);
  });

program.parse();
