# actly

A CLI tool to locally test GitHub Actions and workflows without pushing to remote.

## Features

- 🔍 Dry run mode for sanity checks
- 📝 Pass inputs and secrets via CLI
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
