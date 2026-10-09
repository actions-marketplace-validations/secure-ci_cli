# Contributing to the SecureCI CLI

Thanks for helping improve `@secureci/cli`! This guide covers **how to
contribute** — the process, conventions and checks. It is written for both
**human contributors** and **AI coding agents**.

The deep technical detail lives elsewhere, and this document links to it rather
than repeating it:

| If you need…                               | Read                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| A one-screen orientation (and agent setup) | [AGENTS.md](AGENTS.md)                                                 |
| What the CLI does, every flag              | [DOCS.md](DOCS.md)                                                     |
| GitHub Actions concepts (the domain)       | [.github/agents/DOMAIN_CONCEPTS.md](.github/agents/DOMAIN_CONCEPTS.md) |
| How the code is organized                  | [.github/agents/ARCHITECTURE.md](.github/agents/ARCHITECTURE.md)       |
| Day-to-day dev tasks                       | [.github/agents/WORKFLOW.md](.github/agents/WORKFLOW.md)               |
| Testing approach and patterns              | [.github/agents/TESTING.md](.github/agents/TESTING.md)                 |
| Code conventions and style                 | [.github/agents/CODE_STYLE.md](.github/agents/CODE_STYLE.md)           |

## Ground rules

- **Be security-minded.** This is a security tool. A change that could let a
  step escape its container, leak a secret into logs or onto a command line, or
  run untrusted code on the host without the explicit opt-in is a serious bug —
  call it out in the PR and add a test that locks the behavior down.
- **Keep dependencies minimal.** Prefer the standard library and what's already
  here over adding a package. New runtime dependencies need a clear
  justification in the PR.
- **Match the runner.** Where we emulate GitHub Actions, the reference is "what
  the real runner does." Cite that behavior in tests and comments when it isn't
  obvious.
- **Small, focused changes.** One concern per PR. Don't widen scope without
  saying so.

## Getting set up

Requires **Node.js 20+** (the CI uses the version pinned in `volta.node`).

```bash
npm install        # install dependencies
npm run build      # compile TypeScript to dist/
npm test           # run the Vitest suite
```

Try your build against a fixture:

```bash
npm run build
./dist/cli.js run test/fixtures/<some-workflow>.yml --dry-run
```

Two opt-in suites exercise real integrations (off by default, and run in CI):

```bash
RUN_DOCKER_TESTS=1 npm test    # real container runtime (needs a Docker daemon)
RUN_NETWORK_TESTS=1 npm test   # fetches real actions from GitHub
```

## Test-driven development

This project follows **TDD** — it is not optional, it is how the codebase is
built:

1. **Write the test first.** Add or update a `*.test.ts` that defines the
   behavior and fails for the right reason.
2. **Implement** the smallest change that makes it pass.
3. **Refactor** with the tests green.

For bugs, start with a failing test that reproduces the bug, then fix it. See
[TESTING.md](.github/agents/TESTING.md) for fixture and assertion patterns.

## Before you commit

All of these must pass — the same checks run in CI, so running them locally
saves a round-trip:

```bash
npm run lint && npm run format && npm test && npm run build
```

`prettier --check .` runs in CI, so commit formatted code (`npm run format`
rewrites in place). The CLI also validates its own workflow in CI, so keep
`.github/workflows/` valid.

## Commits and pull requests

- **Branch** off `main`; don't commit directly to `main`.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat(runner): …`, `fix(parser): …`, `docs: …`, `test: …`, `refactor: …`,
  `chore: …`, `style: …`. Keep the subject imperative and under ~72 chars;
  explain the _why_ in the body when it isn't obvious.
- **Keep the PR description honest:** what changed, why, how it was tested, and
  any behavior that intentionally differs from the GitHub runner. Link the issue
  it closes (`Fixes #NN`).
- **Update the docs you touched:** user-facing behavior → [DOCS.md](DOCS.md) and,
  if it's headline-level, [README.md](README.md); internal design → the relevant
  file under [.github/agents/](.github/agents/).
- **A PR is ready when** lint, format, tests and build all pass, new behavior has
  tests, and the diff is scoped to one concern.

## For AI agents

This repo is set up to be worked on by coding agents. If you are one:

- **Start with [AGENTS.md](AGENTS.md)** — it points at the five
  `.github/agents/*` docs (domain, architecture, workflow, testing, code style).
  Read the ones relevant to your task before editing.
- **Follow TDD strictly:** write the failing test, then the implementation. Do
  not add code paths that no test exercises.
- **Run the full pre-commit gate** (`npm run lint && npm run format && npm test &&
npm run build`) and report the actual results. If something fails or you
  skipped a step, say so plainly — don't claim green when it isn't.
- **Stay in scope.** Make the change you were asked for; if you spot something
  else, note it rather than fixing it in the same change.
- **Respect the security posture and the minimal-dependency rule** above; they
  apply to agent-authored changes just as much.
- **Don't invent flags or behavior.** Check [DOCS.md](DOCS.md) and the source;
  if the runner's real behavior is unclear, say so instead of guessing.

## Reporting bugs and requesting features

Open an issue with:

- the workflow/action YAML (minimized) that triggers it,
- the exact `secureci` command,
- what you expected (ideally, what the real GitHub runner does) vs. what
  happened,
- CLI version (`secureci --version`), OS, and container runtime.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
