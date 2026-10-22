# Domain Concepts for SecureCI

This document explains GitHub Actions concepts relevant to understanding SecureCI.

## Workflows

Workflows are automated processes defined in YAML files (typically `.github/workflows/*.yml`).

**Key characteristics:**

- Contain one or more jobs
- Each job contains steps
- Triggered by events (push, pull_request, schedule, etc.)
- Can accept inputs and use secrets
- Can call other workflows (reusable workflows)

**Example structure:**

```yaml
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm test
```

## Actions

Actions are reusable units of work that can be used in workflow steps.

### Three Types of Actions

#### 1. Composite Actions

Multiple steps defined in YAML (`action.yml`).

**Characteristics:**

- Defined with `runs.using: 'composite'`
- Can contain multiple steps
- Each step can use shell commands or other actions

**Example:**

```yaml
name: My Action
runs:
  using: composite
  steps:
    - run: echo "Step 1"
      shell: bash
    - run: echo "Step 2"
      shell: bash
```

#### 2. JavaScript Actions

Node.js-based actions that run JavaScript code.

**Characteristics:**

- Defined with `runs.using: 'node12'`, `'node16'`, `'node20'`, or `'node22'`
- Entry point specified in `runs.main`
- Can use Node.js APIs and npm packages
- Faster than Docker actions

**Support in SecureCI:** Full support for all Node.js versions.

#### 3. Docker Actions

Actions that run in Docker containers.

**Characteristics:**

- Defined with `runs.using: 'docker'`
- Requires Docker image or Dockerfile
- Provides isolated environment
- Slower startup time

**Support in SecureCI:** Supported — the CLI builds the action's Dockerfile (or pulls a `docker://` image) and runs it in its own container. This is distinct from the CLI's `--container-runtime` flag, which isolates `run:` steps and JavaScript actions in the job container regardless of action type (see [Container Isolation](#container-isolation) below).

## Remote Actions

Actions referenced from GitHub repositories.

**Reference format:**

```
owner/repo@ref
owner/repo/path@ref
```

**Examples:**

- `actions/checkout@v3` - Specific tag (v3)
- `actions/setup-node@main` - Branch name (main)
- `owner/repo@abc123` - Commit SHA (abc123)
- `owner/repo/subdirectory@v1` - Action in subdirectory

### Action Caching

SecureCI caches downloaded actions for performance:

- **Cache location:** `~/.secureci/actions-cache/`
- **Cache key:** `owner/repo@ref`
- **Cache hit:** Instant load from local filesystem
- **Cache miss:** Download from GitHub, then cache

### Action Discovery

When SecureCI encounters a `uses` step:

1. Parse the action reference
2. Check local cache
3. If not cached, fetch from GitHub
4. Parse `action.yml` or `action.yaml`
5. Execute based on action type

## Inputs and Secrets

### Inputs

Key-value pairs passed to workflows or actions.

**In CLI:**

```bash
secureci run workflow.yml --input KEY=value --input ANOTHER=value
```

**In workflow YAML:**

```yaml
on:
  workflow_dispatch:
    inputs:
      environment:
        description: 'Target environment'
        required: true
        default: 'staging'
```

### Secrets

Sensitive values (API keys, tokens, passwords).

**In CLI:**

```bash
secureci run workflow.yml --secret TOKEN=xxx --secret API_KEY=yyy
```

**In workflow YAML:**

```yaml
steps:
  - run: echo "Token is ${{ secrets.GITHUB_TOKEN }}"
```

## Jobs and Steps

### Jobs

Jobs are collections of steps that run on the same runner.

**Key properties:**

- `runs-on`: Specifies runner environment (e.g., `ubuntu-latest`)
- `needs`: Specifies job dependencies — SecureCI orders jobs via topological sort (Kahn's algorithm) so dependent jobs always run after the jobs they depend on
- `if`: Conditional execution (`${{ ... }}` expression; see below). A job whose `if:` evaluates falsy is skipped entirely
- `steps`: Array of steps to execute

### Steps

Steps are individual tasks within a job.

**Two types:**

1. **Run steps:** Execute shell commands

   ```yaml
   - run: npm install
   - run: npm test
   ```

2. **Action steps:** Use actions

   ```yaml
   - uses: actions/checkout@v3
   - uses: actions/setup-node@v3
     with:
       node-version: '20'
   ```

**Additional step properties supported by SecureCI:**

- `id`: Names the step so its outputs can be referenced as `steps.<id>.outputs.<name>`
- `if`: Conditional execution; a falsy step is skipped (marked `outcome: 'skipped'`)

## Conditional Execution (`if:`)

Jobs and steps can be conditionally skipped using `${{ ... }}` expressions, evaluated by the CLI's expression engine (`src/runner/expression.ts`).

**Supported references:**

- `env.<NAME>` — environment variables
- `inputs.<name>` — workflow/action inputs
- `secrets.<NAME>` — secret values
- `steps.<id>.outputs.<name>` — outputs from a previous step
- `success()`, `failure()`, `always()` — outcome-based functions
- Comparison/logical operators: `==`, `!=`, `&&`, `||`

**Example:**

```yaml
steps:
  - id: build
    run: echo "status=ok" >> $GITHUB_OUTPUT
  - if: ${{ steps.build.outputs.status == 'ok' }}
    run: echo "Build succeeded"
```

## Step Outputs (`$GITHUB_OUTPUT`)

A step can write `name=value` pairs (or multiline `name<<EOF ... EOF` blocks) to the file path in the `$GITHUB_OUTPUT` environment variable. SecureCI injects a temporary file for this on every step and parses it afterward into `StepResult.outputs`, making the values available to later steps/jobs via `${{ steps.<id>.outputs.<name> }}`.

```yaml
- id: version
  run: echo "value=1.2.3" >> $GITHUB_OUTPUT
- if: ${{ steps.version.outputs.value == '1.2.3' }}
  run: echo "Matched expected version"
```

## Secret Masking

Any value passed via `--secret KEY=value` is registered with the CLI's `Logger` and automatically masked (replaced with `***`) wherever it would otherwise appear in console output — including stdout/stderr captured from shell commands.

## Container Isolation

`run:` steps and JavaScript actions run inside one container per job by default, via `src/runner/container-runtime.ts`, rather than directly on the host.

- **Default on**: `--container-runtime` defaults to `docker` (`auto|docker|podman|containerd|host`). If the runtime is unavailable the run **stops** — there is no silent host fallback; running on the host is the explicit `--container-runtime host` opt-in.
- **`auto`**: Tries Docker, then Podman, then containerd (via nerdctl).
- **Isolation options**: `--container-image`, `--container-memory`, `--container-timeout`, and `--no-network` (networking is on by default, like GitHub-hosted runners).
- **Output exchange**: The working directory and a `$GITHUB_OUTPUT` exchange directory are bind-mounted into the container so outputs and conditionals work identically to host execution.

## Execution Model

SecureCI executes workflows locally:

1. Parse workflow YAML
2. Validate structure
3. Order jobs by `needs:` (topological sort)
4. For each job in order:
   - Skip the job if its `if:` expression evaluates falsy
   - For each step:
     - Skip the step if its `if:` expression evaluates falsy
     - If `run`: Execute shell command (optionally inside a container) and capture `$GITHUB_OUTPUT`
     - If `uses`: Fetch action, then execute
5. Mask any registered secrets across all log output
6. Report results

## Key Differences from GitHub Actions

When running locally with SecureCI:

- **Runner images:** Jobs run in a container image mapped from `runs-on` (not the exact GitHub-hosted runner image); `windows-*`/`macos-*` fall back to a Linux image with a warning
- **No GitHub context:** Limited access to GitHub API
- **Parallel job execution:** Jobs whose `needs:` are done, and matrix combinations, run concurrently up to `--parallel` (default: CPU count); they share the local working copy
- **Local caching:** Actions cached locally instead of GitHub servers
- **Limited secrets:** Secrets passed via CLI (not GitHub Secrets), masked in log output

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [Action metadata syntax](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions)
