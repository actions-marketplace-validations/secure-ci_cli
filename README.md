# SecureCI

[![CI](https://github.com/secure-ci/cli/actions/workflows/ci.yaml/badge.svg)](https://github.com/secure-ci/cli/actions/workflows/ci.yaml)

Test and vet your GitHub Actions **before you push**.

`@secureci/cli` (the `secureci` command) runs your workflows locally, validates
them, and checks them against your organization's pipeline standards — without
committing, pushing, or waiting on a CI runner. It is the free, open-source part
of [SecureCI](https://secure-ci.dev).

> 📖 This README is the quick tour. Every flag, context and edge case lives in
> the **[full reference → DOCS.md](DOCS.md)**.

## What it is

A single CLI that understands GitHub Actions the way the runner does:

- **Run workflows locally** — jobs in `needs:` order (independent jobs and
  matrix combinations in parallel), matrix builds, reusable workflows, composite / JavaScript / Docker actions, and the full
  `${{ }}` / `if:` expression language.
- **Validate** workflow and action files, flag **template injection**
  (untrusted `${{ }}` input expanded into `run:` scripts), over-broad
  `GITHUB_TOKEN` permissions and `pull_request_target` / `workflow_run` jobs
  that run untrusted code, and **check them against a pipeline contract**
  (required/forbidden actions, ordering, minimum versions, SHA-pinning,
  permissions, forbidden triggers and advisory severity rules).
- **Inventory** every action a workflow pulls in, resolve each tag to a commit
  SHA, and **catch supply-chain drift** when a tag quietly starts pointing
  somewhere new.

Because it evaluates expressions and `if:` conditions like GitHub does — honoring
context-availability rules and rejecting invalid `if:` the same way — you get
far fewer false positives than plain pattern-matching tools.

## Install

```bash
npm install -g @secureci/cli
# or run without installing:
npx @secureci/cli --help
```

Node.js 20+ is required. To build from source instead:
`npm install && npm run build`.

### Standalone binary (no Node.js needed)

Each [release](https://github.com/secure-ci/cli/releases) has a single-file
binary for Linux (x64, arm64), macOS (Intel, Apple silicon) and Windows (x64),
a `SHA256SUMS` file, and a signed build-provenance attestation. Pick the asset
for your platform: `secureci-linux-x64`, `secureci-linux-arm64`,
`secureci-darwin-x64`, `secureci-darwin-arm64` or `secureci-win-x64.exe`.

```bash
# macOS / Linux (here: Linux x64)
asset=secureci-linux-x64
base=https://github.com/secure-ci/cli/releases/latest/download
curl -fsSL -O "$base/$asset" -O "$base/SHA256SUMS"
sha256sum --check --ignore-missing SHA256SUMS   # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS
gh attestation verify "$asset" --repo secure-ci/cli   # optional: verify provenance
chmod +x "$asset" && sudo mv "$asset" /usr/local/bin/secureci
secureci --version
```

```powershell
# Windows (PowerShell)
$base = "https://github.com/secure-ci/cli/releases/latest/download"
Invoke-WebRequest "$base/secureci-win-x64.exe" -OutFile secureci.exe
Invoke-WebRequest "$base/SHA256SUMS" -OutFile SHA256SUMS
$expected = (Select-String -Path SHA256SUMS -Pattern "secureci-win-x64.exe").Line.Split(" ")[0]
if ((Get-FileHash secureci.exe -Algorithm SHA256).Hash -ne $expected) { throw "Checksum mismatch" }
gh attestation verify secureci.exe --repo secure-ci/cli   # optional: verify provenance
.\secureci.exe --version
```

The binary bundles its own Node.js runtime, so it's large (~100 MB). JavaScript
actions still need a `node` on `PATH` when they run on the host
(`--container-runtime host`); in a job container they use the image's `node`.
The macOS binaries are ad-hoc signed and the Windows binary is unsigned, so
Gatekeeper or SmartScreen may ask you to confirm the first run (on macOS, a
`curl` download isn't quarantined).

Homebrew (coming): a `secure-ci/tap` formula is planned.

## First run

```bash
# See what a workflow would do, without running anything
secureci run .github/workflows/ci.yml --dry-run

# Run it for real (one container per job by default)
secureci run .github/workflows/ci.yml --input key=value

# Check a workflow's syntax
secureci validate .github/workflows/ci.yml

# Generate a ready-to-commit PR-checks workflow
secureci init workflow

# Lock the actions you use and catch supply-chain drift (commit secureci.lock)
secureci inventory            # bootstraps secureci.lock, then drift-checks
secureci inventory --check    # fail on drift (use in CI)

# Pin action tags to commit SHAs in place (keeps `# v4` for Dependabot/Renovate)
secureci pin
```

## Where it shines

- **Fast feedback loop** — iterate on a workflow in seconds instead of
  push-wait-repeat.
- **Enforce org-wide standards** — a platform team writes one
  [pipeline contract](DOCS.md#pipeline-contracts-validate---contract) ("every
  deploy must run `security-scan ≥ v1.2` first, pinned to a SHA") and every repo
  is checked against it, locally and in CI.
- **Supply-chain visibility** — [`secureci inventory`](DOCS.md#action-inventory-and-drift-secureci-inventory)
  with a committed lockfile turns a silently moved action tag into a failing
  check, including tags inside the actions you use, and catches a locked
  repository that was deleted and re-created, and
  [`secureci pin`](DOCS.md#pin-actions-to-commit-shas-secureci-pin) rewrites
  action tags to commit SHAs in place.
- **Known vulnerabilities** — `inventory` and `validate` flag actions with
  published [security advisories](DOCS.md#known-security-advisories) (for
  example GHSA-mrrh-fwg8-r2c3 in `tj-actions/changed-files`), using the GitHub
  Advisory Database.
- **Machine-readable output** — `--format json|sarif` drops straight into CI and
  GitHub code scanning.
- **Audit evidence** — the contract, `secureci.lock` and reports are plain files
  you can commit and keep. See
  [using output as audit evidence](DOCS.md#using-output-as-audit-evidence) and
  the [compliance mapping](https://secure-ci.dev/compliance) (PCI DSS, DORA,
  NIS2, ISO 27001, SOC 2 and more).

See the [reference](DOCS.md) for the complete command list and flags.

## Supported environments

Each job (and each matrix combination) runs in **one container**, started when
the job begins and removed when it ends. Every `run:` step and JavaScript action
in the job reuses it, so tools and files from earlier steps persist.

- **Container runtimes:** Docker (default), Podman, or containerd (via
  [`nerdctl`](https://github.com/containerd/nerdctl)) — selected with
  `--container-runtime`. The image follows `jobs.<id>.container`,
  `--container-image`, or a `runs-on` → runner-image mapping you can override in
  config.
- **Service containers** (`jobs.<id>.services`) — databases, caches and other
  sidecars start before the job, join its network (reachable by hostname like
  `postgres:5432`), wait for health checks, and are torn down with the job.
- **Host mode** (`--container-runtime host`) — an explicit opt-in to run steps
  directly on your machine (see [Security](#security)).

Details, image mapping and config: [DOCS.md → Container isolation](DOCS.md#container-isolation).

## Examples

```bash
# Run a single job with inputs and a repository variable
secureci run .github/workflows/ci.yml --job build --input ref=main --var ENV=staging

# Pass a secret by name (value read from your environment, not the command line)
secureci run .github/workflows/deploy.yml --secret TOKEN

# Read env vars, secrets, inputs and variables from .env-style files
secureci run .github/workflows/deploy.yml --env-file .env --secret-file .secrets

# Validate against a central pipeline contract, recursing into called workflows
secureci validate .github/workflows/deploy.yml \
  --contract contracts/platform-standard.yml --contract-recurse all

# Emit SARIF for GitHub code scanning
secureci validate .github/workflows/*.yml --format sarif > results.sarif

# Fail if any action drifted from the committed secureci.lock
secureci inventory --check

# Podman, a memory cap, and no network for the job containers
secureci run .github/workflows/ci.yml \
  --container-runtime podman --container-memory 512m --no-network
```

More patterns — events, matrices, artifacts, caching, reusable workflows, CI
usage — are in [DOCS.md](DOCS.md).

## Limitations

The CLI aims for high runner fidelity, but it is not the GitHub runner. The main
things to know:

- **Linux containers only.** `windows-*` / `macos-*` jobs run in a Linux image
  with a warning.
- **Jobs running in parallel share your working copy.** Each job has its own
  container, but every job mounts the same directory, so jobs that write the
  same files (e.g. `node_modules`) can collide; use `--parallel 1` to run jobs
  one after another.
- **`actions/checkout` of the current repo doesn't clone** — it uses your working
  copy as-is (so uncommitted changes are visible); `ref:`/`fetch-depth:` are
  ignored. Other repositories check out for real and need a token.
- **Artifacts and cache are local stand-ins**, stored under `~/.secureci/`;
  nothing is uploaded to or downloaded from GitHub.
- **Contract checks** don't evaluate `if:` conditions and, without
  `--contract-recurse all`, don't look inside _remote_ composite actions /
  reusable workflows.

The exact scope of each is documented in
[DOCS.md](DOCS.md#contract-limitations-v1-scope).

## Security

> [!WARNING]
> The CLI **never silently runs steps on your machine.** If the container
> runtime isn't available, it reports that and exits without running anything.

- **Sandboxed by default.** Steps and actions run in a container, not on your
  host.
- **Host mode is explicit.** Only `--container-runtime host` runs `run:` steps
  and third-party actions directly, with your user's privileges — the CLI warns
  and lists the remote actions first.
- **No ambient environment or secrets.** On the host, steps get only a minimal
  allowlist plus the runner's `GITHUB_*`/`RUNNER_*` vars and the workflow's own
  `env:`; everything else is passed explicitly.
- **Secret masking everywhere.** Values from `--secret`, `--secret-file` or
  `::add-mask::` are redacted in all output, and in container mode never appear
  on the client command line (passed via a `0600` env file). Prefer
  `--secret NAME` so the value stays out of your shell history too.
- **Tokens are handled carefully** — sent only to the GitHub host in
  `GITHUB_SERVER_URL` / `GITHUB_API_URL` (github.com by default), never passed
  to actions, and masked in logs.

### What the package accesses, and why

Installing and running `secureci` involves these capabilities. Each is needed for
the feature named, and none runs at install time.

| Capability               | Where                                                                  | Why                                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell / process spawning | `run:` steps, JavaScript actions, `docker`/`podman`/`nerdctl`          | Runs workflow steps in a container (or on your host with `--container-runtime host`). `commander` also loads `child_process`, used only for executable subcommands this CLI does not use. |
| Network                  | `github.com`, `api.github.com` (or the GHES host you set)              | Downloads actions and workflows, resolves tags to commit SHAs, and looks up security advisories for the actions you use (skipped with `--offline`).                                       |
| Environment variables    | `HOME`, `PATH`, `GITHUB_*`, `GITHUB_TOKEN`, `GH_TOKEN`                 | Builds the runner environment and authenticates GitHub downloads.                                                                                                                         |
| Filesystem               | `~/.secureci/`, the working directory, temp dirs                       | Caches actions and advisories, stores artifacts and config, and reads your workflow files.                                                                                                |
| Hard-coded URLs          | GitHub documentation and JSON Schema URLs in messages and editor hints | Informational only; the CLI does not fetch them.                                                                                                                                          |

No install scripts run for consumers. The published tarball contains only
`dist/`, `README.md`, and `LICENSE`. See [SECURITY.md](SECURITY.md) for how to
report a vulnerability.

Full details: [DOCS.md → Security: what runs where](DOCS.md#security-what-runs-where)
and [Secret masking](DOCS.md#secret-masking).

## Development & testing

```bash
npm install        # install dependencies
npm run build      # compile TypeScript
npm test           # run the Vitest suite
npm run test:watch # watch mode
npm run lint       # ESLint
npm run format     # Prettier
```

This project follows **TDD**: write the test first, implement to pass it, then
refactor while keeping tests green.

Every pull request and push to `main` runs
[`ci.yaml`](.github/workflows/ci.yaml): lint, `prettier --check`, tests with the
coverage thresholds in `vitest.config.mts`, build, and SecureCI
validating its own workflow. It also builds the standalone binary on each
platform and smoke-tests it (`npm run build && npm run build:sea` builds one
for your machine into `build/sea/`).

Opt-in suites:

- `RUN_DOCKER_TESTS=1 npm test` — real-engine container tests (needs a running
  Docker daemon).
- `RUN_NETWORK_TESTS=1 npm test` — tests that fetch real actions from GitHub.

Want to contribute? See **[CONTRIBUTING.md](CONTRIBUTING.md)**. Deep-dives for
humans and agents live in [AGENTS.md](AGENTS.md) and
[.github/agents/](.github/agents/).

## License

The code is licensed under the [MIT License](LICENSE).

## Name and trademark

The **code** is open source under MIT; the **SecureCI name and logo** are not.
"SecureCI", the `secureci` command branding, and the `@secureci` npm scope are
trademarks of SecureCI. You may use the name to describe your use of this
software (for example, "works with SecureCI"), but you may not use it to name or
brand a fork, a derivative product or service, or a hosted offering, and you may
not imply endorsement by SecureCI. Forks must use a different name and must not
publish under the `@secureci` scope. These rights are reserved and are not granted by the
MIT License.
