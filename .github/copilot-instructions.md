# GitHub Copilot instructions

Repository guidance for GitHub Copilot. This file is intentionally thin — the
canonical agent guidance lives in [AGENTS.md](../AGENTS.md) and the docs it
links to.

## The essentials

- **Project:** `@secureci/cli` — a CLI that validates GitHub Actions workflows,
  checks them against pipeline standards, and runs them locally (TypeScript,
  Node.js 20+, npm).
- **Test-first (TDD):** add or update a `*.test.ts` that fails for the right
  reason, then implement, then refactor with tests green. Don't suggest code no
  test covers.
- **Use TypeScript type annotations** and match the strict-mode conventions in
  [.github/agents/CODE_STYLE.md](agents/CODE_STYLE.md).
- **Keep dependencies minimal** — prefer the standard library and existing
  helpers over new packages. This is a security tool; don't weaken container
  isolation, secret masking, or the host-mode opt-in.
- **Before committing, all four checks must pass:**
  ```bash
  npm run lint && npm run format && npm test && npm run build
  ```

## Where to read more

- [AGENTS.md](../AGENTS.md) — orientation and index
- [.github/agents/DOMAIN_CONCEPTS.md](agents/DOMAIN_CONCEPTS.md) — GitHub Actions concepts
- [.github/agents/ARCHITECTURE.md](agents/ARCHITECTURE.md) — code structure
- [.github/agents/WORKFLOW.md](agents/WORKFLOW.md) — common tasks
- [.github/agents/TESTING.md](agents/TESTING.md) — testing patterns
- [.github/agents/CODE_STYLE.md](agents/CODE_STYLE.md) — code conventions
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contribution process
