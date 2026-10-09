# AI Agent Guidance for the SecureCI CLI

**The SecureCI CLI** (`@secureci/cli`, command `secureci`) validates GitHub Actions workflows, checks them against pipeline standards, and runs them locally without pushing to remote.

## Quick Start

**Technology Stack:** TypeScript, Node.js 20+, npm, Vitest, ESLint, Prettier

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

This file is the **single source of truth** for agents. Deeper guidance is split
into focused files (read the one relevant to your task):

- **[DOMAIN_CONCEPTS.md](.github/agents/DOMAIN_CONCEPTS.md)** - GitHub Actions concepts (workflows, actions, jobs, steps)
- **[WORKFLOW.md](.github/agents/WORKFLOW.md)** - Development workflow and common tasks
- **[TESTING.md](.github/agents/TESTING.md)** - Testing strategy and patterns
- **[CODE_STYLE.md](.github/agents/CODE_STYLE.md)** - Code conventions and style guide
- **[ARCHITECTURE.md](.github/agents/ARCHITECTURE.md)** - System architecture and design patterns
- **[CONTRIBUTING.md](CONTRIBUTING.md)** - Contribution process and PR conventions (humans and agents)
- **[DOCS.md](DOCS.md)** - End-user CLI reference (commands, flags, behavior)

## Agent entry points

Different tools auto-load different files; each thin file redirects here so the
guidance stays in one place:

- **Claude Code** → [CLAUDE.md](CLAUDE.md)
- **GitHub Copilot** → [.github/copilot-instructions.md](.github/copilot-instructions.md)
- **Augment** and other `AGENTS.md`-aware tools → this file

## Agent-Specific Context

### GitHub Copilot

Use TypeScript type annotations for better suggestions.

### Claude Code

Follow TDD: write tests first, then implementation.

### Augment

Respect minimal dependencies philosophy - avoid adding new packages unless necessary.

## Non-negotiables for any agent

- **TDD:** write the failing test first, then the implementation. Don't add code
  paths no test exercises.
- **Security tool:** never weaken container isolation, secret masking, or the
  explicit host-mode opt-in. Match GitHub runner behavior where the CLI emulates it.
- **Minimal dependencies** and **small, focused changes** — stay within the scope
  you were asked for.
- **Report real results** of the pre-commit gate; don't claim green when it isn't.
