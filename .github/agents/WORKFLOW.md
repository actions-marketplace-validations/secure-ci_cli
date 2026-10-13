# Development Workflow for SecureCI

This document covers the development workflow and common tasks for working on SecureCI.

## Before You Start

Ensure you understand:

- [DOMAIN_CONCEPTS.md](DOMAIN_CONCEPTS.md) - GitHub Actions concepts
- [ARCHITECTURE.md](ARCHITECTURE.md) - System architecture
- [TESTING.md](TESTING.md) - Testing approach
- [CODE_STYLE.md](CODE_STYLE.md) - Code conventions

## Pre-Commit Checklist

Run these commands before committing:

```bash
npm run lint     # Check code style
npm run format   # Auto-format code
npm test         # Run all tests
npm run build    # Verify compilation
```

All checks must pass before committing.

## Common Tasks

### Adding a New Feature

1. **Create test fixtures** (if needed)
   - Add YAML files to `test/fixtures/`
   - Use realistic workflow/action examples

2. **Write tests first** (TDD approach)
   - Create or update `.test.ts` file
   - Write failing tests that define the feature
   - See [TESTING.md](TESTING.md) for patterns

3. **Implement the feature**
   - Add/modify source files
   - Follow [CODE_STYLE.md](CODE_STYLE.md) conventions
   - Keep changes minimal and focused

4. **Verify the feature**

   ```bash
   npm test              # Run tests
   npm run lint          # Check style
   npm run build         # Ensure builds
   ```

5. **Test manually** (if applicable)
   ```bash
   npm run build
   ./dist/cli.js run test/fixtures/your-workflow.yml --dry-run
   ```

### Fixing a Bug

1. **Reproduce the bug**
   - Write a failing test that demonstrates the bug
   - Verify the test fails as expected

2. **Fix the bug**
   - Make minimal changes to fix the issue
   - Ensure the test now passes

3. **Check for regressions**

   ```bash
   npm test              # All tests should pass
   ```

4. **Verify the fix manually** (if applicable)

### Refactoring Code

1. **Ensure tests pass**

   ```bash
   npm test              # All green before starting
   ```

2. **Make incremental changes**
   - Refactor one small piece at a time
   - Run tests after each change

3. **Maintain coverage**
   - Check coverage: `npm run test:coverage`
   - Keep above thresholds (65% branches, 80% functions/lines/statements)

4. **Update documentation**
   - If public APIs change, update relevant docs

### Adding a New Parser Feature

Example: Adding support for a new workflow field

1. **Update types** in `src/types/index.ts`
2. **Update parser** in `src/parser/workflow-parser.ts`
3. **Update validator** in `src/parser/validator.ts`
4. **Add tests** with new fixture files
5. **Update executor** if the field affects execution

### Adding a New Action Type

Example: Adding Docker action support

1. **Update action types** in `src/types/index.ts`
2. **Update action fetcher** in `src/runner/action-fetcher.ts`
3. **Update action execution** in `src/runner/actions.ts`
4. **Add tests** with Docker action fixtures
5. **Update documentation** in DOMAIN_CONCEPTS.md

### Adding a New CLI Option

1. **Update CLI parser** in `src/cli.ts`
   - Add option using Commander.js

2. **Update handler function**
   - Pass option to relevant module

3. **Add tests** for the option

4. **Update README.md** with new option

## Development Commands

### Build Commands

```bash
npm run build         # Production build (tsc)
npm run dev           # Watch mode (tsc --watch)
```

### Test Commands

```bash
npm test                    # Run all tests
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report

# Run specific test file
npm test -- validator.test.ts

# Run tests matching pattern
npm test -- --testNamePattern="should validate"
```

### Code Quality Commands

```bash
npm run lint              # ESLint check
npm run format            # Prettier format
```

### CLI Usage (after build)

```bash
# Help
./dist/cli.js --help

# Dry run
./dist/cli.js run .github/workflows/ci.yml --dry-run

# Validate
./dist/cli.js validate .github/workflows/ci.yml

# Execute with inputs
./dist/cli.js workflow.yml --input key=value

# Execute with secrets
./dist/cli.js workflow.yml --secret TOKEN=xxx
```

## Working with Dependencies

### Adding a Production Dependency

1. **Evaluate necessity**
   - Can you implement without a new dependency?
   - Is the dependency well-maintained?
   - Does it align with minimal dependencies philosophy?

2. **Install**

   ```bash
   npm install package-name
   ```

3. **Use in code**
   - Import and use the package
   - Follow its best practices

4. **Test thoroughly**
   - Ensure it works in all scenarios
   - Add tests for integration

### Adding a Development Dependency

```bash
npm install --save-dev package-name
```

Examples: testing tools, build tools, linters

## Working with Fixtures

Fixtures are YAML files used in tests.

### Adding a New Fixture

1. **Create file** in `test/fixtures/`

   ```yaml
   # test/fixtures/my-workflow.yml
   name: My Test Workflow
   on: push
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - run: echo "test"
   ```

2. **Use in tests**
   ```typescript
   const fixturesDir = path.join(__dirname, '../../test/fixtures');
   const workflowPath = path.join(fixturesDir, 'my-workflow.yml');
   ```

### Fixture Naming Conventions

- `simple-*.yml` - Basic valid examples
- `invalid-*.yml` - Invalid examples for error testing
- `complex-*.yml` - Multi-job or advanced examples
- Descriptive names: `workflow-with-inputs.yml`

## Debugging

### Debugging Tests

```bash
# Run single test
npm test -- --testNamePattern="specific test"

# Verbose output
npm test -- --verbose

# Focus on one test
# Add .only to test:
it.only('should test this', () => { ... });
```

### Debugging the CLI

Add console.log or use Node.js debugger:

```bash
node --inspect-brk dist/cli.js run workflow.yml --dry-run
```

## Contributing Philosophy

When working on SecureCI, keep these principles in mind:

### Minimal Dependencies

Only add dependencies when:

- Feature requires external functionality
- Implementing would duplicate well-tested code
- Dependency is stable and well-maintained

Avoid dependencies for:

- Simple utility functions you can write
- Large libraries when you need one function
- Unmaintained or risky packages

### MVP Focus

Features should be:

- Focused on core use case (local testing of GitHub Actions)
- Simple and easy to use
- Well-documented
- Thoroughly tested

Avoid:

- Feature creep
- Over-engineering
- Complex abstractions without clear benefit

### Test Coverage

Maintain or improve test coverage:

- Write tests for all new code
- Aim for >80% coverage on functions/lines/statements
- Aim for >65% coverage on branches
- Use meaningful assertions

### TypeScript First

Leverage TypeScript:

- Use strict type checking
- Define clear interfaces
- Avoid `any` type
- Use type inference where appropriate

### User Experience

Keep the CLI:

- Simple and intuitive
- Consistent with GitHub Actions terminology
- Well-documented with clear error messages
- Fast and responsive

## Getting Unstuck

If you're stuck:

1. **Check existing code** - Look for similar implementations
2. **Review tests** - Test files show usage examples
3. **Check fixtures** - YAML examples show valid structures
4. **Read GitHub Actions docs** - Understand the standard behavior
5. **Ask for help** - Open an issue or discussion

## Release Process

(For maintainers)

Releases are automated by the `publish` job in `.github/workflows/ci.yaml`:

1. Bump `version` in `package.json` (and `package-lock.json`) in your PR
2. Merge to `main`
3. CI publishes `@secureci/cli@<version>` to npm if that version isn't there
   yet, then creates the `v<version>` tag and GitHub release on the merge commit

Don't tag or `npm publish` by hand. The job fails if `v<version>` already
exists on a different commit, so pick a version that has no tag yet.
`secureci init workflow` emits `secure-ci/cli@v<version>`, so each release
tag must exist for the workflows it generates to resolve.
