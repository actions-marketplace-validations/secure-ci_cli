# Domain Concepts for actly

This document explains GitHub Actions concepts relevant to understanding actly.

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

**Support in actly:** Full support for all Node.js versions.

#### 3. Docker Actions

Actions that run in Docker containers.

**Characteristics:**

- Defined with `runs.using: 'docker'`
- Requires Docker image or Dockerfile
- Provides isolated environment
- Slower startup time

**Support in actly:** Currently shows warning (future enhancement planned).

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

actly caches downloaded actions for performance:

- **Cache location:** `~/.actly/actions-cache/`
- **Cache key:** `owner/repo@ref`
- **Cache hit:** Instant load from local filesystem
- **Cache miss:** Download from GitHub, then cache

### Action Discovery

When actly encounters a `uses` step:

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
actly workflow.yml --input KEY=value --input ANOTHER=value
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
actly workflow.yml --secret TOKEN=xxx --secret API_KEY=yyy
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
- `needs`: Specifies job dependencies
- `if`: Conditional execution
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

## Execution Model

actly executes workflows locally:

1. Parse workflow YAML
2. Validate structure
3. For each job (currently sequential):
   - For each step:
     - If `run`: Execute shell command
     - If `uses`: Fetch action, then execute
4. Report results

## Key Differences from GitHub Actions

When running locally with actly:

- **No runner images:** Runs on your local machine
- **No GitHub context:** Limited access to GitHub API
- **Sequential execution:** Jobs run one at a time (not in parallel)
- **Local caching:** Actions cached locally instead of GitHub servers
- **Limited secrets:** Secrets passed via CLI (not GitHub Secrets)

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Workflow syntax](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)
- [Action metadata syntax](https://docs.github.com/en/actions/creating-actions/metadata-syntax-for-github-actions)
