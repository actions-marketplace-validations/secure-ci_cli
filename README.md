# actly

A CLI tool to locally test GitHub Actions and workflows without pushing to remote.

## Features

- 🔍 Dry run mode for sanity checks
- 📝 Pass inputs and secrets via CLI
- 🔄 Support for reusable workflows and actions
- ⛓️ Execute chained workflows and actions
- 🚀 **NEW**: Fetch and run remote GitHub Actions (composite and JavaScript actions)
- 💾 Action caching for faster execution
- 🎯 Minimal dependencies, focused on MVP

## Installation

```bash
npm install -g @jabraf/actly
```

Or run locally:

```bash
cd research-development/actly
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
```

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
│   ├── executor.ts           # Execute steps and remote actions
│   └── action-fetcher.ts     # Fetch remote actions from GitHub
├── utils/
│   ├── inputs.ts             # Handle inputs
│   ├── secrets.ts            # Handle secrets
│   └── logger.ts             # Logging utility
└── types/
    └── index.ts              # TypeScript types
```

## Remote Action Support

actly now supports fetching and executing remote GitHub Actions:

- **Composite Actions**: Full support for composite actions with multiple steps
- **JavaScript Actions** (node12, node16, node20, node22+): Executes JavaScript-based actions with Node.js
- **Docker Actions**: Currently shows a warning (future enhancement)
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

ISC
