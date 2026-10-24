#!/usr/bin/env node

import { Command, Option } from 'commander';
import { dryRun } from './runner/dry-run';
import { MatrixFilter, parseMatrixFilter } from './runner/job-plan';
import { executeWorkflow } from './runner/executor';
import {
  clearActionCache,
  fetchAction,
  fetchRepoFile,
  cachedActionSha,
  getActionCacheDir,
  githubToken,
  repoExists,
  resolveActionSha,
  resolveRepoIdentity
} from './runner/action-fetcher';
import { Progress } from './utils/progress';
import { resolveContractSource } from './contract-source';
import {
  mergeValidationResults,
  validateWorkflow,
  validateAction
} from './parser/validator';
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
import { localPinTargets, pinContent } from './pin';
import {
  AdvisoryChecker,
  AdvisoryReport,
  checkFileAdvisories,
  describeReport,
  FailOn,
  mergeReports,
  targetsFromInventory
} from './advisories';
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
import { loadKeyValues } from './utils/env-file';
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
  getDefaultParallel,
  CONFIG_KEYS
} from './config';
import { parseParallel } from './runner/scheduler';
import { readVersion } from './version';
import * as fs from 'fs';
import * as path from 'path';

/** Committed at the repo root, like package-lock.json / yarn.lock. */
const LOCKFILE_NAME = 'secureci.lock';

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
let defaultParallel = 1;
try {
  defaultParallel = getDefaultParallel(globalConfig);
} catch (error) {
  configError ??= error instanceof Error ? error.message : String(error);
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
    '--env-file <file...>',
    'Read --env values from a .env-style file. Repeatable; later files win, --env wins over files. Config: env-file'
  )
  .option(
    '--secret-file <file...>',
    'Read --secret values from a .env-style file; every value is masked. Repeatable; later files win, --secret wins over files. Config: secret-file'
  )
  .option(
    '--input-file <file...>',
    'Read --input values from a .env-style file. Repeatable; later files win, --input wins over files. Config: input-file'
  )
  .option(
    '--var-file <file...>',
    'Read --var values from a .env-style file. Repeatable; later files win, --var wins over files. Config: var-file'
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
    '--matrix <key:value...>',
    'Run only the matrix combinations whose key has this value (as shown in the job name). Repeat for more keys (all must match) or values (any matches)'
  )
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
  .option(
    '--parallel <n>',
    'Run up to this many jobs (and matrix combinations) at once; 1 runs them one after another. Default: the number of CPUs. Config: parallel',
    String(defaultParallel)
  )
  .action(async (file: string, options) => {
    if (configError) {
      logger.error(configError);
      process.exit(1);
    }
    requireFile(file);

    let matrix: MatrixFilter;
    try {
      matrix = parseMatrixFilter(options.matrix);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    if (options.dryRun) {
      const result = dryRun(file, { job: options.job, matrix });
      if (!result.success) {
        process.exit(1);
      }
      return;
    }

    logger.info(
      "Running the workflow for real (not a dry run). Use --dry-run to simulate without executing, or 'secureci validate' to only check for errors."
    );

    try {
      const inputs = loadKeyValues({
        flagName: '--input',
        fileFlagName: '--input-file',
        pairs: options.input,
        files: options.inputFile,
        configFiles: globalConfig['input-file']
      });
      const secrets = loadKeyValues({
        flagName: '--secret',
        fileFlagName: '--secret-file',
        pairs: options.secret,
        files: options.secretFile,
        configFiles: globalConfig['secret-file'],
        secret: true,
        fromEnv: process.env
      });
      const vars = loadKeyValues({
        flagName: '--var',
        fileFlagName: '--var-file',
        pairs: options.var,
        files: options.varFile,
        configFiles: globalConfig['var-file']
      });
      const env = loadKeyValues({
        flagName: '--env',
        fileFlagName: '--env-file',
        pairs: options.env,
        files: options.envFile,
        configFiles: globalConfig['env-file'],
        fromEnv: process.env
      });
      const parallel = parseParallel(options.parallel);

      const result = await executeWorkflow(file, {
        dryRun: false,
        inputs,
        secrets,
        vars,
        env,
        eventPath: options.eventPath,
        eventName: options.eventName,
        job: options.job,
        matrix,
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
        ),
        parallel
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
  .option(
    '--offline',
    'Do not use the network: skip the security advisory lookup (cached advisories are still used), and read remote contracts and actions only from the cache'
  )
  .action(
    async (
      files: string[],
      options: {
        contract?: string;
        contractRecurse: ContractRecurse;
        format: ReportFormat;
        offline?: boolean;
      }
    ) => {
      files.forEach(requireFile);
      await validateFiles(
        files,
        options.contract,
        options.contractRecurse,
        options.format,
        options.offline ?? false
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
    'Do not resolve tags to commit SHAs or query security advisories over the network (already-pinned refs still resolve; cached advisories are used)'
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
  .command('pin')
  .description(
    'Pin action and reusable-workflow tags to commit SHAs in place (`owner/repo@<sha> # v4`), keeping formatting and comments'
  )
  .argument(
    '[file...]',
    'Workflow or action files (default: every file in .github/workflows, plus the local actions and reusable workflows they use)'
  )
  .option(
    '--check',
    'Change nothing; exit non-zero if any reference would be pinned or cannot be resolved (for CI)'
  )
  .option(
    '-c, --contract <file>',
    "Leave the owners/actions in this pipeline contract's pins.allow on their tags"
  )
  .option(
    '--offline',
    'Do not use the network: only refs already in the action cache resolve; others are reported, not changed'
  )
  .option(
    '--update-lock',
    `Afterwards, write ./${LOCKFILE_NAME} from the pinned workflows (as \`inventory --update-lock\`)`
  )
  .action(async (files: string[], options) => {
    await runPin(files, options);
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

  // Merge every file's remote actions by `uses`.
  const byUses = new Map<string, InventoryAction>();
  for (const file of targets) {
    try {
      const parsed = parseFile(file);
      if (parsed.type !== 'workflow') continue;
      const inv = await buildInventory({
        type: 'workflow',
        path: file,
        file: parsed.file
      });
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
  const direct = [...byUses.values()];

  const lockPath = path.join(process.cwd(), LOCKFILE_NAME);
  // secureci.lock is first-class; GitHub's actions.lock is used only when
  // it is the lockfile the repository provides.
  const source = findLockfile(process.cwd());
  // `--update-lock`, or bare `inventory` when no lockfile exists yet,
  // writes the lock; otherwise (`--check`, or bare `inventory` with a
  // lockfile) compares against it.
  const writing = update || (!check && !source);
  const comparing = !writing && !options.dryRun;
  let lock: Lockfile | undefined;
  const github = source?.kind === 'github';
  const lockName = github ? 'actions.lock' : LOCKFILE_NAME;
  if (comparing) {
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

  // Download messages would corrupt --dry-run's JSON on stdout and clash
  // with the progress lines; warnings and errors still go to stderr.
  const level = logger.getLevel();
  if (level === LogLevel.INFO) logger.setLevel(LogLevel.WARN);
  const online = !options.offline;
  if (online && direct.length > 0) {
    process.stderr.write(
      `Resolving ${direct.length} action(s) over the network, and reading the actions they use. This can take a while (--offline uses only what is cached).\n`
    );
  }

  // 1. Resolve each tag or branch to the commit it points at.
  const toResolve = online ? direct.filter((a) => !a.resolvedSha) : [];
  const resolving = new Progress('Resolving tags', toResolve.length);
  for (const action of toResolve) {
    resolving.tick(action.uses);
    action.resolvedSha = await resolveActionSha(action.uses);
  }
  resolving.done(`Resolved ${toResolve.length} tag(s)`);

  // 2. Follow remote composite actions and reusable workflows into the
  // actions they use, downloaded at the resolved commit.
  const reading = new Progress('Reading actions', online ? direct.length : 0);
  let read = 0;
  const actions = (
    await addTransitive(direct, {
      resolveSha: online ? (uses) => resolveActionSha(uses) : undefined,
      fetch: (uses, kind) => {
        if (online)
          reading.tick(uses.replace(/@([0-9a-f]{12})[0-9a-f]{28}$/, '@$1'));
        read++;
        return kind === 'action'
          ? fetchAction(uses, { offline: options.offline })
          : fetchRepoFile(uses, { offline: options.offline });
      },
      warn: (message) => logger.warn(message),
      onQueue: () => reading.grow()
    })
  ).sort((a, b) => a.uses.localeCompare(b.uses));
  reading.done(`Read ${read} action(s) for the actions they use`);

  // 3. Repositories: identity (recorded when writing; when comparing, only
  // where the lock has one), and whether a SHA-pinned action's repository
  // still exists, since resolving a pin needs no network.
  type RepoCheck = {
    owner: string;
    repo: string;
    identity: boolean;
    existence: boolean;
  };
  const repos = new Map<string, RepoCheck>();
  if (online) {
    for (const action of actions) {
      if (!action.resolvedSha) continue;
      const identity = !lock || lock.actions[action.uses]?.repoId !== undefined;
      const existence = comparing && action.pinned;
      if (!identity && !existence) continue;
      const key = `${action.owner}/${action.repo}`.toLowerCase();
      const entry = repos.get(key) ?? {
        owner: action.owner,
        repo: action.repo,
        identity: false,
        existence: false
      };
      entry.identity ||= identity;
      entry.existence ||= existence;
      repos.set(key, entry);
    }
  }
  const identities = new Map<string, { ownerId: number; repoId: number }>();
  const missingRepos = new Set<string>();
  const checking = new Progress('Checking repositories', repos.size);
  for (const [key, r] of repos) {
    checking.tick(`${r.owner}/${r.repo}`);
    const identity = r.identity
      ? await resolveRepoIdentity(r.owner, r.repo)
      : undefined;
    if (identity) identities.set(key, identity);
    else if (r.existence && !(await repoExists(r.owner, r.repo))) {
      missingRepos.add(key);
    }
  }
  checking.done(
    `Checked ${repos.size} repositor${repos.size === 1 ? 'y' : 'ies'}`
  );
  for (const action of actions) {
    const identity = identities.get(
      `${action.owner}/${action.repo}`.toLowerCase()
    );
    if (identity && action.resolvedSha) Object.assign(action, identity);
  }

  // 4. Known security advisories for every action, direct and transitive.
  const repoCount = new Set(
    actions.map((a) => `${a.owner}/${a.repo}`.toLowerCase())
  ).size;
  const advising = new Progress(
    'Checking security advisories',
    online ? repoCount : 0
  );
  const advisoryReport: AdvisoryReport = await new AdvisoryChecker({
    offline: !online,
    onLookup: (repo) => {
      if (online) advising.tick(repo);
    }
  }).check(targetsFromInventory(actions));
  advising.done(
    `Checked security advisories for ${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'}`
  );
  logger.setLevel(level);

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
    console.log(
      JSON.stringify(
        {
          actions,
          advisories: advisoryReport.findings,
          advisoryUnknownVersions: advisoryReport.unknownVersions
        },
        null,
        2
      )
    );
    // The findings are in the JSON; say on stderr what wasn't checked.
    describeReport(advisoryReport)
      .filter((line) => line.kind === 'note' && line.level === 'warn')
      .forEach((line) => logger.warn(line.text));
    return;
  }

  // Advisories are reported, but don't change the exit code here: gate on
  // them with `secureci validate` (rule secureci/vulnerable-action).
  for (const line of describeReport(advisoryReport)) {
    logger[line.level](line.text);
  }

  // Used references that couldn't be resolved to a commit now.
  const unresolved = actions.filter((a) => !a.resolvedSha);

  if (writing) {
    if (online) {
      unresolved.forEach((a) =>
        logger.warn(
          `Not locked: could not resolve ${a.uses} (repository deleted, renamed or private, or the network is unavailable?)`
        )
      );
    }
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
  for (const a of actions) {
    if (missingRepos.has(`${a.owner}/${a.repo}`.toLowerCase())) {
      logger.error(
        `Repository gone: ${a.uses} can no longer be read (deleted, renamed or made private?). The locked commit can't be fetched, and the name could be re-registered by someone else.`
      );
    }
  }
  // Online, a used reference that doesn't resolve is a failure (its
  // repository may be gone); offline, tags can't resolve, so it's a warning.
  for (const a of unresolved) {
    const locked = lock?.actions[a.uses];
    const at = locked ? ` (locked at ${locked.commit.slice(0, 12)})` : '';
    if (online) {
      logger.error(
        `Could not resolve ${a.uses}${at}: the repository or ref may have been deleted, renamed or made private, or the network is unavailable.`
      );
    }
  }
  if (!online && unresolved.length > 0) {
    logger.warn(
      `Not checked offline (tags need the network): ${unresolved.map((a) => a.uses).join(', ')}`
    );
  }
  diff.added.forEach((u) => logger.warn(`New action not in ${lockName}: ${u}`));
  // actions.lock is written by `gh actions-lock`, which may record entries
  // SecureCI doesn't follow, so "no longer used" is only for secureci.lock.
  // A reference still in use but unresolved isn't "no longer used".
  if (!github) {
    const used = new Set(unresolved.map((a) => a.uses));
    diff.removed
      .filter((u) => !used.has(u))
      .forEach((u) => logger.info(`In ${lockName} but no longer used: ${u}`));
  }
  if (diff.identity.length > 0) {
    logger.error(
      `A locked repository is no longer the one that was locked. Verify it before trusting it, then ${fixHint}.`
    );
    process.exit(1);
  }
  if (missingRepos.size > 0 || (online && unresolved.length > 0)) {
    logger.error(
      `Locked actions could not be verified. Check that each repository and ref still exists and is readable${githubToken() ? '' : ' (set GITHUB_TOKEN for private repositories)'}.`
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

async function runPin(
  files: string[],
  options: {
    check?: boolean;
    contract?: string;
    offline?: boolean;
    updateLock?: boolean;
  }
): Promise<void> {
  if (options.check && options.updateLock) {
    logger.error('Use either --update-lock or --check, not both.');
    process.exit(1);
  }
  const given = files.length > 0 ? files : defaultWorkflowFiles();
  if (given.length === 0) {
    logger.error('No workflow files given and none found in .github/workflows');
    process.exit(1);
  }
  given.forEach(requireFile);
  // Explicit files are pinned as given; the default run covers the whole
  // repository, including local actions the workflows use.
  const targets = files.length > 0 ? given : localPinTargets(given);

  let allow: string[] = [];
  if (options.contract) {
    try {
      const source = await resolveContractSource(options.contract, {
        fetchFile: (uses) => fetchRepoFile(uses, { offline: options.offline }),
        resolveSha: (uses) =>
          options.offline
            ? Promise.resolve(cachedActionSha(uses))
            : resolveActionSha(uses),
        warn: (message) => logger.warn(message)
      });
      allow = parsePipelineContract(source.file).pins?.allow ?? [];
    } catch (error) {
      logger.error(
        `Could not read contract ${options.contract}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      process.exit(1);
    }
  }

  // Each distinct reference is resolved once, across all files.
  const resolving = new Progress('Resolving tags', 0);
  const resolved = new Map<string, Promise<string | undefined>>();
  const resolve = (uses: string): Promise<string | undefined> => {
    let sha = resolved.get(uses);
    if (!sha) {
      if (options.offline) {
        sha = Promise.resolve(cachedActionSha(uses));
      } else {
        resolving.grow();
        resolving.tick(uses);
        sha = resolveActionSha(uses);
      }
      resolved.set(uses, sha);
    }
    return sha;
  };

  const display = (file: string) =>
    path.relative(process.cwd(), path.resolve(file)) || file;
  let changes = 0;
  let changedFiles = 0;
  let unresolved = 0;
  let unreadable = false;
  const report = options.check
    ? (m: string) => logger.error(m)
    : (m: string) => logger.warn(m);
  for (const file of targets) {
    const name = display(file);
    let result;
    try {
      result = await pinContent(fs.readFileSync(file, 'utf-8'), resolve, {
        allow
      });
    } catch (error) {
      logger.error(
        `Could not read ${name}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
      unreadable = true;
      continue;
    }
    for (const a of result.allowed) {
      logger.info(`${name}:${a.line} ${a.uses} left on its tag (pins.allow)`);
    }
    for (const c of result.changes) {
      logger.info(
        `${name}:${c.line} ${c.uses} -> ${c.sha.slice(0, 12)} (${c.ref})`
      );
    }
    for (const u of result.unresolved) {
      report(
        `${name}:${u.line} ${u.uses} ${u.reason}` +
          (options.offline && u.reason.startsWith('could not')
            ? ' (offline: only refs in the action cache resolve)'
            : '') +
          '; left unchanged'
      );
    }
    changes += result.changes.length;
    unresolved += result.unresolved.length;
    if (result.changes.length > 0) {
      changedFiles++;
      if (!options.check) fs.writeFileSync(file, result.content);
    }
  }
  resolving.done(`Resolved ${resolved.size} reference(s)`);

  const fileCount = `${changedFiles} file(s)`;
  const unresolvedHint = options.offline
    ? ''
    : ` (check that each repository and ref exists${githubToken() ? '' : '; set GITHUB_TOKEN for private repositories'})`;
  if (options.check) {
    if (changes > 0) {
      logger.error(
        `${changes} reference(s) would be pinned in ${fileCount}. Run \`secureci pin\` to pin them.`
      );
    }
    if (unresolved > 0) {
      logger.error(
        `${unresolved} reference(s) could not be resolved${unresolvedHint}.`
      );
    }
    if (changes > 0 || unresolved > 0 || unreadable) process.exit(1);
    logger.success('Nothing to pin: every remote reference is pinned.');
    return;
  }
  if (changes > 0) {
    logger.success(`Pinned ${changes} reference(s) in ${fileCount}.`);
  } else if (unresolved === 0) {
    logger.success('Nothing to pin: every remote reference is pinned.');
  }
  if (unresolved > 0) {
    logger.warn(
      `${unresolved} reference(s) could not be resolved and were left unchanged${unresolvedHint}.`
    );
  }
  if (unreadable) process.exit(1);
  if (options.updateLock) {
    await runInventory(files, { offline: options.offline, updateLock: true });
  }
}

async function validateOneFile(
  filePath: string,
  contractFile: string | undefined,
  recurse: ContractRecurse,
  say: (fn: () => void) => void,
  advisories: { checker: AdvisoryChecker; reports: AdvisoryReport[] },
  offline: boolean
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

  let failOn: FailOn | undefined;
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
      failOn = spec.advisories?.failOn;
      const contractResult = await validatePipelineContract(parsed, spec, {
        recurse,
        offline
      });
      result = mergeValidationResults(result, contractResult);
    }
  }

  // Known security advisories for the file's own uses: references.
  const { errors, report } = await checkFileAdvisories(
    parsed,
    advisories.checker,
    failOn
  );
  advisories.reports.push(report);
  return {
    valid: result.valid && errors.every((e) => e.severity !== 'error'),
    errors: [...result.errors, ...errors]
  };
}

async function validateFiles(
  files: string[],
  contractFile: string | undefined,
  recurse: ContractRecurse,
  format: ReportFormat,
  offline: boolean
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
        fetchFile: (uses) => fetchRepoFile(uses, { offline }),
        resolveSha: async (uses) =>
          offline ? undefined : resolveActionSha(uses),
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

  // One lookup per repository across all files (and a 24h disk cache).
  const advisories = {
    checker: new AdvisoryChecker({ offline }),
    reports: [] as AdvisoryReport[]
  };
  const entries: ReportEntry[] = [];
  for (const filePath of files) {
    try {
      if (contractError) throw new Error(contractError);
      const result = await validateOneFile(
        filePath,
        contractPath,
        recurse,
        say,
        advisories,
        offline
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

  // What couldn't be checked, once for all files: warnings on stderr, and
  // (text mode only) unknown versions as info. Findings are in the results.
  for (const line of describeReport(mergeReports(advisories.reports))) {
    if (line.kind !== 'note') continue;
    if (line.level === 'warn') logger.warn(line.text);
    else say(() => logger.info(line.text));
  }

  if (quiet) {
    // eslint-disable-next-line no-console
    console.log(formatReport(entries, format, { contract }));
    if (!allValid) process.exit(1);
    return;
  }

  for (const { file, result } of entries) {
    if (result.valid) logger.success(`Validation passed: ${file}`);
    else logger.error(`Validation failed: ${file}`);
    for (const error of result.errors) {
      const line = `  [${error.severity.toUpperCase()}] ${error.path}: ${error.message}`;
      if (error.severity === 'warning') logger.warn(line);
      else logger.error(line);
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
