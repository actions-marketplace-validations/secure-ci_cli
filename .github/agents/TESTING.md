# Testing Guidelines for actly

This document provides comprehensive testing guidelines for AI agents and developers working on actly.

## Testing Philosophy

actly follows **Test-Driven Development (TDD)**:

1. Write tests first (Red)
2. Implement features to pass tests (Green)
3. Refactor while keeping tests green (Refactor)

## Test Framework

> **Note for AI Agents**: This project uses **Vitest** as the test framework. Vitest is a modern, fast test runner with excellent TypeScript support and compatibility with Jest APIs.

- **Framework**: Vitest with TypeScript support
- **Test Environment**: Node.js
- **Location**: Tests are co-located with source files (`*.test.ts`)
- **Fixtures**: Stored in `test/fixtures/` directory

## Test Structure

### File Organization

```
src/
├── parser/
│   ├── validator.ts           # Implementation
│   └── validator.test.ts      # Tests
├── runner/
│   ├── executor.ts            # Implementation
│   └── executor.test.ts       # Tests
└── utils/
    ├── logger.ts              # Implementation
    └── logger.test.ts         # Tests (if needed)

test/
└── fixtures/                  # Test data (YAML files)
    ├── simple-workflow.yml
    ├── invalid-workflow.yml
    ├── simple-action.yml
    └── invalid-action.yml
```

### Test File Naming

- Test files: `*.test.ts`
- Alternative: `*.spec.ts` (both patterns supported)
- Tests in `__tests__/` directories are also supported

## Writing Tests

### Basic Test Structure

```typescript
import { functionToTest } from './module';

describe('ModuleName', () => {
  describe('functionToTest', () => {
    it('should do something specific', () => {
      // Arrange
      const input = 'test input';

      // Act
      const result = functionToTest(input);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
```

### Example from actly

```typescript
import { validateWorkflow } from './validator';
import * as path from 'path';

describe('Validator', () => {
  const fixturesDir = path.join(__dirname, '../../test/fixtures');

  describe('validateWorkflow', () => {
    it('should validate a correct workflow', () => {
      const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
      const result = validateWorkflow(workflowPath);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const workflowPath = path.join(fixturesDir, 'invalid-workflow.yml');
      const result = validateWorkflow(workflowPath);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
```

## Test Categories

### Unit Tests

Test individual functions and methods in isolation.

```typescript
describe('parseWorkflowInputs', () => {
  it('should parse simple key-value inputs', () => {
    const input = ['key1=value1', 'key2=value2'];
    const result = parseWorkflowInputs(input);

    expect(result).toEqual({
      key1: 'value1',
      key2: 'value2'
    });
  });
});
```

### Integration Tests

Test interactions between modules.

```typescript
describe('Workflow Execution', () => {
  it('should execute workflow with remote actions', async () => {
    const workflow = loadWorkflow('workflow-with-remote-actions.yml');
    const executor = new WorkflowExecutor();

    const result = await executor.execute(workflow);

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(3);
  });
});
```

### Fixture-Based Tests

Use YAML fixtures for realistic scenarios.

```typescript
describe('Action Parser', () => {
  const fixturesDir = path.join(__dirname, '../../test/fixtures');

  it('should parse composite action', () => {
    const actionPath = path.join(fixturesDir, 'simple-action.yml');
    const action = parseAction(actionPath);

    expect(action.runs.using).toBe('composite');
    expect(action.runs.steps).toBeDefined();
  });
});
```

## Test Fixtures

### Creating Fixtures

Store test YAML files in `test/fixtures/`:

**Example: `test/fixtures/simple-workflow.yml`**

```yaml
name: Simple Workflow
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: echo "Hello World"
```

**Example: `test/fixtures/invalid-workflow.yml`**

```yaml
# Missing required 'on' field
name: Invalid Workflow
jobs:
  build:
    steps:
      - run: echo "This is invalid"
```

### Using Fixtures

```typescript
import * as path from 'path';
import * as fs from 'fs';

const fixturesDir = path.join(__dirname, '../../test/fixtures');
const workflowPath = path.join(fixturesDir, 'simple-workflow.yml');
const workflowContent = fs.readFileSync(workflowPath, 'utf-8');
```

## Vitest Configuration

From `vitest.config.ts`:

```typescript
{
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8', // or 'istanbul'
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.ts',
        'src/**/__tests__/**',
        'src/cli.ts',        // Excluded from coverage
        'src/index.ts'       // Excluded from coverage
      ],
      thresholds: {
        branches: 65,
        functions: 80,
        lines: 80,
        statements: 80
      }
    }
  }
}
```

> **Note**: Vitest uses the same assertion syntax as Jest, so tests remain compatible. The key difference is faster execution and native ESM support.

## Coverage Requirements

Minimum coverage thresholds:

- **Branches**: 65%
- **Functions**: 80%
- **Lines**: 80%
- **Statements**: 80%

Excluded from coverage:

- Type definition files (`*.d.ts`)
- Test files (`*.test.ts`)
- CLI entry point (`cli.ts`)
- Main export file (`index.ts`)
- Files in `__tests__/` directories

## Running Tests

### Basic Commands

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage

# Run specific test file
npm test -- validator.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="should validate"
```

### Watch Mode

When developing, use watch mode for instant feedback:

```bash
npm run test:watch
```

This automatically re-runs tests when files change.

## Test Best Practices

### 1. Descriptive Test Names

✅ Good:

```typescript
it('should return empty array when no workflows are found', () => {
  // ...
});
```

❌ Bad:

```typescript
it('test 1', () => {
  // ...
});
```

### 2. Arrange-Act-Assert Pattern

```typescript
it('should parse workflow inputs correctly', () => {
  // Arrange
  const input = ['key=value'];

  // Act
  const result = parseInputs(input);

  // Assert
  expect(result).toEqual({ key: 'value' });
});
```

### 3. Test One Thing

Each test should verify a single behavior:

```typescript
// Good - separate tests
it('should handle valid input', () => {
  /* ... */
});
it('should throw on invalid input', () => {
  /* ... */
});

// Bad - testing multiple things
it('should handle valid and invalid input', () => {
  /* ... */
});
```

### 4. Use Meaningful Assertions

```typescript
// Good - specific assertions
expect(result.valid).toBe(true);
expect(result.errors).toHaveLength(0);

// Bad - generic assertions
expect(result).toBeTruthy();
```

### 5. Mock External Dependencies

```typescript
import { vi } from 'vitest';

vi.mock('fs');
vi.mock('./external-module');

it('should call external module', () => {
  const mockFn = vi.fn();
  // Test with mock
});
```

### 6. Test Error Cases

Always test both success and failure scenarios:

```typescript
describe('validateWorkflow', () => {
  it('should validate correct workflow', () => {
    /* ... */
  });
  it('should reject invalid workflow', () => {
    /* ... */
  });
  it('should handle missing file', () => {
    /* ... */
  });
  it('should handle malformed YAML', () => {
    /* ... */
  });
});
```

### 7. Use beforeEach/afterEach for Setup/Cleanup

```typescript
describe('ActionFetcher', () => {
  let fetcher: ActionFetcher;

  beforeEach(() => {
    fetcher = new ActionFetcher();
  });

  afterEach(() => {
    // Cleanup
  });

  it('should fetch action', async () => {
    // Test with fetcher
  });
});
```

## Testing Async Code

### Promises

```typescript
it('should fetch remote action', async () => {
  const action = await fetchAction('owner/repo@v1');
  expect(action).toBeDefined();
});
```

### Error Handling

```typescript
it('should throw on invalid action reference', async () => {
  await expect(fetchAction('invalid')).rejects.toThrow('Invalid reference');
});
```

## Common Test Patterns

### Testing File Operations

```typescript
import * as fs from 'fs';
import * as path from 'path';

it('should read workflow file', () => {
  const workflowPath = path.join(fixturesDir, 'workflow.yml');
  const content = fs.readFileSync(workflowPath, 'utf-8');

  expect(content).toContain('name: Test Workflow');
});
```

### Testing YAML Parsing

```typescript
import * as YAML from 'yaml';

it('should parse YAML content', () => {
  const yamlContent = 'name: Test\non: push';
  const parsed = YAML.parse(yamlContent);

  expect(parsed.name).toBe('Test');
  expect(parsed.on).toBe('push');
});
```

### Testing CLI Commands

```typescript
it('should parse CLI arguments', () => {
  const args = ['--dry-run', 'workflow.yml', '--input', 'key=value'];
  const parsed = parseArguments(args);

  expect(parsed.dryRun).toBe(true);
  expect(parsed.workflow).toBe('workflow.yml');
  expect(parsed.inputs).toEqual({ key: 'value' });
});
```

## Debugging Tests

### Running Single Test

```bash
npm test -- --testNamePattern="should validate correct workflow"
```

### Verbose Output

```bash
npm test -- --verbose
```

### Only Run Focused Tests

```typescript
// Use .only to focus on specific test
it.only('should focus on this test', () => {
  // Only this test runs
});
```

### Skip Tests

```typescript
// Use .skip to temporarily disable test
it.skip('should skip this test', () => {
  // This test won't run
});
```

## Continuous Integration

Tests run automatically in CI:

- All tests must pass
- Coverage thresholds must be met
- No console errors or warnings

## When to Add Tests

### Always Add Tests For:

- New features
- Bug fixes
- Refactored code
- Public APIs
- Complex logic

### Tests May Be Optional For:

- Simple getters/setters
- Trivial utility functions
- TypeScript type definitions
- Configuration files

## Test Maintenance

### Keeping Tests Green

- Run tests before committing: `npm test`
- Fix failing tests immediately
- Don't commit commented-out tests
- Remove obsolete tests

### Updating Tests

- Update tests when requirements change
- Refactor tests along with code
- Keep test code clean and maintainable

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Vitest API Reference](https://vitest.dev/api/)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)

## Summary Checklist for AI Agents

When writing tests:

- [ ] Use descriptive test names
- [ ] Follow Arrange-Act-Assert pattern
- [ ] Test one thing per test
- [ ] Include both success and error cases
- [ ] Use fixtures for complex test data
- [ ] Mock external dependencies using `vi.mock()`
- [ ] Maintain coverage thresholds
- [ ] Run tests before committing
- [ ] Keep tests maintainable and clean
