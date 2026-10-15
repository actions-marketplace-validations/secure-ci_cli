# SecureCI — reference

Full reference for `@secureci/cli` (the `secureci` command). For a short
introduction and install steps, see the [README](README.md).

## Contents

- [Commands at a glance](#commands-at-a-glance)
- [Container isolation](#container-isolation)
  - [Flags](#flags)
  - [How container mode works](#how-container-mode-works)
  - [Security: what runs where](#security-what-runs-where)
  - [`actions/checkout`](#actionscheckout)
- [Global configuration](#global-configuration)
- [Pipeline contracts (`validate --contract`)](#pipeline-contracts-validate---contract)
  - [Supply-chain pinning](#supply-chain-pinning)
  - [Contract limitations (v1 scope)](#contract-limitations-v1-scope)
- [Machine-readable output (`--format`)](#machine-readable-output---format)
- [Action inventory and drift (`secureci inventory`)](#action-inventory-and-drift-secureci-inventory)
- [Use in CI (GitHub Action)](#use-in-ci-github-action)
  - [Generate the workflow (`secureci init workflow`)](#generate-the-workflow-secureci-init-workflow)
- [Using output as audit evidence](#using-output-as-audit-evidence)
- [Workflow features](#workflow-features)
  - [Conditional execution (`if:`)](#conditional-execution-if)
  - [Job dependencies (`needs:`)](#job-dependencies-needs)
  - [Service containers (`jobs.<id>.services`)](#service-containers-jobsidservices)
  - [Artifacts and caching](#artifacts-and-caching)
  - [Matrix builds (`strategy.matrix`)](#matrix-builds-strategymatrix)
  - [Reusable workflows (`jobs.<id>.uses:`)](#reusable-workflows-jobsiduses)
  - [Shells and `defaults.run`](#shells-and-defaultsrun)
  - [Step outputs](#step-outputs)
  - [File commands and workflow commands](#file-commands-and-workflow-commands)
  - [Events and the `github` context](#events-and-the-github-context)
  - [Default environment variables](#default-environment-variables)
  - [Secret masking](#secret-masking)
- [Remote action support](#remote-action-support)
- [Architecture](#architecture)

## Commands at a glance

`run` **executes** the workflow (one container per job by default). To check a
workflow without running anything, use [`validate`](#machine-readable-output---format)
(static syntax/contract/expression checks) or `run --dry-run` (simulate, showing
what would run). `run` prints a one-line reminder of these alternatives when it
starts.

```bash
# Run / dry-run a workflow
secureci run .github/workflows/ci.yml           # executes for real
secureci run .github/workflows/ci.yml --dry-run # simulate, no execution
secureci run .github/workflows/ci.yml --job build

# Validate (optionally against a pipeline contract), human or machine output
secureci validate .github/workflows/ci.yml
secureci validate .github/workflows/deploy.yml --contract contracts/standard.yml
secureci validate .github/workflows/ci.yml --format json

# Inventory the actions a workflow uses, and track drift
secureci inventory                 # bootstrap secureci.lock, or drift-check if it exists
secureci inventory --dry-run       # just print the resolved inventory as JSON
secureci inventory --update-lock   # (re)write ./secureci.lock
secureci inventory --check         # compare against ./secureci.lock, fail on drift

# Generate a PR-checks workflow, list workflows, manage config/cache
secureci init workflow
secureci list
secureci config list
secureci cache path
```

Passing inputs, env and secrets to `run`:

```bash
# Inputs for workflow_dispatch / workflow_call
secureci run wf.yml --input key=value

# Env vars for steps (a bare NAME passes $NAME from your shell)
secureci run wf.yml --env NPM_CONFIG_REGISTRY
secureci run wf.yml --env NPM_CONFIG_REGISTRY=https://example.com

# Secrets (a bare NAME reads $NAME from your environment, keeping the value
# out of the process list and shell history)
secureci run wf.yml --secret TOKEN
secureci run wf.yml --secret TOKEN=xxx

# Repository variables for the vars context
secureci run wf.yml --var ENVIRONMENT=staging
```

## Container isolation

### Flags

| Flag                         | Description                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--container-runtime <name>` | `auto`\|`docker`\|`podman`\|`containerd`\|`host` (default: `docker`, overridable via `~/.secureci/config.yml`). If the runtime isn't available, the run stops before any step runs. `host` runs steps directly on this machine, without a container (opt-in only) |
| `--container-image <image>`  | Image for every job without `jobs.<id>.container`, overriding the `runs-on` mapping (see below)                                                                                                                                                                   |
| `--container-timeout <ms>`   | Per-step timeout in milliseconds                                                                                                                                                                                                                                  |
| `--container-memory <limit>` | Memory limit, e.g. `512m`                                                                                                                                                                                                                                         |
| `--no-network`               | Disable container network access (networking is on by default, like GitHub-hosted runners)                                                                                                                                                                        |
| `--allow-network`            | Allow container network access; only needed to override `allow-network: false` in the config file                                                                                                                                                                 |

`containerd` is driven via its Docker-CLI-compatible front-end, [`nerdctl`](https://github.com/containerd/nerdctl).

### How container mode works

- Each job (and each matrix combination) gets **one container**, started when the job begins and removed when it ends, including when a step fails or you press Ctrl-C. Every `run:` step and JavaScript action in the job runs in it via `exec`, so files, installed packages and tools from earlier steps are still there. The current directory is mounted at `/secureci-workspace`.
- The image is chosen in this order:
  1. `jobs.<id>.container` (string or `{ image, env }` form; `options`, `volumes`, `ports` and `credentials` are ignored with a warning). With `--container-runtime host` it's ignored and the job runs on the host.
  2. `--container-image`, for every job.
  3. The job's `runs-on` label, mapped to a runner-like image: `ubuntu-latest` → `catthehacker/ubuntu:act-latest`, `ubuntu-24.04` / `22.04` / `20.04` → `catthehacker/ubuntu:act-24.04` / `act-22.04` / `act-20.04` (the images nektos/act uses, with Node.js, git, curl and common runner tools). Add or override labels with `runner-images` in the config file (below).
  4. `container-image` from the config file, else `catthehacker/ubuntu:act-22.04`, for labels with no mapping (self-hosted, custom), with a warning. `windows-*` / `macos-*` jobs also run in this Linux image, with a warning.
- The runner images are large (about 2 GB unpacked) and pulled on first use.
- JavaScript actions run with the image's own `node`. If an image has no Node.js (e.g. a plain `ubuntu:22.04` via `--container-image`), they fail with a clear error.
- `jobs.<id>.services` are supported: see [Service Containers](#service-containers-jobsidservices).
- `--container-timeout` fails a step that runs longer than the given time, and kills its processes in the job container (including background ones it started).

### Security: what runs where

> [!WARNING]
> The CLI never falls back to running steps on your machine: if the container runtime isn't available, it reports that and exits without running anything. Only with `--container-runtime host` (an explicit opt-in, also settable in the config file) do `run:` steps and **remote JavaScript and composite actions run directly on your machine with your user's privileges**. Any third-party action can read your files and use your network. The CLI prints a warning listing the remote actions before such a job runs. Use a container runtime to sandbox them.

- On the host, steps and actions don't inherit your shell's environment: only `PATH`, `HOME`, locale, temp-dir, proxy/CA and container-client variables are passed, plus the runner's `GITHUB_*` / `RUNNER_*` variables and the workflow's own `env:`. Pass anything else explicitly with `--env NAME` (value from your shell) or `--env NAME=value`, and secrets with `--secret NAME`.
- In container mode, env values never appear on the container client's command line (see [Secret Masking](#secret-masking) below).

### `actions/checkout`

`actions/checkout` of the repository being run (no `repository:` input, or the current repository) doesn't clone anything: the workspace already is your working copy, so later steps see your uncommitted changes, no network or token is needed, and your `.git` is never touched. The step's `ref` and `commit` outputs are `github.ref` and `github.sha`.

- `path:` copies the working copy into that subdirectory (skipping the copy itself) and removes it when the job ends. A non-empty directory there that the CLI didn't create is never overwritten; the step fails instead.
- `ref:` and other inputs (`fetch-depth`, `submodules`, ...) are ignored, with a warning for a `ref` other than the current one.
- Checkouts of **other** repositories run the real action, which needs a token: pass one with `--secret GITHUB_TOKEN` (reads `$GITHUB_TOKEN`). It becomes both `secrets.GITHUB_TOKEN` and `github.token`. No token is picked up implicitly, since every action in the run could read it.
- `--no-local-checkout` runs the real action for the current repository too.

## Global configuration

SecureCI reads defaults from `~/.secureci/config.yml` (created on first `secureci config set`, or editable by hand). Config keys match the CLI flag names (kebab-case, minus the leading `--`). CLI flags always take precedence over the config file.

```bash
secureci config set container-runtime podman   # persist a default
secureci config get container-runtime
secureci config list
secureci config unset container-runtime        # revert to the built-in default (docker)
secureci config path                           # print the config file location
```

Supported keys: `container-runtime`, `container-image`, `container-timeout`, `container-memory`, `allow-network`, and `runner-images.<label>`:

```bash
secureci config set runner-images.ubuntu-latest node:20-bookworm   # map one runs-on label
secureci config set runner-images.my-self-hosted-runner my/image:1
```

```yaml
# ~/.secureci/config.yml
runner-images:
  ubuntu-latest: node:20-bookworm
  my-self-hosted-runner: my/image:1
```

## Pipeline contracts (`validate --contract`)

In organizations with a central repo of reusable workflows/actions, a platform team can define a minimum pipeline standard — required actions, forbidden actions, and (optionally) the order required actions must run in — and have SecureCI check a caller's workflow against it.

```yaml
# contracts/platform-standard.yml
ordering: relative # or "strict" (default: relative)
required:
  - uses: org/security-scan
    min-version: v1.2.0
  - uses: org/deploy
forbidden:
  - uses: org/legacy-deploy # forbid entirely, any version
  - uses: org/deploy
    version: v1 # forbid only this exact version
```

```bash
secureci validate .github/workflows/deploy.yml --contract contracts/platform-standard.yml
```

If the caller's workflow calls `org/deploy` before `org/security-scan` (or uses `org/legacy-deploy`, or omits a required action, or pins `org/security-scan` below `v1.2.0`), the command exits non-zero with a message like:

```
[INFO] Validating workflow...
[INFO] Validating against pipeline contract: contracts/platform-standard.yml
[ERROR] Validation failed:
[ERROR]   [ERROR] required[1]: Required action "org/deploy" must run after "org/security-scan", but it does not
```

- `uses:` steps in the workflow are checked, **including those inside local composite actions** (`uses: ./path`) **and local reusable workflows** (`jobs.<id>.uses: ./path.yml`), resolved recursively from the repository root, so wrapping an action doesn't hide it. With `--contract-recurse all`, **remote** composite actions and reusable workflows (`org/repo/...@ref`) are downloaded (through the action cache) and inspected too; one that can't be fetched is a warning. `--contract-recurse none` checks only the workflow file itself. The default, `local`, stays offline. Error paths show the call path, e.g. `jobs.release > ./.github/workflows/release.yml > jobs.ship.steps[0]`. Cycles and nesting deeper than 10 levels are errors; a local reference that can't be found is a warning.
- Ordering follows what GitHub guarantees: steps of a job run in order (a composite action's steps in place of its `uses:` step), and a job runs after every job it needs, directly or transitively (a reusable-workflow call's jobs run after the call's own `needs:`). Two required actions in jobs with **no `needs:` relationship** may run in parallel, so neither counts as "after" the other: that's an ordering error, whatever the jobs' order in the YAML.
- `ordering: relative` (default): required actions must appear in that relative order, with any other steps allowed in between. `ordering: strict`: required actions must run back-to-back, with no other step in between; across jobs, only the last step of a job followed by the first step of a job that directly needs it counts.
- A missing required action, a required action below `min-version`, an ordering violation, or any forbidden-action match is an **error** (validation fails). A required action whose version can't be compared (e.g. pinned to a branch or SHA) is a **warning**. Ordering is checked for every required action that is present, including one below `min-version` (its first occurrence is used), and errors name the contract's own `required[N]` entry.

### Supply-chain pinning

A contract can require that every remote action is pinned to a full commit SHA and restrict which owners may be used — enforced across the same flattened sequence, so a tag or an unlisted owner can't hide inside a composite action or reusable workflow:

```yaml
pins:
  required: true # every remote action must be pinned to a 40-char commit SHA
  allow:
    - actions # trust these owners (or owner/repo) by tag
allowed-owners: # if set, every remote action's owner must be listed
  - actions
  - my-org
```

Local (`./`) and `docker://` references are exempt from SHA pinning. An unpinned action or a disallowed owner is an **error**, reported at the step's call path.

`--contract` runs the normal syntax validation too, and currently applies to workflow files only (not standalone actions, since the contract is about a job/step sequence). Passing `--contract` against an action file fails with a clear error.

### Contract limitations (v1 scope)

- Without `--contract-recurse all`, **remote** composite actions and reusable workflows are not inspected; only the reference itself is matched.
- **`strategy.matrix` jobs** are checked once against the job's `steps:` as authored, not once per combination: `uses:` can't contain expressions, so a matrix can only change _whether_ steps run (via `if:`), not which actions they use.
- **`if:` conditions** aren't evaluated. A required action that only appears in steps or jobs with an `if:` (other than `success()` / `always()`) is reported as a **warning** that it may be skipped; a forbidden action counts even under an `if:`.
- **Action references** are matched as exact strings against `uses:` (minus any `@version` suffix) — this covers the common `owner/repo` or `owner/repo/path` marketplace-action form, as well as local paths (`./.github/actions/foo`, matched with no version). `docker://image` references are matched as-is (the whole string, including `docker://`) and have no version-pin concept.
- The `owner/repo` part of an action reference is matched **case-insensitively**, as GitHub resolves it (`Org/Action` matches a contract entry for `org/action`). A path inside the repo (`owner/repo/Path`), local paths and `docker://` references (whose tags are case-sensitive) are matched exactly.

## Machine-readable output (`--format`)

`secureci validate` can emit results as JSON or SARIF for CI, instead of the default human-readable text. Both cover syntax validation and `--contract` findings, exit non-zero when validation fails, and print nothing but the report to stdout.

```bash
secureci validate .github/workflows/ci.yml --format json
secureci validate .github/workflows/ci.yml --contract contract.yml --format sarif > results.sarif
```

- **`json`**: `{ file, valid, errors: [{ path, message, severity }] }`.
- **`sarif`**: a SARIF 2.1.0 log (rules `secureci/validation`, `secureci/contract`, `secureci/expression`). Upload it with `github/codeql-action/upload-sarif` to see findings inline on pull requests in GitHub code scanning.

## Action inventory and drift (`secureci inventory`)

`secureci inventory` lists every action and reusable workflow a workflow uses — resolved recursively into local composite actions and reusable workflows, so wrapped references show up too — and resolves each remote action's tag or branch to the commit SHA it currently points at.

```bash
secureci inventory --dry-run                        # all workflows in .github/workflows, as JSON
secureci inventory .github/workflows/ci.yml --dry-run # one file, as JSON
secureci inventory --dry-run --offline              # don't resolve over the network
```

Each entry carries `uses`, `owner`, `repo`, `ref`, whether it's `pinned` to a full commit SHA, the `resolvedSha`, and the call `paths` where it appears. Tags and branches are resolved with `git ls-remote` (or the API when a token is available); `--offline` resolves only already-pinned refs.

### Drift against `secureci.lock`

> **Highly recommended:** commit `secureci.lock` to your repo (like `package-lock.json`) and run `secureci inventory --check` in CI. A moved tag — the way the [tj-actions/changed-files incident](https://www.stepsecurity.io/blog/harden-runner-detection-tj-actions-changed-files-action-with-commit-compromise) spread — then becomes a failing check instead of a silent compromise.

`secureci.lock` records what each action reference resolves to today, so you can catch it moving later. It always lives at the repo root (no path to configure).

```bash
secureci inventory                 # bootstrap secureci.lock if missing, else drift-check
secureci inventory --update-lock   # (re)write secureci.lock (alias: --update-lockfile)
secureci inventory --check         # compare against secureci.lock, fail on drift (alias: --compare)
```

- **Bare `secureci inventory`** writes `secureci.lock` the first time (when none exists), and drift-checks against it on later runs.
- **`--check` / `--compare`** always compares and fails (non-zero) when a `uses:` reference now resolves to a different commit than recorded (a moved tag) or a new action isn't in the lock yet. Use it in CI.
- **`--update-lock` / `--update-lockfile`** accepts the current state by rewriting the lock. Review the diff, then commit it.

The lockfile is plain JSON (`{ version, actions: { "owner/repo@ref": "<sha>" } }`), safe to commit and diff.

## Use in CI (GitHub Action)

Run the same checks on pull requests with the bundled composite action. It validates your workflows (optionally against a contract) and, by default, uploads a SARIF report so findings show up inline on the PR via GitHub code scanning.

```yaml
# .github/workflows/secureci.yml
name: SecureCI
on: [pull_request]
permissions:
  contents: read
  security-events: write # for the SARIF upload
jobs:
  secureci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: secure-ci/cli@v0.2.0 # a release tag; see below
        with:
          # all inputs are optional
          contract: contracts/platform-standard.yml
          # files: .github/workflows/*.yml   # default: every file in .github/workflows
          # format: sarif                    # or json
          # upload-sarif: true               # set false to skip code-scanning upload
          # inventory: check                 # also fail when an action tag moved (needs a committed secureci.lock)
```

The job fails if any workflow is invalid or violates the contract. Inputs: `files`, `contract`, `contract-recurse`, `format`, `output`, `upload-sarif`, `inventory` (`check` to also run `secureci inventory --check`), `version` (which `@secureci/cli` to run), and `github-token`.

Reference the action by a [release tag](https://github.com/secure-ci/cli/releases) such as `v0.2.0`. There is no moving major tag (`@v1`, `@v0`), so a ref like that won't resolve. `secureci init workflow` fills in the tag matching your installed CLI. The action runs [`@secureci/cli`](https://www.npmjs.com/package/@secureci/cli) from npm via `npx`; set the `version` input to pin which CLI release it runs (default `latest`).

### Generate the workflow (`secureci init workflow`)

`secureci init workflow` writes the workflow above to `.github/workflows/secureci.yml` so you don't have to copy it by hand, with the action pinned to the release tag of the CLI you ran it with (`secure-ci/cli@v<version>`; check yours with `secureci --version`). (Bare `secureci init` just prints help and its subcommands.)

```bash
secureci init workflow                                   # SARIF upload on (default)
secureci init workflow --contract contracts/standard.yml # also check a pipeline contract
secureci init workflow --no-upload                        # keep contents: read only, no code-scanning upload
secureci init workflow --output .github/workflows/ci-security.yml
```

It refuses to overwrite an existing file unless you pass `--force`, and the file it writes passes `secureci validate`.

## Using output as audit evidence

Auditors and assessors increasingly treat the CI pipeline as part of the software supply chain. What SecureCI writes is plain text you can commit, diff and keep, which makes it usable as evidence that a control is in place:

| Artifact                                          | Where it comes from                                                   | What it shows                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Pipeline contract (e.g. `contracts/standard.yml`) | You write it; commit it                                               | Your pipeline standard, written down and versioned                           |
| `secureci.lock`                                   | `secureci inventory`                                                  | An inventory of every third-party action and the commit each tag resolved to |
| `secureci.lock` history                           | `git log -p secureci.lock`                                            | When each action was added or changed, and in which commit                   |
| SARIF / JSON report                               | `secureci validate --format sarif\|json`                              | The result of the contract check for a given commit                          |
| Required check on pull requests                   | The [GitHub Action](#use-in-ci-github-action) with `inventory: check` | Non-conforming or drifted workflows cannot merge                             |

To keep a report per run, turn on the action's drift check and upload the report as a build artifact:

```yaml
- uses: secure-ci/cli@v0.2.0 # first release with `inventory`; writes secureci-results.sarif
  with:
    contract: contracts/standard.yml
    inventory: check # fail on drift against the committed secureci.lock
- uses: actions/upload-artifact@v4
  if: always()
  with:
    name: secureci-evidence
    path: secureci-results.sarif
    retention-days: 90 # match your audit retention policy
```

These artifacts **support** controls; they don't make you compliant on their own. Which controls they help with in PCI DSS, DORA, NIS2, the UK Software Security Code of Practice, ISO/IEC 27001 and SOC 2 is mapped, with what you still need beyond SecureCI, at [secure-ci.dev/compliance](https://secure-ci.dev/compliance).

## Workflow features

### Conditional execution (`if:`)

Jobs and steps support `if:` expressions, and `${{ }}` works anywhere a value is expected (`run:`, `env:`, `with:`, `outputs:`). Supported:

- **Contexts:**
  - `github` (including `github.event`)
  - `env`, `inputs`, `secrets`, `matrix`
  - `steps` (`outputs`, `outcome`, `conclusion`)
  - `needs` (`outputs`, `result`)
  - `job.status`
  - `runner` (`os`, `arch`, `temp`, `tool_cache`)
  - `vars` (set with `--var KEY=VALUE`)
  - `strategy` (`job-index`, `job-total`, `fail-fast`, `max-parallel`)
- **Syntax:**
  - `.`, `['key']` and `*` access
  - `'string'` (with `''` escapes), number, `true`/`false`/`null` literals
  - `! < <= > >= == != && ||`, with GitHub's loose typing. `a || 'default'` returns the value, not a boolean.
- **Functions:**
  - `contains`, `startsWith`, `endsWith`
  - `format`, `join`
  - `toJSON`, `fromJSON`
  - `hashFiles` (globs relative to the workspace, `!` excludes)
  - `success()`, `failure()`, `always()`, `cancelled()`

As on GitHub, an `if:` without a status function means `success() && (...)`. After a step fails, later steps are skipped unless their `if:` uses `always()` or `failure()`. A job whose `needs` didn't all succeed is skipped unless its `if:` uses one of them.

Invalid `if:` expressions fail, as on GitHub, and never count as true:

- **Checked before anything runs** (`run`, `run --dry-run` and `validate`): syntax errors, unknown functions (e.g. a typo like `sucess()`), wrong argument counts, and contexts not available where they're used. A job's `if:` can only use `github`, `needs`, `vars` and `inputs` (not `matrix`, `steps` or `env`), and composite action steps can't use `secrets`. The run stops with `Invalid workflow file`, listing each `jobs.<id>.steps[N].if`.
- **Errors while evaluating** (e.g. `fromJSON` of invalid JSON) fail that step, or that job, with `Error when evaluating 'if' for ...`. Dependents are skipped as for any failure. The same applies to `pre-if` and `post-if`.

```yaml
steps:
  - id: build
    run: echo "status=ok" >> $GITHUB_OUTPUT
  - if: ${{ steps.build.outputs.status == 'ok' }}
    run: echo "Build succeeded"
```

### Job dependencies (`needs:`)

Jobs declaring `needs:` are executed in dependency order (topological sort):

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [...]
  test:
    needs: build
    runs-on: ubuntu-latest
    steps: [...]
```

### Service containers (`jobs.<id>.services`)

Sidecar containers such as databases and caches start before the job's steps and are removed when the job ends (also on failure or Ctrl-C):

- **Container mode:** the job gets its own network. Each service joins it under its service id, so steps reach it by hostname (`postgres:5432`), as on GitHub.
- **Host mode** (`--container-runtime host`): services still run in containers (a container runtime is required). Steps reach them through their published `ports` on `localhost`.
- `image`, `env`, `ports`, `volumes` and `options` (e.g. `--health-cmd ...`) are supported. Steps start once every service with a health check reports healthy; an unhealthy service fails the job. `credentials` are ignored (log in with `docker login`).
- `${{ job.services.<id>.ports['5432'] }}` is the host port a container port is published on; `job.services.<id>.id` and `.network` are also set.

### Artifacts and caching

(`actions/upload-artifact`, `download-artifact`, `cache`)

These actions normally talk to GitHub's artifact and cache services, so the CLI runs local equivalents with the same inputs, outputs and path rules. Nothing is downloaded or sent anywhere:

- **`actions/upload-artifact`** stores files in `~/.secureci/artifacts/<run-id>/<name>/`, which is kept for 7 days. Path rules are the action's own: multi-line paths, globs, `!` exclusions, structure relative to the paths' common ancestor, and hidden files skipped unless `include-hidden-files: true`. `if-no-files-found` and `overwrite` (default `false`) are honoured. Outputs: `artifact-id`, `artifact-digest`.
- **`actions/download-artifact`** retrieves artifacts uploaded earlier in the same run (`github.run_id` is shared by all jobs and called workflows): `name` goes into `path`; without it, every artifact (or those matching `pattern`) goes into `path/<name>`, or straight into `path` with `merge-multiple: true`. Output: `download-path`.
- **`actions/cache`** restores the cache for `key` from `~/.secureci/step-cache/<owner_repo>/`, else the newest match for each `restore-keys` prefix, and saves it at the end of a successful job when there was no exact hit. Entries are immutable and versioned by `path`, as on GitHub. Outputs: `cache-hit` (`true` for an exact match, `false` for a `restore-keys` match, empty on a miss), `cache-primary-key`, `cache-matched-key`. `lookup-only` and `fail-on-cache-miss` are supported, as are `actions/cache/restore` and `actions/cache/save`.
- In container mode, workspace paths are read and written directly. Other paths, such as `~/.npm` inside the job container, are copied in and out of the container.

### Matrix builds (`strategy.matrix`)

A job runs once per matrix combination (sequentially), with `matrix.*` and `strategy.*` in its context and the combination in its name, e.g. `test (node: 20, os: linux)`:

- Combinations are expanded as on GitHub: the product of the axes, minus `exclude` matches (on all of an entry's keys), then `include` entries merged into every combination whose original values they don't change, or added as new combinations.
- The matrix, or any axis, can be an expression, e.g. `matrix: ${{ fromJSON(needs.setup.outputs.matrix) }}`.
- `fail-fast` (default `true`) skips the remaining combinations after a failure. Job-level `continue-on-error` (e.g. `${{ matrix.experimental }}`) lets a combination fail without failing the job, its dependents or the run.
- `max-parallel` is accepted but has no effect, since combinations run one after another.

### Reusable workflows (`jobs.<id>.uses:`)

A job that calls a reusable workflow runs the called workflow's jobs (in their own `needs:` order) as part of the run:

- `uses: ./.github/workflows/x.yml` resolves against the repository root, like on GitHub; `uses: owner/repo/.github/workflows/x.yml@ref` is downloaded and cached like a remote action (see [Remote Action Support](#remote-action-support)).
- `with:` and `secrets:` are evaluated in the calling job's context (`inputs`, `needs`, `vars`, ...); inputs fall back to their `on.workflow_call.inputs` defaults. The called workflow only sees the secrets passed to it (plus `GITHUB_TOKEN`), or all of them with `secrets: inherit`.
- `on.workflow_call.outputs` (e.g. `value: ${{ jobs.build.outputs.version }}`) become the calling job's outputs, available as `needs.<id>.outputs.*`.
- A workflow that can't be found or fetched fails the calling job.
- `strategy.matrix` on a calling job runs the workflow once per combination (`matrix.*` is available in `with:`); `needs.<id>.outputs` holds the last combination's outputs, as on GitHub.

### Shells and `defaults.run`

`run:` scripts are written to a file and run the way GitHub's runner does. With no `shell:`, that's `bash --noprofile --norc -eo pipefail {0}`, or `sh -e {0}` when bash isn't installed, so a step fails at its first failing command, including inside a pipeline. `shell: bash|sh|python|pwsh|powershell|cmd` map to GitHub's templates. Custom templates such as `shell: perl {0}` work too. `defaults.run.shell` and `defaults.run.working-directory` apply at workflow and job level; step-level values win, and they don't apply inside composite actions.

### Step outputs

Steps can write to `$GITHUB_OUTPUT` to expose values to later steps via `${{ steps.<id>.outputs.<name> }}`.

### File commands and workflow commands

Every step (`run:`, JavaScript and Docker actions) gets its own `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_PATH`, `$GITHUB_STATE` and `$GITHUB_STEP_SUMMARY` files. Values written to `$GITHUB_ENV` and directories written to `$GITHUB_PATH` are available to all later steps in the job (`$GITHUB_ENV` values also appear in `${{ env.* }}`). What steps write to `$GITHUB_STEP_SUMMARY` is printed at the end of the job.

Workflow commands printed to stdout are interpreted, in both the `::cmd::` and legacy `##[cmd]` syntax: `::add-mask::`, `::set-output`, `::save-state`, `::warning::`, `::error::`, `::notice::`, `::debug::`, `::group::`/`::endgroup::` and `::stop-commands::<token>` (nothing is interpreted until `::<token>::`). Problem matchers (`::add-matcher::`, `::remove-matcher::`) and `::echo::` are hidden.

Composite actions don't get the `secrets` context, as on GitHub: pass secrets to them as inputs.

### Events and the `github` context

```bash
secureci run .github/workflows/ci.yml --event-name pull_request --event-path event.json
```

- `github.event_name`: `--event-name`, else `$GITHUB_EVENT_NAME`, else `workflow_dispatch` if the workflow declares it, else the workflow's first trigger.
- `github.event`: the JSON object from `--event-path`, also written to `$GITHUB_EVENT_PATH`. Without it, `workflow_dispatch` gets `{ "inputs": {...} }` like on GitHub, and other events get `{}`.
- `github.repository` / `repository_owner`: `$GITHUB_REPOSITORY`, else the payload's `repository`, else parsed from the git `origin` remote, else the folder name. `github.sha` / `ref` come from `$GITHUB_SHA` / `$GITHUB_REF`, the payload's `ref`, or local git.
- `inputs.*`: `--input` values over the `default`s declared under `on.workflow_dispatch.inputs` / `on.workflow_call.inputs`.

### Default environment variables

Steps receive the runner's default variables, derived from the local `github` context: `CI`, `GITHUB_ACTIONS`, `GITHUB_WORKFLOW`, `GITHUB_JOB`, `GITHUB_SHA`, `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_EVENT_NAME`, `GITHUB_ACTOR`, `GITHUB_REPOSITORY`, `GITHUB_REPOSITORY_OWNER`, `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`, `GITHUB_WORKSPACE`, `GITHUB_EVENT_PATH` (see above), `RUNNER_OS`, `RUNNER_TEMP` and `RUNNER_TOOL_CACHE` (`~/.secureci/toolcache`).

### Secret masking

Any value passed via `--secret`, or registered by a step via `::add-mask::`, is automatically masked (`***`) wherever it appears in log output.

In container mode, env values (secrets included) never appear in the container client's command line: they're passed in a private env file (mode `0600`, deleted as soon as the client exits), or, for values an env file can't carry verbatim (multi-line, quote-leading or whitespace-padded), by name with the value in the client's environment. Prefer `--secret NAME` over `--secret NAME=value` so the value isn't in the `secureci` command line either.

## Remote action support

SecureCI supports fetching and executing remote GitHub Actions:

- **Composite Actions**: Full support for composite actions with multiple steps.
- **JavaScript Actions** (node12, node16, node20, node22+): Runs `main` with the CLI's own Node.js binary, in the workspace, with `INPUT_*` (from `with:` or the input's `default`), `GITHUB_ACTION_PATH` and the file commands above. `pre:` of remote actions runs at job start, before any step, gated by `pre-if` (local actions, which usually come from the checkout, run it right before `main`); `post:` runs at the end of the job in reverse order, gated by `post-if` (default `always()`), with state from `$GITHUB_STATE` exposed as `STATE_*`.
- **Docker Actions** (action type `runs.using: docker`): Builds the action's Dockerfile (or pulls a `docker://...` image) and runs it in its own container. Note: this is distinct from the job container that `--container-runtime` starts for `run:` steps and JavaScript actions.
- **Local Actions** (`uses: ./path/to/action`): Resolved relative to the workspace (the current directory), using `action.yml` or `action.yaml`.
- **`docker://` steps** (`uses: docker://alpine:3.20`): Run the image directly, with `with.args` as its arguments and `with.entrypoint` as its entrypoint.
- **Unresolvable actions fail the step**: A remote action that can't be fetched, a missing local action, or an unsupported `runs.using` fails the step (as on GitHub) instead of being skipped.
- **Action Caching**: Downloaded repositories are cached in `~/.secureci/actions-cache/<owner>/<repo>/<commit-sha>`. A tag or branch (`@v4`, `@main`) is resolved to its current commit on every run (`git ls-remote`, or the API with a token), so moving refs pick up new commits, and an unchanged commit is never downloaded twice. If a ref can't be resolved (offline, rate-limited), the last commit cached for it is used, with a warning. `--offline` uses only the cache. `secureci cache path` / `secureci cache clear` show and empty it.
- **Private actions**: With a token, downloads go through the GitHub API, so actions in private and internal repositories work and rate limits are higher. The token is `$GITHUB_TOKEN`, else `$GH_TOKEN`, else `gh auth token`. It's only sent to GitHub (not to a host a download redirects to), never passed to actions, and masked in logs. If GitHub rejects it (e.g. expired), the run continues without it. `GITHUB_SERVER_URL` / `GITHUB_API_URL` point downloads at GitHub Enterprise Server.

```bash
# Execute a workflow that uses remote actions
secureci run .github/workflows/ci.yml

# The workflow can include:
# - uses: actions/checkout@v3
# - uses: actions/setup-node@v3
# - uses: owner/repo/action@v1
```

## Architecture

```
src/
├── cli.ts                    # CLI entry point (commander)
├── config.ts                 # ~/.secureci/config.yml
├── init.ts                   # `secureci init` workflow generator
├── index.ts                  # Library exports
├── parser/
│   ├── workflow-parser.ts    # Parse workflow and action YAML
│   ├── validator.ts          # Validate syntax
│   ├── pipeline-contract-parser.ts     # Parse --contract files
│   └── pipeline-contract-validator.ts  # Check a workflow against a contract
├── runner/
│   ├── dry-run.ts            # Dry run mode
│   ├── executor.ts           # Run a workflow: jobs in needs: order, reusable workflows
│   ├── job-plan.ts           # Matrix expansion, needs: ordering
│   ├── github-context.ts     # github context, event payload, workflow inputs
│   ├── job-runtime.ts        # Per-job state, step files, post steps
│   ├── job-container.ts      # Job container, runs-on images, services, cleanup
│   ├── steps.ts              # run: steps, on the host or in the job container
│   ├── actions.ts            # uses: steps: dispatch, composite, built-ins, pre
│   ├── node-action.ts        # JavaScript actions (pre/main/post)
│   ├── docker-action.ts      # Docker actions and docker:// steps
│   ├── checkout.ts           # actions/checkout from the local working copy
│   ├── builtin-actions.ts    # Local upload/download-artifact and cache
│   ├── expression.ts         # ${{ ... }} expression evaluation
│   ├── hash-files.ts         # hashFiles() and glob matching
│   ├── runner-env.ts         # GITHUB_*/RUNNER_* env, file and workflow commands
│   ├── shell.ts              # shell: handling, argument splitting
│   ├── container-runtime.ts  # Docker/Podman/containerd CLI driver
│   └── action-fetcher.ts     # Fetch and cache remote actions by commit
├── utils/
│   ├── logger.ts             # Logging utility with secret masking
│   ├── key-value.ts          # --input/--secret/--env parsing
│   └── repository.ts         # Repository root for ./ references
└── types/
    └── index.ts              # TypeScript types
```

For a deeper walkthrough of the design, see [.github/agents/ARCHITECTURE.md](.github/agents/ARCHITECTURE.md).
