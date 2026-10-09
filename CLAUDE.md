# CLAUDE.md

Guidance for [Claude Code](https://claude.com/claude-code) working in this
repository. This file is intentionally thin — the canonical agent guidance
lives in **[AGENTS.md](AGENTS.md)** and the docs it links to. Read those first.

## The essentials

- **Project:** `@secureci/cli` — a CLI that validates GitHub Actions workflows,
  checks them against pipeline standards, and runs them locally. See
  [README.md](README.md) for the overview and [DOCS.md](DOCS.md) for the full
  reference.
- **Package manager:** npm. **Runtime:** Node.js 20+.
- **Work test-first (TDD).** Write or update the failing `*.test.ts`, then
  implement, then refactor with tests green. Don't add code paths no test
  exercises.
- **Run the full gate before you commit, and report real results:**
  ```bash
  npm run lint && npm run format && npm test && npm run build
  ```
- **Stay in scope and keep dependencies minimal** — this is a security tool; see
  the ground rules in [CONTRIBUTING.md](CONTRIBUTING.md).

## Where to read more

- [AGENTS.md](AGENTS.md) — orientation and the index below
- [.github/agents/DOMAIN_CONCEPTS.md](.github/agents/DOMAIN_CONCEPTS.md) — GitHub Actions concepts
- [.github/agents/ARCHITECTURE.md](.github/agents/ARCHITECTURE.md) — how the code is organized
- [.github/agents/WORKFLOW.md](.github/agents/WORKFLOW.md) — common dev tasks
- [.github/agents/TESTING.md](.github/agents/TESTING.md) — testing patterns
- [.github/agents/CODE_STYLE.md](.github/agents/CODE_STYLE.md) — code conventions
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution process and PR conventions
