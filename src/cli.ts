#!/usr/bin/env node

import { Command, Option } from 'commander';
import { dryRun } from './runner/dry-run';
import { executeWorkflow } from './runner/executor';
import {
  clearActionCache,
  fetchAction,
  fetchRepoFile,
  getActionCacheDir,
  resolveActionSha,
  resolveRepoIdentity
} from './runner/action-fetcher';
import { resolveContractSource } from './contract-source';
import { validateWorkflow, validateAction } from './parser/validator';
import { parseFile } from './parser/workflow-parser';
import { parsePipelineContract } from './parser/pipeline-contract-parser';
import {
  validatePipelineContract,
  ContractRecurse
} from './parser/pipeline-contract-validator';
import {
  ContractInfo,
  formatReport,
  ReportEntry,
  ReportFormat
} from './report';
import { renderInitWorkflow } from './init';
import {
  addTransitive,
  buildInventory,
  diffLock,
  InventoryAction,
  LockEntry,
  Lockfile
} from './inventory';
import {
  GITHUB_LOCKFILE,
  findLockfile,
  readLockfile,
  serializeSecureciLockfile
} from './github-lockfile';
import type { ValidationResult } from './types';
import { logger, LogLevel } from './utils/logger';
import { parseKeyValuePairs } from './utils/key-value';
import {
  loadConfig,
  saveConfig,
  getConfigFilePath,
  getDefaultContainerRuntime,
  DEFAULT_CONFIG,
  isValidConfigKey,
  getConfigValue,
  setConfigValue,
  unsetConfigValue,
  resolveNetworkDisabled,
  CONFIG_KEYS
} from './config';
import * as fs from 'fs';
import * as path from 'path';

/** Committed at the repo root, like package-lock.json / yarn.lock. */
const LOCKFILE_NAME = 'secureci.lock';

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

// An invalid container-runtime in the config file only stops `run`, so
// `secureci config set` can still fix it.
let configError: string | undefined;
let defaultContainerRuntime: ReturnType<typeof getDefaultContainerRuntime>;
try {
  defaultContainerRuntime = getDefaultContainerRuntime(globalConfig);
} catch (error) {
  configError = error instanceof Error ? error.message : String(error);
  defaultContainerRuntime = 'docker';
}

program
  .name('secureci')
  .description(
    'SecureCI: validate, check and run GitHub Actions workflows locally'
  )
  .version(readVersion(), '-V, --version', 'Print the version')
  .helpOption('-h, --help', 'Show help')
  .addHelpCommand('help [command]', 'Show help for a command')
  .option('--verbose', 'Log debug output')
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
  .description(
    'Run a workflow (or composite action) on this machine, each job in a container'
  )
  .argument('<file>', 'Path to a workflow or action YAML file')
  .option('-d, --dry-run', 'Show what would run, without executing anything')
  .option(
    '-i, --input <key=value...>',
    'Set an input for the inputs context. Repeatable'
  )
  .option(
    '-s, --secret <key=value|NAME...>',
    'Set a secret for the secrets context. A bare NAME reads $NAME from your shell, keeping the value off the command line. Repeatable'
  )
  .option(
    '--env <key=value|NAME...>',
    'Set an env var for every step, below workflow/job/step env:. A bare NAME passes $NAME from your shell (steps get nothing else from it). Repeatable'
  )
  .option(
    '--var <key=value...>',
    'Set a configuration variable for the vars context. Repeatable'
  )
  .option(
    '--event-path <file>',
    'Read the event payload (github.event, $GITHUB_EVENT_PATH) from a JSON file'
  )
  .option(
    '--event-name <name>',
    'Set github.event_name. Default: $GITHUB_EVENT_NAME, else workflow_dispatch if declared, else the first trigger'
  )
  .option('-j, --job <name>', 'Run only this job')
  .option(
    '--offline',
    'Use only cached remote actions and workflows; never download'
  )
  .option(
    '--no-local-checkout',
    'Run the real actions/checkout for this repository instead of using the working copy'
  )
  .addOption(
    new Option(
      '--container-runtime <name>',
      'Container engine for jobs. "host" runs steps directly on this machine, without a container. Config: container-runtime'
    )
      .choices(['auto', 'docker', 'podman', 'containerd', 'host'])
      .default(defaultContainerRuntime)
  )
  .option(
    '--container-image <image>',
    'Use this image for every job without jobs.<id>.container, instead of the image for its runs-on (config: runner-images, container-image)'
  )
  .option(
    '--container-timeout <ms>',
    'Fail a step that runs longer than this, in milliseconds (container mode). Config: container-timeout',
    globalConfig['container-timeout'] !== undefined
      ? String(globalConfig['container-timeout'])
      : undefined
  )
  .option(
    '--container-memory <limit>',
    'Limit job container memory, e.g. 512m. Config: container-memory',
    globalConfig['container-memory']
  )
  .option('--no-network', 'Turn off container network access (on by default)')
  .option(
    '--allow-network',
    'Turn on container network access, overriding allow-network: false in the config'
  )
  .action(async (file: string, options) => {
    if (configError) {
      logger.error(configError);
      process.exit(1);
    }
    requireFile(file);

    if (options.dryRun) {
      const result = dryRun(file);
      if (!result.success) {
        process.exit(1);
      }
      return;
    }

    logger.info(
      "Running the workflow for real (not a dry run). Use --dry-run to simulate without executing, or 'secureci validate' to only check for errors."
    );

    try {
      const inputs = parseKeyValuePairs(options.input, '--input');
      const secrets = parseKeyValuePairs(options.secret, '--secret', {
        redact: true,
        fromEnv: process.env
      });
      const vars = parseKeyValuePairs(options.var, '--var');
      const env = parseKeyValuePairs(options.env, '--env', {
        fromEnv: process.env
      });

      const result = await executeWorkflow(file, {
        dryRun: false,
        inputs,
        secrets,
        vars,
        env,
        eventPath: options.eventPath,
        eventName: options.eventName,
        job: options.job,
        localCheckout: options.localCheckout,
        offline: options.offline,
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
    'Validate one or more workflow or action files, optionally against a pipeline contract'
  )
  .argument('<file...>', 'Paths to workflow or action YAML files')
  .option(
    '-c, --contract <file>',
    'Also check the workflow against a pipeline contract (required/forbidden actions, minimum versions, ordering)'
  )
  .addOption(
    new Option(
      '--contract-recurse <scope>',
      'Composite actions / reusable workflows to look inside for --contract: none, local (./...) or all (also downloads remote ones)'
    )
      .choices(['none', 'local', 'all'])
      .default('local')
  )
  .addOption(
    new Option(
      '--format <format>',
      'Output format: text (default), or json / sarif for machine-readable results (sarif uploads to GitHub code scanning)'
    )
      .choices(['text', 'json', 'sarif'])
      .default('text')
  )
  .action(
    async (
      files: string[],
      options: {
        contract?: string;
        contractRecurse: ContractRecurse;
        format: ReportFormat;
      }
    ) => {
      files.forEach(requireFile);
      await validateFiles(
        files,
        options.contract,
        options.contractRecurse,
        options.format
      );
    }
  );

program
  .command('inventory')
  .description(
    'List the actions and reusable workflows a workflow uses (including the actions those actions use), with their commit SHAs; track supply-chain drift with a committed secureci.lock'
  )
  .argument(
    '[file...]',
    'Workflow files (default: every file in .github/workflows)'
  )
  .option(
    '--offline',
    'Do not resolve tags to commit SHAs over the network (already-pinned refs still resolve)'
  )
  .option(
    '--dry-run',
    `Print the resolved inventory as JSON without writing or checking ${LOCKFILE_NAME}`
  )
  .option(
    '--update-lock',
    `Write/update ./${LOCKFILE_NAME} with the current commit SHAs (commit it to your repo)`
  )
  .option('--update-lockfile', `Alias of --update-lock`)
  .option(
    '--check',
    `Compare the current commit SHAs against ./${LOCKFILE_NAME} (or GitHub's ${GITHUB_LOCKFILE} when that is the only lockfile) and fail on drift`
  )
  .option('--compare', `Alias of --check`)
  .action(async (files: string[], options) => {
    await runInventory(files, options);
  });

program
  .command('list')
  .description('List workflows in .github/workflows/')
  .action(() => {
    listWorkflows();
  });

const initCommand = program
  .command('init')
  .description(
    'Scaffold SecureCI files (run a subcommand, e.g. `init workflow`)'
  )
  .action(() => {
    // Bare `secureci init` is ambiguous about what it creates, so show help
    // (and its subcommands) instead of generating anything.
    initCommand.help();
  });

initCommand
  .command('workflow')
  .description(
    'Generate a GitHub Actions workflow (.github/workflows/secureci.yml) that runs SecureCI on pull requests'
  )
  .option(
    '-c, --contract <file>',
    'Check workflows against this pipeline contract in the generated workflow'
  )
  .option(
    '--no-upload',
    'Do not upload SARIF to code scanning (keeps contents: read only)'
  )
  .option(
    '-o, --output <path>',
    'Where to write the workflow',
    '.github/workflows/secureci.yml'
  )
  .option('-f, --force', 'Overwrite the output file if it already exists')
  .action(
    (options: {
      contract?: string;
      upload: boolean;
      output: string;
      force?: boolean;
    }) => {
      runInit(options);
    }
  );

function defaultWorkflowFiles(): string[] {
  const dir = path.join(process.cwd(), '.github', 'workflows');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => path.join('.github', 'workflows', f));
}

async function runInventory(
  files: string[],
  options: {
    offline?: boolean;
    dryRun?: boolean;
    updateLock?: boolean;
    updateLockfile?: boolean;
    check?: boolean;
    compare?: boolean;
  }
): Promise<void> {
  const update = options.updateLock || options.updateLockfile;
  const check = options.check || options.compare;
  if (update && check) {
    logger.error('Use either --update-lock or --check, not both.');
    process.exit(1);
  }
  const targets = files.length > 0 ? files : defaultWorkflowFiles();
  if (targets.length === 0) {
    logger.error('No workflow files given and none found in .github/workflows');
    process.exit(1);
  }
  targets.forEach(requireFile);

  const resolver = options.offline
    ? undefined
    : (uses: string) => resolveActionSha(uses);

  // Merge every file's remote actions by `uses`.
  const byUses = new Map<string, InventoryAction>();
  for (const file of targets) {
    try {
      const parsed = parseFile(file);
      if (parsed.type !== 'workflow') continue;
      const inv = await buildInventory(
        { type: 'workflow', path: file, file: parsed.file },
        resolver
      );
      for (const action of inv.actions) {
        const existing = byUses.get(action.uses);
        if (existing) existing.paths.push(...action.paths);
        else byUses.set(action.uses, { ...action });
      }
    } catch (error) {
      logger.error(
        `Could not read ${file}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  }

  // Download progress would corrupt --dry-run's JSON on stdout; warnings
  // still go to stderr.
  if (options.dryRun) logger.setLevel(LogLevel.WARN);

  // Follow remote composite actions and reusable workflows into the
  // actions they use, downloaded at the resolved commit.
  const actions = (
    await addTransitive([...byUses.values()], {
      resolveSha: resolver,
      fetch: (uses, kind) =>
        kind === 'action'
          ? fetchAction(uses, { offline: options.offline })
          : fetchRepoFile(uses, { offline: options.offline }),
      warn: (message) => logger.warn(message)
    })
  ).sort((a, b) => a.uses.localeCompare(b.uses));

  const lockPath = path.join(process.cwd(), LOCKFILE_NAME);
  // secureci.lock is first-class; GitHub's actions.lock is used only when
  // it is the lockfile the repository provides.
  const source = findLockfile(process.cwd());
  // `--update-lock`, or bare `inventory` when no lockfile exists yet,
  // writes the lock; otherwise (`--check`, or bare `inventory` with a
  // lockfile) compares against it.
  const writing = update || (!check && !source);
  let lock: Lockfile | undefined;
  const github = source?.kind === 'github';
  const lockName = github ? 'actions.lock' : LOCKFILE_NAME;
  if (!writing && !options.dryRun) {
    if (!source) {
      logger.error(
        `No ${LOCKFILE_NAME} found (or GitHub's ${GITHUB_LOCKFILE}). Create one with: secureci inventory --update-lock`
      );
      process.exit(1);
    }
    try {
      lock = readLockfile(source);
    } catch (error) {
      logger.error(
        `Could not read ${lockName}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  }

  // Repository identity: recorded when writing; when checking, looked up
  // only for repositories the lock has an identity for.
  if (!options.offline) {
    const lookups = new Map<
      string,
      Promise<{ ownerId: number; repoId: number } | undefined>
    >();
    for (const action of actions) {
      if (!action.resolvedSha) continue;
      if (lock && lock.actions[action.uses]?.repoId === undefined) continue;
      const key = `${action.owner}/${action.repo}`.toLowerCase();
      if (!lookups.has(key)) {
        lookups.set(key, resolveRepoIdentity(action.owner, action.repo));
      }
      const identity = await lookups.get(key);
      if (identity) Object.assign(action, identity);
    }
  }

  const current: Record<string, LockEntry> = {};
  for (const action of actions) {
    if (!action.resolvedSha) continue;
    current[action.uses] = {
      commit: action.resolvedSha,
      ...(action.ownerId !== undefined ? { ownerId: action.ownerId } : {}),
      ...(action.repoId !== undefined ? { repoId: action.repoId } : {}),
      ...(action.via ? { via: action.via } : {})
    };
  }

  // --dry-run: print the resolved inventory as JSON, touching nothing.
  if (options.dryRun) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ actions }, null, 2));
    return;
  }

  if (writing) {
    fs.writeFileSync(lockPath, serializeSecureciLockfile(current));
    const transitive = Object.values(current).filter((e) => e.via).length;
    logger.success(
      `Wrote ${Object.keys(current).length} action(s) to ${LOCKFILE_NAME}` +
        (transitive > 0 ? ` (${transitive} used by other actions)` : '') +
        '. Commit it to track supply-chain drift.'
    );
    return;
  }

  const fixHint = github
    ? 'run `gh actions-lock` to update actions.lock'
    : 'run with --update-lock to accept it';
  logger.info(`Checking against ${github ? GITHUB_LOCKFILE : LOCKFILE_NAME}`);

  const diff = diffLock(current, lock as Lockfile);
  for (const d of diff.drifted) {
    logger.error(
      `Drift: ${d.uses} now resolves to ${d.to.slice(0, 12)} (was ${d.from.slice(0, 12)})`
    );
  }
  for (const d of diff.identity) {
    logger.error(
      `Repository changed: ${d.uses} ${d.field} is now ${d.to} (was ${d.from}). The name now points at a different ${d.field === 'repo_id' ? 'repository (deleted and re-created?)' : 'owner (transferred, or the account re-registered?)'}.`
    );
  }
  diff.added.forEach((u) => logger.warn(`New action not in ${lockName}: ${u}`));
  // actions.lock is written by `gh actions-lock`, which may record entries
  // SecureCI doesn't follow, so "no longer used" is only for secureci.lock.
  if (!github) {
    diff.removed.forEach((u) =>
      logger.info(`In ${lockName} but no longer used: ${u}`)
    );
  }
  if (diff.identity.length > 0) {
    logger.error(
      `A locked repository is no longer the one that was locked. Verify it before trusting it, then ${fixHint}.`
    );
    process.exit(1);
  }
  if (diff.drifted.length > 0) {
    logger.error(
      `Action commits drifted from ${lockName}. Review the change, then ${fixHint}.`
    );
    process.exit(1);
  }
  if (diff.added.length > 0) {
    logger.warn(`New actions are not yet in ${lockName} (${fixHint}).`);
    process.exit(1);
  }
  logger.success(`No action drift against ${lockName}.`);
}

async function validateOneFile(
  filePath: string,
  contractFile: string | undefined,
  recurse: ContractRecurse,
  say: (fn: () => void) => void
): Promise<ValidationResult> {
  const parsed = parseFile(filePath);
  let result: ValidationResult;

  if (parsed.type === 'workflow') {
    result = validateWorkflow(filePath);
    say(() => logger.info(`Validating workflow: ${filePath}`));
  } else {
    result = validateAction(filePath);
    say(() => logger.info(`Validating action: ${filePath}`));
  }

  if (contractFile) {
    say(() =>
      logger.info(`Validating against pipeline contract: ${contractFile}`)
    );
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
      const contractResult = await validatePipelineContract(parsed, spec, {
        recurse
      });
      result = {
        valid: result.valid && contractResult.valid,
        errors: [...result.errors, ...contractResult.errors]
      };
    }
  }
  return result;
}

async function validateFiles(
  files: string[],
  contractFile?: string,
  recurse: ContractRecurse = 'local',
  format: ReportFormat = 'text'
): Promise<void> {
  // Only text mode narrates; json/sarif write nothing but the report to
  // stdout, so the output is pipeable.
  const quiet = format !== 'text';
  const say = (fn: () => void) => {
    if (!quiet) fn();
  };

  // A contract may be a local file or `owner/repo/path@ref` in another
  // repository; resolve it once and record which version was enforced.
  let contractPath = contractFile;
  let contract: ContractInfo | undefined;
  let contractError: string | undefined;
  if (contractFile) {
    try {
      const source = await resolveContractSource(contractFile, {
        fetchFile: (uses) => fetchRepoFile(uses),
        resolveSha: (uses) => resolveActionSha(uses),
        warn: (message) => logger.warn(message)
      });
      contractPath = source.file;
      const remote = source.remote;
      contract = remote
        ? {
            source: remote.uses,
            ref: remote.ref,
            commit: remote.commit,
            pinned: remote.pinned
          }
        : { source: contractFile };
      if (remote) {
        say(() =>
          logger.info(
            `Using contract ${remote.uses}${remote.commit ? ` at commit ${remote.commit.slice(0, 12)}` : ''}`
          )
        );
      }
    } catch (error) {
      contractError = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  const entries: ReportEntry[] = [];
  for (const filePath of files) {
    try {
      if (contractError) throw new Error(contractError);
      const result = await validateOneFile(
        filePath,
        contractPath,
        recurse,
        say
      );
      entries.push({ file: filePath, result });
    } catch (error) {
      entries.push({
        file: filePath,
        result: {
          valid: false,
          errors: [
            {
              path: 'root',
              message: error instanceof Error ? error.message : 'Unknown error',
              severity: 'error'
            }
          ]
        }
      });
    }
  }

  const allValid = entries.every((e) => e.result.valid);

  if (quiet) {
    // eslint-disable-next-line no-console
    console.log(formatReport(entries, format, { contract }));
    if (!allValid) process.exit(1);
    return;
  }

  for (const { file, result } of entries) {
    if (result.valid) {
      logger.success(`Validation passed: ${file}`);
      result.errors.forEach((error) =>
        logger.warn(
          `  [${error.severity.toUpperCase()}] ${error.path}: ${error.message}`
        )
      );
    } else {
      logger.error(`Validation failed: ${file}`);
      result.errors.forEach((error) =>
        logger.error(
          `  [${error.severity.toUpperCase()}] ${error.path}: ${error.message}`
        )
      );
    }
  }
  if (!allValid) process.exit(1);
}

function runInit(options: {
  contract?: string;
  upload: boolean;
  output: string;
  force?: boolean;
}): void {
  const output = path.resolve(process.cwd(), options.output);
  if (fs.existsSync(output) && !options.force) {
    logger.error(
      `${options.output} already exists; pass --force to overwrite it.`
    );
    process.exit(1);
  }

  const content = renderInitWorkflow({
    version: readVersion(),
    contract: options.contract,
    upload: options.upload
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, content);

  logger.success(`Wrote ${options.output}`);
  if (options.upload) {
    logger.info(
      'The workflow uploads SARIF to code scanning (needs security-events: write).'
    );
  }
  logger.info('Commit it and open a pull request to see SecureCI run.');
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
    } catch {
      logger.warn(`  - ${file}: (failed to parse)`);
    }
  });
}

const configCmd = program
  .command('config')
  .description('Manage global configuration (~/.secureci/config.yml)');

configCmd
  .command('path')
  .description('Print the config file path')
  .action(() => {
    logger.info(getConfigFilePath());
  });

configCmd
  .command('list')
  .description('List config values, including built-in defaults')
  .action(() => {
    const config = loadConfig();
    for (const key of CONFIG_KEYS) {
      const value = config[key];
      const fallback = DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG];
      logger.info(
        `${key}=${
          value !== undefined
            ? value
            : fallback !== undefined
              ? `${fallback} (default)`
              : '(unset)'
        }`
      );
    }
    for (const [label, image] of Object.entries(
      config['runner-images'] ?? {}
    )) {
      logger.info(`runner-images.${label}=${image}`);
    }
  });

configCmd
  .command('get <key>')
  .description('Print a config value')
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
  .description('Set a config value')
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
  .description('Remove a config value, reverting to the built-in default')
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

const cacheCmd = program
  .command('cache')
  .description('Manage the cache of downloaded remote actions');

cacheCmd
  .command('path')
  .description('Print the action cache directory')
  .action(() => {
    logger.info(getActionCacheDir());
  });

cacheCmd
  .command('clear')
  .description('Delete all cached remote actions')
  .action(() => {
    clearActionCache();
  });

// With no command, show help and fail, like other vendor CLIs.
if (process.argv.length <= 2) {
  program.outputHelp({ error: true });
  process.exit(1);
}

program.parse();
