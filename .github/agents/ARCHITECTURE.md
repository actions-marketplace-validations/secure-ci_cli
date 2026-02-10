# Architecture Guide for actly

This document provides a comprehensive overview of actly's architecture for AI agents and developers.

## System Overview

actly is a CLI tool that enables local testing of GitHub Actions and workflows. It parses YAML workflow/action definitions, validates them, and can execute them locally with support for inputs, secrets, and remote actions.

## High-Level Architecture

```mermaid
graph TB
    subgraph CLI["CLI Layer"]
        CLI1[cli.ts, index.ts]
        CLI2[Command-line interface<br/>using Commander.js]
        CLI3[Entry point for users]
    end

    subgraph Parser["Parser Layer"]
        P1[workflow-parser.ts<br/>action-parser.ts<br/>validator.ts]
        P2[Parse YAML workflow<br/>and action files]
        P3[Validate syntax<br/>and structure]
        P4[Convert YAML to<br/>internal data structures]
    end

    subgraph Runner["Runner Layer"]
        R1[dry-run.ts<br/>executor.ts<br/>action-fetcher.ts]
        R2[Execute workflows<br/>and actions]
        R3[Dry-run mode for<br/>sanity checks]
        R4[Fetch and cache<br/>remote actions from GitHub]
    end

    subgraph Utils["Utils Layer"]
        U1[logger.ts, etc.]
        U2[Logging utilities]
        U3[Helper functions]
        U4[Shared utilities]
    end

    CLI --> Parser
    Parser --> Runner
    Runner --> Utils
```

## Directory Structure

```
actly/
├── src/                          # Source code
│   ├── cli.ts                    # CLI entry point - Commander.js configuration
│   ├── index.ts                  # Main module exports
│   │
│   ├── parser/                   # Parsing and validation layer
│   │   ├── workflow-parser.ts    # Parse GitHub workflow YAML files
│   │   ├── workflow-parser.test.ts
│   │   ├── action-parser.ts      # Parse GitHub action YAML files (future)
│   │   ├── validator.ts          # Validate workflow/action structure
│   │   └── validator.test.ts
│   │
│   ├── runner/                   # Execution layer
│   │   ├── dry-run.ts            # Dry-run mode implementation
│   │   ├── dry-run.test.ts
│   │   ├── executor.ts           # Execute workflows and actions
│   │   ├── executor.test.ts
│   │   ├── action-fetcher.ts     # Fetch remote actions from GitHub
│   │   └── action-fetcher.test.ts
│   │
│   ├── utils/                    # Utility layer
│   │   ├── logger.ts             # Logging utility with chalk
│   │   ├── inputs.ts             # Handle workflow inputs (future)
│   │   └── secrets.ts            # Handle workflow secrets (future)
│   │
│   └── types/                    # Type definitions
│       └── index.ts              # Shared TypeScript interfaces and types
│
├── test/                         # Test fixtures
│   └── fixtures/                 # YAML fixtures for testing
│       ├── simple-workflow.yml
│       ├── invalid-workflow.yml
│       ├── simple-action.yml
│       └── invalid-action.yml
│
├── dist/                         # Compiled JavaScript (gitignored)
│   ├── cli.js                    # Compiled CLI
│   └── [other compiled files]
│
├── .github/                      # GitHub-specific files
│   ├── workflows/                # CI/CD workflows
│   └── agents/                   # AI agent guidance
│       ├── TESTING.md
│       ├── CODE_STYLE.md
│       └── ARCHITECTURE.md (this file)
│
├── node_modules/                 # Dependencies (gitignored)
├── coverage/                     # Test coverage reports (gitignored)
│
├── package.json                  # Node.js project configuration
├── tsconfig.json                 # TypeScript configuration
├── vitest.config.ts              # Vitest testing configuration
├── .eslintrc.js                  # ESLint configuration
├── .gitignore                    # Git ignore rules
├── AGENTS.md                     # Main AI agent guidance
└── README.md                     # User documentation
```

## Core Components

### 1. CLI Layer (`cli.ts`, `index.ts`)

**Purpose**: Provide command-line interface for users.

**Responsibilities**:

- Parse command-line arguments using Commander.js
- Display help and usage information
- Route commands to appropriate modules
- Handle CLI-specific error display

**Key Technologies**:

- `commander`: CLI framework
- `chalk`: Terminal styling

**Example Usage**:

```typescript
// cli.ts structure
import { Command } from 'commander';
import { validateWorkflow } from './parser/validator';

const program = new Command();

program
  .name('actly')
  .description('Test GitHub Actions locally')
  .argument('<workflow>', 'Path to workflow file')
  .option('--dry-run', 'Dry run mode')
  .option('--validate', 'Validate only')
  .action((workflow, options) => {
    // Route to appropriate handler
  });
```

### 2. Parser Layer

#### Workflow Parser (`parser/workflow-parser.ts`)

**Purpose**: Parse GitHub Actions workflow YAML files.

**Responsibilities**:

- Read YAML workflow files from filesystem
- Parse YAML into JavaScript objects
- Extract workflow metadata (name, triggers, jobs)
- Convert to internal Workflow type

**Key Functions**:

```typescript
function parseWorkflow(workflowPath: string): Workflow;
function parseWorkflowContent(content: string): Workflow;
```

#### Action Parser (`parser/action-parser.ts`)

**Purpose**: Parse GitHub Actions action YAML files (action.yml/action.yaml).

**Responsibilities**:

- Parse action metadata (name, description, inputs, outputs)
- Handle composite, JavaScript, and Docker action types
- Extract action configuration

**Key Functions**:

```typescript
function parseAction(actionPath: string): Action;
```

#### Validator (`parser/validator.ts`)

**Purpose**: Validate workflow and action structure.

**Responsibilities**:

- Validate required fields are present
- Check for valid job structure
- Validate step definitions
- Return validation result with errors

**Key Functions**:

```typescript
function validateWorkflow(workflowPath: string): ValidationResult;
function validateAction(actionPath: string): ValidationResult;

interface ValidationResult {
  valid: boolean;
  errors: string[];
}
```

### 3. Runner Layer

#### Dry Run (`runner/dry-run.ts`)

**Purpose**: Simulate workflow execution without running commands.

**Responsibilities**:

- Parse workflow structure
- Display what would be executed
- Validate workflow can be executed
- Show inputs, secrets, and steps

**Use Case**: Sanity checking workflows before execution.

#### Executor (`runner/executor.ts`)

**Purpose**: Execute workflows and actions locally.

**Responsibilities**:

- Execute workflow jobs and steps sequentially
- Handle inputs and secrets
- Run shell commands and scripts
- Execute remote actions (via action-fetcher)
- Report execution status and results

**Key Functions**:

```typescript
async function executeWorkflow(
  workflow: Workflow,
  options: ExecutionOptions
): Promise<ExecutionResult>;
```

#### Action Fetcher (`runner/action-fetcher.ts`)

**Purpose**: Fetch and cache remote GitHub Actions.

**Responsibilities**:

- Parse action references (e.g., `actions/checkout@v3`)
- Download actions from GitHub
- Cache actions locally in `~/.actly/actions-cache`
- Support composite, JavaScript, and Docker actions
- Handle versioning (tags, branches, commit SHAs)

**Key Features**:

- **Caching**: Actions cached by owner/repo@ref for performance
- **Version Support**: Tags (v1, v3), branches (main), SHAs (abc123)
- **Action Types**:
  - Composite: YAML-defined multi-step actions
  - JavaScript: node12, node16, node20, node22+ actions
  - Docker: Shows warning (future support)

**Key Functions**:

```typescript
async function fetchAction(actionRef: string): Promise<ActionMetadata>;
function getCachedAction(actionRef: string): ActionMetadata | null;
```

### 4. Utils Layer

#### Logger (`utils/logger.ts`)

**Purpose**: Centralized logging with styling.

**Responsibilities**:

- Provide consistent log formatting
- Support different log levels (info, warn, error, success)
- Use chalk for colored output

**Example Usage**:

```typescript
import { logger } from '../utils/logger';

logger.info('Starting workflow execution');
logger.success('✓ Workflow completed successfully');
logger.warn('⚠ Action not found in cache');
logger.error('✗ Execution failed', error);
```

### 5. Types Layer (`types/index.ts`)

**Purpose**: Central type definitions for the entire project.

**Key Types**:

```typescript
// Workflow Types
interface Workflow {
  name: string;
  on: string | string[] | TriggerConfig;
  jobs: Record<string, Job>;
  env?: Record<string, string>;
}

interface Job {
  name?: string;
  'runs-on': string;
  steps: Step[];
  needs?: string | string[];
  if?: string;
  env?: Record<string, string>;
}

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
  if?: string;
}

// Action Types
interface Action {
  name: string;
  description?: string;
  inputs?: Record<string, ActionInput>;
  outputs?: Record<string, ActionOutput>;
  runs: ActionRuns;
}

interface ActionRuns {
  using: 'composite' | 'node12' | 'node16' | 'node20' | 'docker';
  steps?: Step[]; // For composite actions
  main?: string; // For JavaScript actions
  image?: string; // For Docker actions
}

// Execution Types
interface ExecutionOptions {
  dryRun: boolean;
  inputs: Record<string, string>;
  secrets: Record<string, string>;
}

interface ExecutionResult {
  success: boolean;
  steps: StepResult[];
  error?: string;
}
```

## Data Flow

> **Note for AI Agents**: Use Mermaid diagrams for flow visualizations. They are clearer, maintainable, and render in GitHub/IDEs.

### Workflow Validation Flow

```mermaid
graph TD
    A[User Command] --> B[CLI Parser<br/>cli.ts]
    B --> C[Validator<br/>validator.ts]
    C --> D[Read YAML file<br/>fs.readFileSync]
    D --> E[Parse YAML<br/>YAML.parse]
    E --> F[Validate structure]
    F --> G[Check required fields]
    F --> H[Validate job structure]
    F --> I[Validate step definitions]
    G --> J[Return ValidationResult]
    H --> J
    I --> J
    J --> K[Display to User<br/>CLI]
```

### Workflow Execution Flow

```mermaid
graph TD
    A[User Command] --> B[CLI Parser<br/>cli.ts]
    B --> C[Workflow Parser<br/>workflow-parser.ts]
    C --> D[Read YAML file]
    C --> E[Parse to Workflow type]
    D --> F[Executor<br/>executor.ts]
    E --> F
    F --> G{For each job}
    G --> H{For each step}
    H --> I{Step type?}
    I -->|step.run| J[Execute shell command]
    I -->|step.uses| K[Action Fetcher<br/>action-fetcher.ts]
    K --> L{Cached?}
    L -->|No| M[Fetch from GitHub]
    M --> N[Cache locally]
    L -->|Yes| O[Parse action.yml]
    N --> O
    O --> P{Action type?}
    P -->|Composite| Q[Execute steps recursively]
    P -->|JavaScript| R[Run with Node.js]
    P -->|Docker| S[Show warning]
    Q --> T[Return result]
    R --> T
    S --> T
    J --> U[Collect step results]
    T --> U
    U --> V{More steps?}
    V -->|Yes| H
    V -->|No| W{More jobs?}
    W -->|Yes| G
    W -->|No| X[Return ExecutionResult]
    X --> Y[Display Results<br/>CLI]
```

## Design Patterns

### 1. Separation of Concerns

Each layer has distinct responsibilities:

- **CLI**: User interaction only
- **Parser**: Data transformation only
- **Runner**: Execution logic only
- **Utils**: Shared utilities only

### 2. Dependency Injection

Pass dependencies explicitly rather than using globals:

```typescript
// Good
function executeWorkflow(workflow: Workflow, logger: Logger): Result {
  logger.info('Executing workflow');
  // ...
}

// Avoid
function executeWorkflow(workflow: Workflow): Result {
  globalLogger.info('Executing workflow');
  // ...
}
```

### 3. Error Handling Strategy

- **Parse errors**: Caught and returned as ValidationResult
- **Execution errors**: Caught and returned as ExecutionResult with error details
- **Fatal errors**: Thrown and caught at CLI layer for user display

```typescript
try {
  const result = await executeWorkflow(workflow, options);
  if (!result.success) {
    logger.error('Execution failed', result.error);
  }
} catch (error) {
  logger.error('Fatal error', error);
  process.exit(1);
}
```

### 4. Type Safety

Use TypeScript's type system extensively:

- All public functions have explicit return types
- Use interfaces for data structures
- Avoid `any` type (use `unknown` if needed)
- Leverage union types for variants

### 5. Async/Await Pattern

Prefer async/await over raw promises for cleaner code:

```typescript
async function fetchAction(ref: string): Promise<Action> {
  const cached = getCachedAction(ref);
  if (cached) return cached;

  const action = await downloadAction(ref);
  await cacheAction(ref, action);
  return action;
}
```

## Extension Points

### Adding New Features

#### 1. New CLI Command

1. Add command definition in `cli.ts`
2. Create handler function
3. Route to appropriate module

#### 2. New Validation Rule

1. Add validation logic in `validator.ts`
2. Add test cases in `validator.test.ts`
3. Update ValidationResult if needed

#### 3. New Action Type Support

1. Update `ActionRuns` type in `types/index.ts`
2. Add handling in `action-fetcher.ts`
3. Add execution logic in `executor.ts`
4. Add tests with fixtures

#### 4. New Workflow Feature

1. Update `Workflow` type in `types/index.ts`
2. Update parser in `workflow-parser.ts`
3. Add validation in `validator.ts`
4. Update executor if needed

## Performance Considerations

### Caching Strategy

- **Action Cache**: `~/.actly/actions-cache/owner/repo@ref`
- Cache hit: Instant load
- Cache miss: Download from GitHub (one-time cost)

### Optimization Opportunities

1. **Parallel Job Execution**: Currently sequential, could be parallelized
2. **Incremental Parsing**: Parse only required sections
3. **Lazy Loading**: Load remote actions only when needed
4. **Cache Invalidation**: Smart cache expiration strategy

## Security Considerations

### Secrets Handling

- Secrets should never be logged
- Secrets should be masked in output
- Secrets stored securely (environment variables or secure input)

### Remote Action Execution

- Verify action source before execution
- Sandboxing for action execution (future enhancement)
- Limit permissions for executed actions

### File System Access

- Validate file paths to prevent directory traversal
- Restrict write access to cache directory
- Handle symbolic links carefully

## Testing Strategy

### Unit Tests

Test individual functions in isolation:

- Parser functions with YAML fixtures
- Validator logic with valid/invalid inputs
- Utility functions

### Integration Tests

Test interactions between modules:

- Full workflow parsing and validation
- Action fetching and execution
- End-to-end CLI commands (future)

### Fixtures

Use realistic YAML files in `test/fixtures/`:

- Simple valid workflows
- Complex workflows with multiple jobs
- Invalid workflows for error testing
- Various action types

See [TESTING.md](./TESTING.md) for comprehensive testing guidelines.

## Future Architecture Enhancements

### Planned Improvements

1. **Plugin System**: Allow custom action types
2. **Workflow Templates**: Reusable workflow patterns
3. **Remote Workflow Support**: Fetch workflows from GitHub
4. **Parallel Execution**: Run independent jobs in parallel
5. **Docker Support**: Full Docker action support
6. **Workflow Visualization**: Generate workflow diagrams
7. **Interactive Mode**: Step-by-step execution with breakpoints

### Scalability Considerations

- **Large Workflows**: Stream processing for very large workflows
- **Many Actions**: Efficient caching and parallel fetching
- **Long-Running Jobs**: Progress reporting and cancellation

## Contributing Guidelines

When modifying the architecture:

1. **Maintain Separation**: Keep layers distinct
2. **Type Safety**: Add/update types in `types/index.ts`
3. **Test Coverage**: Maintain >80% coverage
4. **Documentation**: Update this document for architectural changes
5. **Backward Compatibility**: Consider existing users

## Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [YAML Specification](https://yaml.org/spec/)
- [TypeScript Best Practices](https://www.typescriptlang.org/docs/handbook/declaration-files/do-s-and-don-ts.html)
- [Node.js Best Practices](https://github.com/goldbergyoni/nodebestpractices)

## Summary for AI Agents

Key architectural principles:

- **Layered Architecture**: CLI → Parser → Runner → Utils
- **Separation of Concerns**: Each module has a single responsibility
- **Type Safety**: Extensive use of TypeScript types
- **TDD**: Tests drive implementation
- **Caching**: Local cache for remote actions
- **Error Handling**: Graceful error handling at all layers
- **Extensibility**: Easy to add new features within existing structure
