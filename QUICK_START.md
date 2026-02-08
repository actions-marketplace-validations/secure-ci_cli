# Quick Start Guide

This guide will help you get started with `actly` quickly.

## Installation

```bash
cd actly
npm install
npm run build
```

## Basic Usage

### 1. Validate a Workflow

Check if your workflow YAML is syntactically correct:

```bash
node dist/cli.js --validate .github/workflows/ci.yml
```

### 2. Dry Run a Workflow

See what would be executed without actually running anything:

```bash
node dist/cli.js --dry-run .github/workflows/ci.yml
```

Output example:

```
[INFO] Workflow: Simple CI Workflow
[INFO] Trigger: {"push":{"branches":["main"]}}

→ Job: test (test)
[INFO]   Runs on: ubuntu-latest
[INFO]   Step 1: Checkout code uses: actions/checkout@v3
[INFO]   Step 2: Setup Node.js uses: actions/setup-node@v3
[INFO]   Step 3: Install dependencies run: npm install
[INFO]   Step 4: Run tests run: npm test
✓ Dry run completed successfully
```

### 3. Dry Run an Action

Test a composite action:

```bash
node dist/cli.js --dry-run action.yml
```

### 4. List Available Workflows

List all workflows in your repository:

```bash
node dist/cli.js --list
```

### 5. Pass Inputs (Coming Soon)

```bash
node dist/cli.js workflow.yml --input key1=value1 --input key2=value2
```

### 6. Pass Secrets (Coming Soon)

```bash
node dist/cli.js workflow.yml --secret TOKEN=xxx --secret API_KEY=yyy
```

## Examples

### Example 1: Validate Before Commit

```bash
# Validate all workflows before committing
for file in .github/workflows/*.yml; do
  node actly/dist/cli.js --validate "$file"
done
```

### Example 2: Quick Check

```bash
# Quick dry-run to see what a workflow does
node actly/dist/cli.js --dry-run .github/workflows/ci.yml
```

### Example 3: Test Composite Action

Create a simple action:

```yaml
# action.yml
name: Hello Action
description: Says hello
inputs:
  name:
    description: Who to greet
    required: true
runs:
  using: composite
  steps:
    - run: echo "Hello ${{ inputs.name }}"
      shell: bash
```

Test it:

```bash
node actly/dist/cli.js --dry-run action.yml
```

## Features

### ✅ Implemented (MVP)

- ✅ Parse workflow YAML files
- ✅ Parse action YAML files
- ✅ Validate workflow syntax
- ✅ Validate action syntax
- ✅ Dry run mode for workflows
- ✅ Dry run mode for actions
- ✅ Support for reusable workflows
- ✅ CLI with multiple options
- ✅ Colored output
- ✅ List available workflows

### 🚧 Coming Soon

- 🚧 Execute simple run commands
- 🚧 Handle inputs and secrets
- 🚧 Support for composite actions
- 🚧 Execute chained workflows

## Tips

1. **Always validate first**: Use `--validate` to catch syntax errors before dry-run or execution.

2. **Use verbose mode**: Add `--verbose` flag for detailed logging during debugging.

3. **Test locally**: Always dry-run your workflows locally before pushing to GitHub.

## Troubleshooting

### Issue: File not found

Make sure you're in the correct directory or provide the full path to the workflow file.

### Issue: Validation failed

Check the error messages for specific issues with your YAML syntax.

### Issue: Cannot find module

Make sure you've run `npm install` and `npm run build` in the `actly` directory.

## Next Steps

- Read the full [README.md](README.md) for detailed documentation
- Run tests with `npm test`
- Explore the test fixtures in `test/fixtures/` for examples
