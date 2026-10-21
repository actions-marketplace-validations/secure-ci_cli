# Architecture Guide for SecureCI

How the codebase is organized, for agents and developers. For user-facing
behavior and every flag, see [DOCS.md](../../DOCS.md).

## Overview

The CLI parses GitHub Actions workflow/action YAML, validates it (optionally
against a pipeline contract), and runs it locally — jobs in `needs:` order,
matrix combinations, reusable workflows, and composite / JavaScript / Docker
actions, each job isolated in a container by default.

Layering is one-directional: **CLI → parser → runner → utils**.

```
CLI (cli.ts)
  → parser/   parse + validate YAML, check contracts
  → runner/   execute workflows, jobs, steps, actions
  → utils/    logging (with secret masking), key=value parsing, repo root
```

## Directory map

```
src/
├── cli.ts                 # Entry point: commander commands (run, validate, inventory, pin, init, list, config, cache)
├── config.ts              # ~/.secureci/config.yml defaults
├── report.ts              # --format text/json/sarif rendering
├── inventory.ts           # Action inventory + lockfile drift
├── pin.ts                 # `secureci pin`: rewrite uses: tags to commit SHAs in place
├── advisories.ts          # GitHub Advisory Database lookups, version ranges, cache
├── init.ts                # `secureci init workflow` generator
├── index.ts               # Library exports
├── parser/
│   ├── workflow-parser.ts            # Parse workflow AND action YAML (parseFile)
│   ├── validator.ts                  # Syntax validation + expression checks
│   ├── injection.ts                  # Template injection: untrusted ${{ }} in run:/github-script (recursive)
│   ├── permissions.ts                # GITHUB_TOKEN permissions checks (default + contract policy)
│   ├── pipeline-contract-parser.ts   # Parse --contract files
│   └── pipeline-contract-validator.ts# Check a workflow against a contract (recursive)
├── runner/
│   ├── dry-run.ts         # Dry-run mode
│   ├── executor.ts        # Entry point: jobs in needs: order, matrix, reusable workflows
│   ├── job-plan.ts        # Matrix expansion + needs: topological sort (pure)
│   ├── github-context.ts  # github context, event payload, typed inputs
│   ├── job-runtime.ts     # Per-job state (JobRuntime), step files, post steps
│   ├── job-container.ts   # Job container, runs-on→image mapping, services, cleanup
│   ├── steps.ts           # run: steps (host or job container)
│   ├── actions.ts         # uses: dispatch, composite actions, built-ins, job-start pre
│   ├── node-action.ts     # JavaScript actions (pre/main/post)
│   ├── docker-action.ts   # Docker actions and docker:// steps
│   ├── checkout.ts        # actions/checkout from the local working copy
│   ├── builtin-actions.ts # Local upload/download-artifact and cache
│   ├── expression.ts      # ${{ ... }} evaluation + if: validation
│   ├── hash-files.ts      # hashFiles() and glob matching
│   ├── runner-env.ts      # GITHUB_*/RUNNER_* env, file + workflow commands
│   ├── shell.ts           # shell: handling, argument splitting
│   ├── container-runtime.ts# Docker/Podman/containerd (nerdctl) CLI driver
│   └── action-fetcher.ts  # Fetch + cache remote actions by commit SHA
├── utils/
│   ├── logger.ts          # Logging with secret masking
│   ├── key-value.ts       # --input/--secret/--env/--var parsing
│   ├── env-file.ts        # --env-file/--secret-file/... parsing and precedence
│   └── repository.ts      # Repository root for ./ references
└── types/index.ts         # Shared TypeScript types
```

## Layers

### CLI (`cli.ts`)

Defines the commander commands and routes to handlers. User-facing error display
and exit codes live here. Keep command wiring thin; put logic in the layer below.

### Parser (`parser/`)

- `workflow-parser.ts` — `parseFile()` reads YAML and returns a typed workflow or
  action.
- `validator.ts` — `validateWorkflow()` / `validateAction()` return a
  `ValidationResult`; also runs expression/`if:` checks
  (`workflowExpressionErrors`, `actionExpressionErrors`) and the template
  injection check from `injection.ts`, which uses `expressionDataFlow()` in
  `runner/expression.ts` to see which contexts reach a `run:` script.
- `permissions.ts` — GITHUB_TOKEN `permissions:` checks: default warnings
  (run by `validateWorkflow`) and the contract `permissions:` policy (errors,
  run by the contract validator). `mergeValidationResults` drops a warning an
  error with the same rule and path supersedes.
- `pipeline-contract-{parser,validator}.ts` — parse a `--contract` file and check
  a workflow against it, recursing into local (and, opt-in, remote) composite
  actions and reusable workflows.

### Runner (`runner/`)

`executor.ts` is the entry point and re-exports the public API. Execution is split
by concern:

- **Planning:** `job-plan.ts` (matrix expansion, `needs:` topological sort — pure
  and unit-tested in isolation).
- **Context:** `github-context.ts` (the `github` context, event payload, typed
  inputs).
- **Per-job:** `job-runtime.ts` (state, step files, post steps) and
  `job-container.ts` (the container, `runs-on`→image mapping, services, cleanup).
- **Per-step:** `steps.ts` (`run:`), `actions.ts` (`uses:` dispatch + composite +
  built-ins), with `node-action.ts` and `docker-action.ts` for the other action
  types. `checkout.ts` and `builtin-actions.ts` are local stand-ins for
  `actions/checkout`, artifacts and cache.
- **Support:** `expression.ts`, `hash-files.ts`, `runner-env.ts`, `shell.ts`,
  `container-runtime.ts`, `action-fetcher.ts`.

`steps.ts` and `actions.ts` import each other (composite actions run steps); every
other dependency points one way.

### Utils (`utils/`)

`logger.ts` is the **secret-masking** logger — use it, not `console`, so masked
values stay redacted. `key-value.ts` parses the `--input/--secret/--env/--var`
flags; `env-file.ts` parses their `.env`-style file counterparts
(`--env-file` etc.) and merges config defaults, files and flags in precedence
order; `repository.ts` finds the repo root for `./` references.

## Execution flow

```mermaid
graph TD
    A[cli.ts] --> B[parse + validate]
    B --> C[executor.ts]
    C --> D[order jobs: needs: topological sort]
    D --> E{for each job}
    E --> F{job.if truthy?}
    F -->|no| G[skip job]
    F -->|yes| H[start job container / services]
    H --> I{for each step}
    I --> J{step.if truthy?}
    J -->|no| K[skip step]
    J -->|yes| L{run: or uses:?}
    L -->|run:| M[steps.ts → shell in container/host]
    L -->|uses:| N[actions.ts → fetch/resolve, then composite/node/docker]
    M --> O[capture $GITHUB_OUTPUT, mask secrets]
    N --> O
    O --> I
    E --> P[WorkflowResult → CLI display]
```

## Conventions that matter here

- **Secrets** are masked across all `logger` output and, in container mode, never
  appear on the container client's command line (passed via a `0600` env file).
- **No silent host fallback.** If the container runtime is unavailable the run
  exits; running on the host requires the explicit `--container-runtime host`
  opt-in.
- **Runner fidelity is the spec.** Where behavior emulates GitHub Actions, "what
  the real runner does" is the reference — cite it in tests and comments when it
  isn't obvious.
- **Type safety:** explicit return types on exported functions; avoid `any`;
  model variants with union types.

## Where to add things

- **New CLI command:** define it in `cli.ts`, keep logic in a dedicated module.
- **New validation rule:** `validator.ts` (+ `validator.test.ts`).
- **New action type:** extend `ActionRuns` in `types/index.ts`, dispatch in
  `actions.ts` (or a new `<type>-action.ts`), add fixtures + tests.
- **New workflow feature:** update `types/index.ts`, the parser, the validator,
  and the executor as needed — test-first.

Keep layers distinct, add/adjust types in `types/index.ts`, and maintain the
coverage thresholds in `vitest.config.mts`. See [TESTING.md](TESTING.md).

## Summary for agents

Layered CLI → parser → runner → utils · runner split by concern with `executor.ts`
as the entry point · secret-masking logger everywhere · container-isolated by
default, no silent host fallback · runner fidelity is the spec · TDD.
