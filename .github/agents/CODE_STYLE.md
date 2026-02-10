# Code Style and Formatting Guidelines for actly

This document outlines code styling and formatting conventions for the actly codebase.

## Overview

actly uses automated tools to maintain consistent code style:

- **ESLint**: For code quality and style enforcement
- **Prettier**: For automatic code formatting
- **TypeScript**: For type safety with strict mode enabled

## Quick Reference

```bash
npm run lint          # Check for style issues
npm run format        # Auto-format all files
npm run build         # Verify TypeScript compilation
```

## TypeScript Configuration

### Compiler Options (tsconfig.json)

```json
{
  "compilerOptions": {
    "target": "ES2020", // Modern JavaScript features
    "module": "commonjs", // Node.js module system
    "lib": ["ES2020"], // Standard library
    "strict": true, // Strict type checking
    "esModuleInterop": true, // CommonJS/ES modules compatibility
    "skipLibCheck": true, // Skip type checking of declaration files
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true, // Import JSON files
    "declaration": true, // Generate .d.ts files
    "declarationMap": true, // Generate declaration source maps
    "sourceMap": true, // Generate source maps
    "moduleResolution": "node", // Node.js module resolution
    "outDir": "./dist", // Output directory
    "rootDir": "./src" // Source root directory
  }
}
```

### Key Principles

1. **Strict Mode**: Always enabled - no implicit `any`, strict null checks, etc.
2. **Type Safety**: Explicit types preferred over inference when it improves clarity
3. **No `any` Types**: Avoid using `any`; use `unknown` or specific types instead

## ESLint Configuration

### Rules (.eslintrc.js)

```javascript
module.exports = {
  parser: '@typescript-eslint/parser',
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module'
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/explicit-module-boundary-types': 'off'
  }
};
```

### Key Rules

- **no-explicit-any**: Warns when using `any` type (should be avoided)
- **explicit-module-boundary-types**: Off (inferred return types are acceptable)
- All recommended TypeScript ESLint rules are enabled

## Prettier Configuration

Uses `@jabraf/prettier` configuration for consistent formatting.

### Formatting Rules

- **Indentation**: 2 spaces (no tabs)
- **Line Width**: 80 characters (soft limit)
- **Quotes**: Single quotes for strings
- **Semicolons**: Always include
- **Trailing Commas**: ES5 style (objects, arrays)
- **Arrow Functions**: Always use parentheses around parameters

### Running Prettier

```bash
# Format all files
npm run format

# Check formatting without changing files
npx prettier --check .
```

## Code Style Guidelines

### File Structure

#### Standard File Layout

```typescript
// 1. Imports
import * as fs from 'fs';
import * as path from 'path';
import { ExternalType } from 'external-package';

// 2. Type Definitions
interface WorkflowConfig {
  name: string;
  on: string | string[];
  jobs: Record<string, Job>;
}

// 3. Constants
const DEFAULT_RUNNER = 'ubuntu-latest';

// 4. Functions/Classes
export function parseWorkflow(filePath: string): WorkflowConfig {
  // Implementation
}

// 5. Exports (if not inline)
export { parseWorkflow };
```

### Naming Conventions

#### Files and Directories

- **Source files**: `kebab-case.ts` (e.g., `workflow-parser.ts`)
- **Test files**: `kebab-case.test.ts` (e.g., `workflow-parser.test.ts`)
- **Type files**: `kebab-case.ts` or `index.ts` (e.g., `types/index.ts`)
- **Directories**: `kebab-case` (e.g., `parser/`, `runner/`)

#### TypeScript Identifiers

```typescript
// Classes: PascalCase
class WorkflowParser {
  // Private properties: camelCase with _ prefix (optional)
  private _config: Config;

  // Public properties: camelCase
  public workflowPath: string;

  // Methods: camelCase
  public parseWorkflow(): Workflow {
    return this.internalParse();
  }

  private internalParse(): Workflow {
    // Implementation
  }
}

// Interfaces: PascalCase
interface WorkflowConfig {
  name: string;
}

// Type Aliases: PascalCase
type WorkflowStatus = 'success' | 'failure' | 'pending';

// Functions: camelCase
function validateWorkflow(path: string): boolean {
  return true;
}

// Variables: camelCase
const workflowPath = './workflow.yml';
let isValid = false;

// Constants: UPPER_SNAKE_CASE or camelCase (prefer UPPER_SNAKE_CASE for true constants)
const MAX_RETRIES = 3;
const API_BASE_URL = 'https://api.github.com';

// Enums: PascalCase for enum, UPPER_CASE for values
enum ActionType {
  COMPOSITE = 'COMPOSITE',
  JAVASCRIPT = 'JAVASCRIPT',
  DOCKER = 'DOCKER'
}
```

### Type Definitions

#### Prefer Interfaces for Objects

```typescript
// ✅ Good
interface Workflow {
  name: string;
  jobs: Record<string, Job>;
}

// ❌ Avoid (use interface instead)
type Workflow = {
  name: string;
  jobs: Record<string, Job>;
};
```

#### Use Type Aliases for Unions and Primitives

```typescript
// ✅ Good
type Status = 'success' | 'failure' | 'pending';
type Nullable<T> = T | null;

// ✅ Good
type WorkflowInput = string | number | boolean;
```

#### Explicit Return Types for Public Functions

```typescript
// ✅ Good - explicit return type
export function parseWorkflow(path: string): Workflow {
  // Implementation
}

// ❌ Acceptable for internal/private functions
function internalHelper(data: string) {
  return data.trim(); // Inferred: string
}
```

### Function Style

#### Prefer Named Functions for Exports

```typescript
// ✅ Good
export function validateWorkflow(path: string): ValidationResult {
  // Implementation
}

// ❌ Avoid
export const validateWorkflow = (path: string): ValidationResult => {
  // Implementation
};
```

#### Arrow Functions for Callbacks and Short Functions

```typescript
// ✅ Good - arrow functions for callbacks
const results = workflows.map((w) => w.name);
items.forEach((item) => console.log(item));

// ✅ Good - arrow functions for short inline functions
const double = (n: number) => n * 2;
```

### Error Handling

#### Use Descriptive Error Messages

```typescript
// ✅ Good
throw new Error(`Workflow file not found: ${workflowPath}`);

// ❌ Bad
throw new Error('Error');
```

#### Use Try-Catch for Async Operations

```typescript
// ✅ Good
async function fetchAction(ref: string): Promise<Action> {
  try {
    const response = await fetch(url);
    return await response.json();
  } catch (error) {
    throw new Error(`Failed to fetch action ${ref}: ${error.message}`);
  }
}
```

### Imports

#### Import Organization

```typescript
// 1. Node.js built-in modules
import * as fs from 'fs';
import * as path from 'path';

// 2. External packages
import * as YAML from 'yaml';
import chalk from 'chalk';

// 3. Internal modules (absolute imports from src/)
import { Workflow } from '../types';
import { logger } from '../utils/logger';
```

#### Prefer Named Imports

```typescript
// ✅ Good
import { validateWorkflow, parseWorkflow } from './parser';

// ❌ Avoid default exports unless necessary
import parser from './parser';
```

### Comments

#### Use Comments Sparingly

Code should be self-documenting. Use comments only when necessary.

```typescript
// ✅ Good - comment explains WHY, not WHAT
// GitHub API requires user agent header to avoid rate limiting
headers['User-Agent'] = 'actly';

// ❌ Bad - comment states the obvious
// Set the user agent
headers['User-Agent'] = 'actly';
```

#### JSDoc for Public APIs

```typescript
/**
 * Validates a GitHub Actions workflow file
 * @param workflowPath - Path to the workflow YAML file
 * @returns Validation result with errors if any
 */
export function validateWorkflow(workflowPath: string): ValidationResult {
  // Implementation
}
```

#### TODO Comments

Use TODO comments with context:

```typescript
// TODO(username): Add support for Docker actions
// TODO: Implement caching for remote actions (Issue #123)
```

### Async/Await

#### Prefer Async/Await Over Promises

```typescript
// ✅ Good
async function loadWorkflow(path: string): Promise<Workflow> {
  const content = await fs.promises.readFile(path, 'utf-8');
  return YAML.parse(content);
}

// ❌ Avoid (unless necessary)
function loadWorkflow(path: string): Promise<Workflow> {
  return fs.promises
    .readFile(path, 'utf-8')
    .then((content) => YAML.parse(content));
}
```

### Object and Array Operations

#### Use Destructuring

```typescript
// ✅ Good
const { name, jobs } = workflow;
const [first, second] = steps;

// ❌ Avoid
const name = workflow.name;
const jobs = workflow.jobs;
```

#### Use Spread Operator

```typescript
// ✅ Good
const newWorkflow = { ...workflow, name: 'Updated' };
const allSteps = [...defaultSteps, ...customSteps];

// ❌ Avoid
const newWorkflow = Object.assign({}, workflow, { name: 'Updated' });
```

### Conditional Logic

#### Use Ternary for Simple Conditions

```typescript
// ✅ Good
const status = isValid ? 'success' : 'failure';

// ❌ Avoid for complex conditions
const status =
  isValid && hasJobs && !hasErrors
    ? 'success'
    : hasWarnings
      ? 'warning'
      : 'failure'; // Too complex
```

#### Use Early Returns

```typescript
// ✅ Good
function validateInput(input: string): boolean {
  if (!input) {
    return false;
  }

  if (input.length < 3) {
    return false;
  }

  return true;
}

// ❌ Avoid nested conditions
function validateInput(input: string): boolean {
  if (input) {
    if (input.length >= 3) {
      return true;
    }
  }
  return false;
}
```

## Code Review Checklist

Before committing, ensure:

- [ ] Code compiles without errors: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] No linting errors: `npm run lint`
- [ ] Code is formatted: `npm run format`
- [ ] No `any` types (unless absolutely necessary)
- [ ] Descriptive variable and function names
- [ ] Error handling for async operations
- [ ] Type safety maintained (no type assertions unless needed)
- [ ] Comments only where necessary
- [ ] Imports organized correctly

## Pre-commit Workflow

Recommended workflow before committing:

```bash
# 1. Format code
npm run format

# 2. Check linting
npm run lint

# 3. Run tests
npm test

# 4. Build to verify compilation
npm run build

# 5. Commit if all checks pass
git add .
git commit -m "Your commit message"
```

## Common Patterns in actly

### File Reading

```typescript
import * as fs from 'fs';
import * as path from 'path';

const content = fs.readFileSync(filePath, 'utf-8');
```

### YAML Parsing

```typescript
import * as YAML from 'yaml';

const parsed = YAML.parse(content);
```

### Logging

```typescript
import { logger } from '../utils/logger';

logger.info('Processing workflow');
logger.error('Validation failed', error);
```

### CLI Output with chalk

```typescript
import chalk from 'chalk';

console.log(chalk.green('✓ Success'));
console.log(chalk.red('✗ Error'));
console.log(chalk.yellow('⚠ Warning'));
```

## Resources

- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [ESLint Rules](https://eslint.org/docs/rules/)
- [Prettier Options](https://prettier.io/docs/en/options.html)
- [TypeScript ESLint](https://typescript-eslint.io/)

## Summary for AI Agents

Key style points:

- TypeScript with strict mode
- 2-space indentation
- Single quotes, semicolons
- PascalCase for classes/interfaces, camelCase for functions/variables
- Explicit return types for public functions
- Prefer named functions for exports
- Use async/await over promises
- Run `npm run lint && npm run format` before committing
