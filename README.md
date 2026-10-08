# SecureCI CLI

[![CI](https://github.com/secure-ci/cli/actions/workflows/ci.yaml/badge.svg)](https://github.com/secure-ci/cli/actions/workflows/ci.yaml)

`@secureci/cli` provides the `secureci` command: validate GitHub Actions workflows, check them against pipeline standards, and run them locally. It is the free, open-source part of [SecureCI](https://www.secure-ci.dev).

A CLI tool to locally test GitHub Actions and workflows without pushing to remote.

## Features

- 🔍 Dry run mode for sanity checks
- 📝 Pass inputs and secrets via CLI
- 📐 Validate a caller workflow against a central pipeline contract (`secureci validate --contract`)
- 🔄 Support for reusable workflows and actions
- ⛓️ Execute chained workflows and actions
- 🚦 GitHub expressions in `${{ }}` and `if:`: all common contexts (`github`, `env`, `inputs`, `secrets`, `steps`, `needs`, `matrix`, `job`, `runner`, `vars`, `strategy`), operators and functions (`contains`, `startsWith`, `format`, `fromJSON`, `hashFiles`, `always()`, `failure()`, ...)
- 🔗 `needs:` job dependency ordering (topological sort)
- 📤 Step outputs via `$GITHUB_OUTPUT`, consumable by later steps/jobs
- 🔒 Automatic secret masking in all log output
- 📦 Container isolation: one container per job for `run:` steps and JavaScript actions (Docker, Podman or containerd)
- 🚀 Fetch and run remote GitHub Actions (composite and JavaScript actions)
- 💾 Action caching for faster execution
- 🎯 Minimal dependencies, focused on MVP

## Installation

```bash
npm install -g @secureci/cli
# or, without installing:
npx @secureci/cli --help
```

Or run locally:

```bash
npm install
npm run build
```

## Usage

```bash
# Dry run a workflow
secureci run .github/workflows/ci.yml --dry-run

# Execute a workflow
secureci run .github/workflows/build.yml --input key=value

# Pass env vars to steps (a bare NAME passes $NAME from your shell)
secureci run .github/workflows/build.yml --env NPM_CONFIG_REGISTRY

# Run with secrets (a bare NAME reads $NAME from your environment, which
# keeps the value out of the process list and shell history)
secureci run .github/workflows/deploy.yml --secret TOKEN
secureci run .github/workflows/deploy.yml --secret TOKEN=xxx

# Validate workflow syntax
secureci validate .github/workflows/ci.yml

# Validate a caller workflow against a central pipeline contract
secureci validate .github/workflows/deploy.yml --contract contracts/platform-standard.yml

# Run a specific job
secureci run .github/workflows/ci.yml --job build

# List workflows in .github/workflows/
secureci list

# Run with container isolation (Docker or Podman)
secureci run .github/workflows/ci.yml --container-runtime=auto
secureci run .github/workflows/ci.yml --container-runtime=docker --container-image=node:20-alpine
secureci run .github/workflows/ci.yml --container-runtime=podman --container-memory=512m --no-network
```

### Container Isolation Flags

| Flag                         | Description                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--container-runtime <name>` | `auto`\|`docker`\|`podman`\|`containerd`\|`none` (default: `docker`, overridable via `~/.secureci/config.yml`; use `none` for the old host-execution default) |
| `--container-image <image>`  | Image for every job without `jobs.<id>.container`, overriding the `runs-on` mapping (see below)                                                               |
| `--container-timeout <ms>`   | Per-step timeout in milliseconds                                                                                                                              |
| `--container-memory <limit>` | Memory limit, e.g. `512m`                                                                                                                                     |
| `--no-network`               | Disable container network access (networking is on by default, like GitHub-hosted runners)                                                                    |
| `--allow-network`            | Allow container network access; only needed to override `allow-network: false` in the config file                                                             |

`containerd` is driven via its Docker-CLI-compatible front-end, [`nerdctl`](https://github.com/containerd/nerdctl).

#### How container mode works

- Each job (and each matrix combination) gets **one container**, started when the job begins and removed when it ends, including when a step fails or you press Ctrl-C. Every `run:` step and JavaScript action in the job runs in it via `exec`, so files, installed packages and tools from earlier steps are still there. The current directory is mounted at `/secureci-workspace`.
- The image is chosen in this order:
  1. `jobs.<id>.container` (string or `{ image, env }` form; `options`, `volumes`, `ports` and `credentials` are ignored with a warning). With `--container-runtime none` it's ignored and the job runs on the host.
  2. `--container-image`, for every job.
  3. The job's `runs-on` label, mapped to a runner-like image: `ubuntu-latest` → `catthehacker/ubuntu:act-latest`, `ubuntu-24.04` / `22.04` / `20.04` → `catthehacker/ubuntu:act-24.04` / `act-22.04` / `act-20.04` (the images nektos/act uses, with Node.js, git, curl and common runner tools). Add or override labels with `runner-images` in the config file (below).
  4. `container-image` from the config file, else `catthehacker/ubuntu:act-22.04`, for labels with no mapping (self-hosted, custom), with a warning. `windows-*` / `macos-*` jobs also run in this Linux image, with a warning.
- The runner images are large (about 2 GB unpacked) and pulled on first use.
- JavaScript actions run with the image's own `node`. If an image has no Node.js (e.g. a plain `ubuntu:22.04` via `--container-image`), they fail with a clear error.
- `services:` containers are not supported yet.
- `--container-timeout` fails a step that runs longer than the given time, and kills its processes in the job container (including background ones it started).

### Security: what runs where

> [!WARNING]
> With `--container-runtime none` (or when no container runtime is available and the CLI falls back to the host), `run:` steps and **remote JavaScript and composite actions run directly on your machine with your user's privileges**. Any third-party action can read your files and use your network. The CLI prints a warning listing the remote actions before such a job runs. Use a container runtime to sandbox them.

- On the host, steps and actions don't inherit your shell's environment: only `PATH`, `HOME`, locale, temp-dir, proxy/CA and container-client variables are passed, plus the runner's `GITHUB_*` / `RUNNER_*` variables and the workflow's own `env:`. Pass anything else explicitly with `--env NAME` (value from your shell) or `--env NAME=value`, and secrets with `--secret NAME`.
- In container mode, env values never appear on the container client's command line (see Secret Masking below).

### `actions/checkout`

`actions/checkout` of the repository being run (no `repository:` input, or the current repository) doesn't clone anything: the workspace already is your working copy, so later steps see your uncommitted changes, no network or token is needed, and your `.git` is never touched. The step's `ref` and `commit` outputs are `github.ref` and `github.sha`.

- `path:` copies the working copy into that subdirectory (skipping the copy itself) and removes it when the job ends. A non-empty directory there that the CLI didn't create is never overwritten; the step fails instead.
- `ref:` and other inputs (`fetch-depth`, `submodules`, ...) are ignored, with a warning for a `ref` other than the current one.
- Checkouts of **other** repositories run the real action, which needs a token: pass one with `--secret GITHUB_TOKEN` (reads `$GITHUB_TOKEN`). It becomes both `secrets.GITHUB_TOKEN` and `github.token`. No token is picked up implicitly, since every action in the run could read it.
- `--no-local-checkout` runs the real action for the current repository too.

### Global Configuration

The SecureCI CLI reads defaults from `~/.secureci/config.yml` (created on first `secureci config set`, or editable by hand). Config keys match the CLI flag names (kebab-case, minus the leading `--`). CLI flags always take precedence over the config file.

```bash
secureci config set container-runtime podman   # persist a default
secureci config get container-runtime
secureci config list
secureci config unset container-runtime        # revert to the built-in default (docker)
secureci config path                           # print the config file location
```

Supported keys: `container-runtime`, `container-image`, `container-timeout`, `container-memory`, `allow-network`, and `runner-images.<label>`:

```bash
secureci config set runner-images.ubuntu-latest node:20-bookworm   # map one runs-on label
secureci config set runner-images.my-self-hosted-runner my/image:1
```

```yaml
# ~/.secureci/config.yml
runner-images:
  ubuntu-latest: node:20-bookworm
  my-self-hosted-runner: my/image:1
```

### Pipeline Contracts (`secureci validate --contract`)

In organizations with a central repo of reusable workflows/actions, a platform team can define a minimum pipeline standard — required actions, forbidden actions, and (optionally) the order required actions must run in — and have the SecureCI CLI check a caller's workflow against it.

```yaml
# contracts/platform-standard.yml
ordering: relative # or "strict" (default: relative)
required:
  - uses: org/security-scan
    min-version: v1.2.0
  - uses: org/deploy
forbidden:
  - uses: org/legacy-deploy # forbid entirely, any version
  - uses: org/deploy
    version: v1 # forbid only this exact version
```

```bash
secureci validate .github/workflows/deploy.yml --contract contracts/platform-standard.yml
```

If the caller's workflow calls `org/deploy` before `org/security-scan` (or uses `org/legacy-deploy`, or omits a required action, or pins `org/security-scan` below `v1.2.0`), the command exits non-zero with a message like:

```
[INFO] Validating workflow...
[INFO] Validating against pipeline contract: contracts/platform-standard.yml
[ERROR] Validation failed:
[ERROR]   [ERROR] required[1]: Required action "org/deploy" must run after "org/security-scan", but it does not
```

- `uses:` steps in the workflow are checked, **including those inside local composite actions** (`uses: ./path`) **and local reusable workflows** (`jobs.<id>.uses: ./path.yml`), resolved recursively from the repository root, so wrapping an action doesn't hide it. With `--contract-recurse all`, **remote** composite actions and reusable workflows (`org/repo/...@ref`) are downloaded (through the action cache) and inspected too; one that can't be fetched is a warning. `--contract-recurse none` checks only the workflow file itself. The default, `local`, stays offline. Error paths show the call path, e.g. `jobs.release > ./.github/workflows/release.yml > jobs.ship.steps[0]`. Cycles and nesting deeper than 10 levels are errors; a local reference that can't be found is a warning.
- Ordering follows what GitHub guarantees: steps of a job run in order (a composite action's steps in place of its `uses:` step), and a job runs after every job it needs, directly or transitively (a reusable-workflow call's jobs run after the call's own `needs:`). Two required actions in jobs with **no `needs:` relationship** may run in parallel, so neither counts as "after" the other: that's an ordering error, whatever the jobs' order in the YAML.
- `ordering: relative` (default): required actions must appear in that relative order, with any other steps allowed in between. `ordering: strict`: required actions must run back-to-back, with no other step in between; across jobs, only the last step of a job followed by the first step of a job that directly needs it counts.
- A missing required action, a required action below `min-version`, an ordering violation, or any forbidden-action match is an **error** (validation fails). A required action whose version can't be compared (e.g. pinned to a branch or SHA) is a **warning**. Ordering is checked for every required action that is present, including one below `min-version` (its first occurrence is used), and errors name the contract's own `required[N]` entry.
- `--contract` runs the normal syntax validation too, and currently applies to workflow files only (not standalone actions, since the contract is about a job/step sequence). Passing `--contract` against an action file fails with a clear error.

**Known limitations (v1 scope):**

- Without `--contract-recurse all`, **remote** composite actions and reusable workflows are not inspected; only the reference itself is matched.
- **`strategy.matrix` jobs** are checked once against the job's `steps:` as authored, not once per combination: `uses:` can't contain expressions, so a matrix can only change _whether_ steps run (via `if:`), not which actions they use.
- **`if:` conditions** aren't evaluated. A required action that only appears in steps or jobs with an `if:` (other than `success()` / `always()`) is reported as a **warning** that it may be skipped; a forbidden action counts even under an `if:`.
- **Action references** are matched as exact strings against `uses:` (minus any `@version` suffix) — this covers the common `owner/repo` or `owner/repo/path` marketplace-action form, as well as local paths (`./.github/actions/foo`, matched with no version). `docker://image` references are matched as-is (the whole string, including `docker://`) and have no version-pin concept.
- The `owner/repo` part of an action reference is matched **case-insensitively**, as GitHub resolves it (`Org/Action` matches a contract entry for `org/action`). A path inside the repo (`owner/repo/Path`), local paths and `docker://` references (whose tags are case-sensitive) are matched exactly.

## Workflow Features

### Conditional Execution (`if:`)

Jobs and steps support `if:` expressions, and `${{ }}` works anywhere a value is expected (`run:`, `env:`, `with:`, `outputs:`). Supported:

- **Contexts:**
  - `github` (including `github.event`)
  - `env`, `inputs`, `secrets`, `matrix`
  - `steps` (`outputs`, `outcome`, `conclusion`)
  - `needs` (`outputs`, `result`)
  - `job.status`
  - `runner` (`os`, `arch`, `temp`, `tool_cache`)
  - `vars` (set with `--var KEY=VALUE`)
  - `strategy` (`job-index`, `job-total`, `fail-fast`, `max-parallel`)
- **Syntax:**
  - `.`, `['key']` and `*` access
  - `'string'` (with `''` escapes), number, `true`/`false`/`null` literals
  - `! < <= > >= == != && ||`, with GitHub's loose typing. `a || 'default'` returns the value, not a boolean.
- **Functions:**
  - `contains`, `startsWith`, `endsWith`
  - `format`, `join`
  - `toJSON`, `fromJSON`
  - `hashFiles` (globs relative to the workspace, `!` excludes)
  - `success()`, `failure()`, `always()`, `cancelled()`

As on GitHub, an `if:` without a status function means `success() && (...)`. After a step fails, later steps are skipped unless their `if:` uses `always()` or `failure()`. A job whose `needs` didn't all succeed is skipped unless its `if:` uses one of them.

```yaml
steps:
  - id: build
    run: echo "status=ok" >> $GITHUB_OUTPUT
  - if: ${{ steps.build.outputs.status == 'ok' }}
    run: echo "Build succeeded"
```

### Job Dependencies (`needs:`)

Jobs declaring `needs:` are executed in dependency order (topological sort):

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [...]
  test:
    needs: build
    runs-on: ubuntu-latest
    steps: [...]
```

### Matrix Builds (`strategy.matrix`)

A job runs once per matrix combination (sequentially), with `matrix.*` and `strategy.*` in its context and the combination in its name, e.g. `test (node: 20, os: linux)`:

- Combinations are expanded as on GitHub: the product of the axes, minus `exclude` matches (on all of an entry's keys), then `include` entries merged into every combination whose original values they don't change, or added as new combinations.
- The matrix, or any axis, can be an expression, e.g. `matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}`.
- `fail-fast` (default `true`) skips the remaining combinations after a failure. Job-level `continue-on-error` (e.g. `${{ matrix.experimental }}`) lets a combination fail without failing the job, its dependents or the run.
- `max-parallel` is accepted but has no effect, since combinations run one after another.

### Reusable Workflows (`jobs.<id>.uses:`)

A job that calls a reusable workflow runs the called workflow's jobs (in their own `needs:` order) as part of the run:

- `uses: ./.github/workflows/x.yml` resolves against the repository root, like on GitHub; `uses: owner/repo/.github/workflows/x.yml@ref` is downloaded and cached like a remote action (see Remote Action Support).
- `with:` and `secrets:` are evaluated in the calling job's context (`inputs`, `needs`, `vars`, ...); inputs fall back to their `on.workflow_call.inputs` defaults. The called workflow only sees the secrets passed to it (plus `GITHUB_TOKEN`), or all of them with `secrets: inherit`.
- `on.workflow_call.outputs` (e.g. `value: ${{ jobs.build.outputs.version }}`) become the calling job's outputs, available as `needs.<id>.outputs.*`.
- A workflow that can't be found or fetched fails the calling job.
- `strategy.matrix` on a calling job runs the workflow once per combination (`matrix.*` is available in `with:`); `needs.<id>.outputs` holds the last combination's outputs, as on GitHub.

### Shells and `defaults.run`

`run:` scripts are written to a file and run the way GitHub's runner does. With no `shell:`, that's `bash --noprofile --norc -eo pipefail {0}`, or `sh -e {0}` when bash isn't installed, so a step fails at its first failing command, including inside a pipeline. `shell: bash|sh|python|pwsh|powershell|cmd` map to GitHub's templates. Custom templates such as `shell: perl {0}` work too. `defaults.run.shell` and `defaults.run.working-directory` apply at workflow and job level; step-level values win, and they don't apply inside composite actions.

### Step Outputs

Steps can write to `$GITHUB_OUTPUT` to expose values to later steps via `${{ steps.<id>.outputs.<name> }}`.

### File Commands and Workflow Commands

Every step (`run:`, JavaScript and Docker actions) gets its own `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_PATH`, `$GITHUB_STATE` and `$GITHUB_STEP_SUMMARY` files. Values written to `$GITHUB_ENV` and directories written to `$GITHUB_PATH` are available to all later steps in the job (`$GITHUB_ENV` values also appear in `${{ env.* }}`). What steps write to `$GITHUB_STEP_SUMMARY` is printed at the end of the job.

Workflow commands printed to stdout are interpreted, in both the `::cmd::` and legacy `##[cmd]` syntax: `::add-mask::`, `::set-output`, `::save-state`, `::warning::`, `::error::`, `::notice::`, `::debug::`, `::group::`/`::endgroup::` and `::stop-commands::<token>` (nothing is interpreted until `::<token>::`). Problem matchers (`::add-matcher::`, `::remove-matcher::`) and `::echo::` are hidden.

Composite actions don't get the `secrets` context, as on GitHub: pass secrets to them as inputs.

### Events and the `github` Context

```bash
secureci run .github/workflows/ci.yml --event-name pull_request --event-path event.json
```

- `github.event_name`: `--event-name`, else `$GITHUB_EVENT_NAME`, else `workflow_dispatch` if the workflow declares it, else the workflow's first trigger.
- `github.event`: the JSON object from `--event-path`, also written to `$GITHUB_EVENT_PATH`. Without it, `workflow_dispatch` gets `{ "inputs": {...} }` like on GitHub, and other events get `{}`.
- `github.repository` / `repository_owner`: `$GITHUB_REPOSITORY`, else the payload's `repository`, else parsed from the git `origin` remote, else the folder name. `github.sha` / `ref` come from `$GITHUB_SHA` / `$GITHUB_REF`, the payload's `ref`, or local git.
- `inputs.*`: `--input` values over the `default`s declared under `on.workflow_dispatch.inputs` / `on.workflow_call.inputs`.

### Default Environment Variables

Steps receive the runner's default variables, derived from the local `github` context: `CI`, `GITHUB_ACTIONS`, `GITHUB_WORKFLOW`, `GITHUB_JOB`, `GITHUB_SHA`, `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_EVENT_NAME`, `GITHUB_ACTOR`, `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`, `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`, `GITHUB_WORKSPACE`, `GITHUB_EVENT_PATH` (see above), `RUNNER_OS`, `RUNNER_TEMP` and `RUNNER_TOOL_CACHE` (`~/.secureci/toolcache`).

### Secret Masking

Any value passed via `--secret`, or registered by a step via `::add-mask::`, is automatically masked (`***`) wherever it appears in log output.

In container mode, env values (secrets included) never appear in the container client's command line: they're passed in a private env file (mode `0600`, deleted as soon as the client exits), or, for values an env file can't carry verbatim (multi-line, quote-leading or whitespace-padded), by name with the value in the client's environment. Prefer `--secret NAME` over `--secret NAME=value` so the value isn't in the `secureci` command line either.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build
npm run build

# Lint
npm run lint
```

Every pull request and push to `main` runs [`ci.yaml`](.github/workflows/ci.yaml): lint, `prettier --check`, tests with the coverage thresholds from `vitest.config.mts`, build, and the SecureCI CLI validating its own workflow. It uses the Node version from `volta.node` in `package.json`.

Opt-in test suites:

- `RUN_DOCKER_TESTS=1 npm test`: real-engine container tests (needs a running Docker daemon).
- `RUN_NETWORK_TESTS=1 npm test`: tests that fetch real actions from GitHub.

## Testing Strategy

This project follows TDD (Test-Driven Development):

1. Write tests first
2. Implement features to pass tests
3. Refactor while keeping tests green

## Architecture

```
src/
├── cli.ts                    # CLI entry point
├── parser/
│   ├── workflow-parser.ts    # Parse workflow YAML
│   ├── action-parser.ts      # Parse action YAML
│   └── validator.ts          # Validate syntax
├── runner/
│   ├── dry-run.ts            # Dry run mode
│   ├── executor.ts           # Execute jobs/steps, if:/needs:, outputs
│   ├── expression.ts         # ${{ ... }} expression evaluation
│   ├── container-runtime.ts  # Docker/Podman container isolation
│   └── action-fetcher.ts     # Fetch remote actions from GitHub
├── utils/
│   └── logger.ts             # Logging utility with secret masking
└── types/
    └── index.ts              # TypeScript types
```

## Remote Action Support

The SecureCI CLI supports fetching and executing remote GitHub Actions:

- **Composite Actions**: Full support for composite actions with multiple steps
- **JavaScript Actions** (node12, node16, node20, node22+): Runs `main` with the CLI's own Node.js binary, in the workspace, with `INPUT_*` (from `with:` or the input's `default`), `GITHUB_ACTION_PATH` and the file commands above. `pre:` runs right before `main` (GitHub runs it at job start); `post:` runs at the end of the job in reverse order, gated by `post-if` (default `always()`), with state from `$GITHUB_STATE` exposed as `STATE_*`.
- **Docker Actions** (action type `runs.using: docker`): Builds the action's Dockerfile (or pulls a `docker://...` image) and runs it in its own container. Note: this is distinct from the job container that `--container-runtime` starts for `run:` steps and JavaScript actions.
- **Local Actions** (`uses: ./path/to/action`): Resolved relative to the workspace (the current directory), using `action.yml` or `action.yaml`.
- **`docker://` steps** (`uses: docker://alpine:3.20`): Run the image directly, with `with.args` as its arguments and `with.entrypoint` as its entrypoint.
- **Unresolvable actions fail the step**: A remote action that can't be fetched, a missing local action, or an unsupported `runs.using` fails the step (as on GitHub) instead of being skipped.
- **Action Caching**: Downloaded repositories are cached in `~/.secureci/actions-cache/<owner>/<repo>/<commit-sha>`. A tag or branch (`@v4`, `@main`) is resolved to its current commit on every run (`git ls-remote`, or the API with a token), so moving refs pick up new commits, and an unchanged commit is never downloaded twice. If a ref can't be resolved (offline, rate-limited), the last commit cached for it is used, with a warning. `--offline` uses only the cache. `secureci cache path` / `secureci cache clear` show and empty it.
- **Private actions**: With a token, downloads go through the GitHub API, so actions in private and internal repositories work and rate limits are higher. The token is `$GITHUB_TOKEN`, else `$GH_TOKEN`, else `gh auth token`. It's only sent to GitHub (not to a host a download redirects to), never passed to actions, and masked in logs. If GitHub rejects it (e.g. expired), the run continues without it. `GITHUB_SERVER_URL` / `GITHUB_API_URL` point downloads at GitHub Enterprise Server.

### Example with Remote Actions

```bash
# Execute a workflow that uses remote actions
secureci run .github/workflows/ci.yml

# The workflow can include:
# - uses: actions/checkout@v3
# - uses: actions/setup-node@v3
# - uses: owner/repo/action@v1
```

## License

MIT
