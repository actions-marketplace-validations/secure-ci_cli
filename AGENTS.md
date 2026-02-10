# AI Agent Guidance for actly

**actly** is a CLI tool to locally test GitHub Actions and workflows without pushing to remote.

## Quick Start

**Technology Stack:** TypeScript, Node.js, Vitest, ESLint, Prettier

**Essential Commands:**

```bash
npm run build    # Compile TypeScript
npm test         # Run tests (Vitest)
npm run lint     # Check code style (ESLint)
npm run format   # Format code (Prettier)
```

**Before committing:**

```bash
npm run lint && npm run format && npm test && npm run build
```

## Documentation

- **[DOMAIN_CONCEPTS.md](.github/agents/DOMAIN_CONCEPTS.md)** - GitHub Actions concepts (workflows, actions, jobs, steps)
- **[WORKFLOW.md](.github/agents/WORKFLOW.md)** - Development workflow and common tasks
- **[TESTING.md](.github/agents/TESTING.md)** - Testing strategy and patterns
- **[CODE_STYLE.md](.github/agents/CODE_STYLE.md)** - Code conventions and style guide
- **[ARCHITECTURE.md](.github/agents/ARCHITECTURE.md)** - System architecture and design patterns

## Agent-Specific Context

### GitHub Copilot

Use TypeScript type annotations for better suggestions.

### Claude Code

Follow TDD: write tests first, then implementation.

### Augment

Respect minimal dependencies philosophy - avoid adding new packages unless necessary.
