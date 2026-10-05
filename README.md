# actly

A CLI tool to locally test GitHub Actions and workflows without pushing to remote.

## Features

- 🔍 Dry run mode for sanity checks
- 📝 Pass inputs and secrets via CLI
- 📐 Validate a caller workflow against a central pipeline contract (`--contract`)
- 🔄 Support for reusable workflows and actions
- ⛓️ Execute chained workflows and actions
- 🚦 `if:` conditional execution for jobs and steps (supports `env.*`, `inputs.*`, `secrets.*`, `steps.*.outputs.*`, `success()`, `failure()`, `always()`)
- 🔗 `needs:` job dependency ordering (topological sort)
- 📤 Step outputs via `$GITHUB_OUTPUT`, consumable by later steps/jobs
- 🔒 Automatic secret masking in all log output
- 📦 Optional container isolation for `run:` steps (Docker or Podman)
- 🚀 Fetch and run remote GitHub Actions (composite and JavaScript actions)
- 💾 Action caching for faster execution
- 🎯 Minimal dependencies, focused on MVP

## Installation

```bash
npm install -g actly
```

Or run locally:

```bash
npm install
npm run build
```

## Usage

```bash
# Dry run a workflow
actly --dry-run .github/workflows/ci.yml

# Execute a workflow
actly .github/workflows/build.yml --input key=value

# Run with secrets
actly .github/workflows/deploy.yml --secret TOKEN=xxx

# Validate workflow syntax
actly --validate .github/workflows/ci.yml

# Validate a caller workflow against a central pipeline contract
actly --contract contracts/platform-standard.yml .github/workflows/deploy.yml

# Run a specific job
actly .github/workflows/ci.yml --job build

# List workflows in .github/workflows/
actly --list

# Run with container isolation (Docker or Podman)
actly .github/workflows/ci.yml --container-runtime=auto
actly .github/workflows/ci.yml --container-runtime=docker --container-image=node:20-alpine
actly .github/workflows/ci.yml --container-runtime=podman --container-memory=512m --allow-network
```

### Container Isolation Flags

| Flag                         | Description                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--container-runtime <name>` | `auto`\|`docker`\|`podman`\|`containerd`\|`none` (default: `docker`, overridable via `~/.actly/config.yml`; use `none` for the old host-execution default) |
| `--container-image <image>`  | Image to run steps in (default: `ubuntu:22.04`)                                                                                                            |
| `--container-timeout <ms>`   | Per-step timeout in milliseconds                                                                                                                           |
| `--container-memory <limit>` | Memory limit, e.g. `512m`                                                                                                                                  |
| `--allow-network`            | Allow container network access (disabled by default)                                                                                                       |

`containerd` is driven via its Docker-CLI-compatible front-end, [`nerdctl`](https://github.com/containerd/nerdctl).

### Global Configuration

actly reads defaults from `~/.actly/config.yml` (created on first `actly config set`, or editable by hand). Config keys match the CLI flag names (kebab-case, minus the leading `--`). CLI flags always take precedence over the config file.

```bash
actly config set container-runtime podman   # persist a default
actly config get container-runtime
actly config list
actly config unset container-runtime        # revert to the built-in default (docker)
actly config path                           # print the config file location
```

Supported keys: `container-runtime`, `container-image`, `container-timeout`, `container-memory`, `allow-network`.

### Pipeline Contracts (`--contract`)

In organizations with a central repo of reusable workflows/actions, a platform team can define a minimum pipeline standard — required actions, forbidden actions, and (optionally) the order required actions must run in — and have actly check a caller's workflow against it.

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
actly --contract contracts/platform-standard.yml .github/workflows/deploy.yml
```

If the caller's workflow calls `org/deploy` before `org/security-scan` (or uses `org/legacy-deploy`, or omits a required action, or pins `org/security-scan` below `v1.2.0`), the command exits non-zero with a message like:

```
[INFO] Validating workflow...
[INFO] Validating against pipeline contract: contracts/platform-standard.yml
[ERROR] Validation failed:
[ERROR]   [ERROR] required[1]: Required action "org/deploy" must run after "org/security-scan", but it does not
```

- Only `uses:` steps declared directly in the given workflow file are considered — in whole-workflow order, resolving job order via `needs:` and then step order within each job. Steps inside a called reusable workflow or composite action are **not** resolved/recursed into.
- `ordering: relative` (default): required actions must appear in that relative order, with any other steps allowed in between. `ordering: strict`: required actions must run back-to-back, with no other step in between.
- A missing required action, a required action below `min-version`, an ordering violation, or any forbidden-action match is an **error** (validation fails). A required action whose version can't be compared (e.g. pinned to a branch or SHA) is a **warning**.
- `--contract` implies `--validate` and currently applies to workflow files only (not standalone actions, since the contract is about a job/step sequence). Passing `--contract` against an action file fails with a clear error.

**Known limitations (v1 scope):**

- **Jobs with no `needs:` relationship between them** (i.e. jobs GitHub Actions would run in parallel) are ordered by their declaration order in the YAML, since there's no real concurrency model here — this is an approximation for a static order check, not a simulation of actual parallel execution. If your contract's ordering spans two jobs that don't have a `needs:` edge between them, reordering those jobs in the YAML can change the validation result even though nothing semantically changed.
- **`strategy.matrix` jobs** are checked once against the job's `steps:` as authored, not once per expanded matrix combination — the contract is about pipeline _structure_, not the runtime values substituted into it.
- **Action references** are matched as exact strings against `uses:` (minus any `@version` suffix) — this covers the common `owner/repo` or `owner/repo/path` marketplace-action form, as well as local paths (`./.github/actions/foo`, matched with no version). `docker://image` references are matched as-is (the whole string, including `docker://`) and have no version-pin concept.
- Action references are matched **case-sensitively** and are not normalized (e.g. `Org/Action` won't match a contract entry for `org/action`).

## Workflow Features

### Conditional Execution (`if:`)

Jobs and steps support `if:` expressions referencing `env.*`, `inputs.*`, `secrets.*`, `steps.<id>.outputs.*`, and the functions `success()`, `failure()`, `always()`:

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

### Step Outputs

Steps can write to `$GITHUB_OUTPUT` to expose values to later steps via `${{ steps.<id>.outputs.<name> }}`.

### Secret Masking

Any value passed via `--secret` is automatically masked (`***`) wherever it appears in log output.

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

actly now supports fetching and executing remote GitHub Actions:

- **Composite Actions**: Full support for composite actions with multiple steps
- **JavaScript Actions** (node12, node16, node20, node22+): Executes JavaScript-based actions with Node.js
- **Docker Actions** (action type `runs.using: docker`): Builds the action's Dockerfile (or pulls a `docker://...` image) and runs it directly. Note: this is distinct from `--container-runtime`, which isolates `run:` steps in a container regardless of action type.
- **Action Caching**: Downloaded actions are cached in `~/.actly/actions-cache` for faster subsequent runs

### Example with Remote Actions

```bash
# Execute a workflow that uses remote actions
actly .github/workflows/ci.yml

# The workflow can include:
# - uses: actions/checkout@v3
# - uses: actions/setup-node@v3
# - uses: owner/repo/action@v1
```

## License

MIT
