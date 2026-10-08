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
  getConfigValue,
  setConfigValue,
  unsetConfigValue,
  resolveNetworkDisabled,
  CONFIG_KEYS
} from './config';
import * as fs from 'fs';
import * as path from 'path';

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
    );
    return String(pkg.version);
  } catch {
    return '0.0.0';
  }
}

const program = new Command();
const globalConfig = loadConfig();

program
  .name('secureci')
  .description(
    'SecureCI CLI: validate, check and run GitHub Actions workflows locally'
  )
  .version(readVersion(), '-V, --version')
  .option('--verbose', 'Enable verbose logging')
  .showHelpAfterError()
  .hook('preAction', (thisCommand) => {
    if (thisCommand.opts().verbose) {
      logger.setLevel(LogLevel.DEBUG);
    }
  });

function requireFile(file: string): void {
  if (!fs.existsSync(file)) {
    logger.error(`File not found: ${file}`);
    process.exit(1);
  }
}

program
  .command('run')
  .description('Run a workflow (or composite action) locally')
  .argument('<file>', 'Path to a workflow or action YAML file')
  .option('-d, --dry-run', 'Show what would run, without executing anything')
  .option(
    '-i, --input <key=value...>',
    'Pass input values (can be used multiple times)'
  )
  .option(
    '-s, --secret <key[=value]...>',
    'Pass secret values (can be used multiple times); a bare NAME reads $NAME from the environment, keeping the value out of the process list'
  )
  .option(
    '--var <key=value...>',
    'Set a configuration variable for the vars context (can be used multiple times)'
  )
  .option(
    '--event-path <file>',
    'JSON event payload for github.event / $GITHUB_EVENT_PATH'
  )
  .option(
    '--event-name <name>',
    'github.event_name (default: $GITHUB_EVENT_NAME, else workflow_dispatch if declared, else the first trigger)'
  )
  .option('-j, --job <name>', 'Run a specific job')
  .option(
    '--no-local-checkout',
    'Run the real actions/checkout for the current repository instead of using the local working copy'
  )
  .addOption(
    new Option(
      '--container-runtime <name>',
      `Run each job in a container (default: "${getDefaultContainerRuntime(globalConfig)}", from ~/.secureci/config.yml or built-in default; "none" runs on the host)`
    )
      .choices(['auto', 'docker', 'podman', 'containerd', 'none'])
      .default(getDefaultContainerRuntime(globalConfig))
  )
  .option(
    '--container-image <image>',
    'Container image for every job without jobs.<id>.container, overriding the runs-on mapping (runner-images in config; jobs with unmapped labels use container-image from config, else catthehacker/ubuntu:act-22.04)'
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
  .option('--no-network', 'Disable container network access (on by default)')
  .option(
    '--allow-network',
    'Allow container network access (the default; overrides allow-network: false in config)'
  )
  .action(async (file: string, options) => {
    requireFile(file);

    if (options.dryRun) {
      const result = dryRun(file);
      if (!result.success) {
        process.exit(1);
      }
      return;
    }

    try {
      const inputs = parseKeyValuePairs(options.input, '--input');
      const secrets = parseKeyValuePairs(options.secret, '--secret', {
        redact: true,
        fromEnv: process.env
      });
      const vars = parseKeyValuePairs(options.var, '--var');

      const result = await executeWorkflow(file, {
        dryRun: false,
        inputs,
        secrets,
        vars,
        eventPath: options.eventPath,
        eventName: options.eventName,
        job: options.job,
        localCheckout: options.localCheckout,
        verbose: program.opts().verbose,
        containerRuntime: options.containerRuntime,
        containerImage: options.containerImage,
        runnerImages: globalConfig['runner-images'],
        defaultContainerImage: globalConfig['container-image'],
        containerTimeoutMs: options.containerTimeout
          ? Number(options.containerTimeout)
          : undefined,
        containerMemoryLimit: options.containerMemory,
        networkDisabled: resolveNetworkDisabled(
          { network: options.network, allowNetwork: options.allowNetwork },
          globalConfig
        )
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

program
  .command('validate')
  .description(
    'Validate a workflow or action file, optionally against a pipeline contract'
  )
  .argument('<file>', 'Path to a workflow or action YAML file')
  .option(
    '-c, --contract <file>',
    'Also check the workflow against a pipeline contract (required/forbidden actions, minimum versions, ordering)'
  )
  .action((file: string, options: { contract?: string }) => {
    requireFile(file);
    validateFile(file, options.contract);
  });

program
  .command('list')
  .description('List workflows in .github/workflows/')
  .action(() => {
    listWorkflows();
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
  .description('Manage global configuration (~/.secureci/config.yml)');

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
    for (const [label, image] of Object.entries(
      config['runner-images'] ?? {}
    )) {
      logger.info(`runner-images.${label}=${image}`);
    }
  });

configCmd
  .command('get <key>')
  .description('Print the value of a config key')
  .action((key: string) => {
    if (!isValidConfigKey(key)) {
      logger.error(
        `Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}, runner-images.<label>`
      );
      process.exit(1);
    }
    const value = getConfigValue(loadConfig(), key);
    logger.info(value === undefined ? '(unset)' : String(value));
  });

configCmd
  .command('set <key> <value>')
  .description('Set a config key and persist it to the global config file')
  .action((key: string, value: string) => {
    if (!isValidConfigKey(key)) {
      logger.error(
        `Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}, runner-images.<label>`
      );
      process.exit(1);
    }
    try {
      const config = loadConfig();
      const parsedValue = setConfigValue(config, key, value);
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
        `Unknown config key "${key}". Valid keys: ${CONFIG_KEYS.join(', ')}, runner-images.<label>`
      );
      process.exit(1);
    }
    const config = loadConfig();
    unsetConfigValue(config, key);
    saveConfig(config);
    logger.success(`Unset ${key} in ${getConfigFilePath()}`);
  });

// With no command, show help and fail, like other vendor CLIs.
if (process.argv.length <= 2) {
  program.outputHelp({ error: true });
  process.exit(1);
}

program.parse();
