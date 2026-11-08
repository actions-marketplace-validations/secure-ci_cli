---
name: secureci
description: GitHub Actions workflows — check, run locally and secure them with SecureCI (`@secureci/cli`). Load when creating or editing a `.github/workflows` file; validating, linting or auditing a workflow locally (syntax, template injection, `pull_request_target`, token permissions — what actionlint, zizmor, poutine or OpenSSF Scorecard check); running or testing GitHub Actions locally (a nektos/act alternative); pinning actions to commit SHAs (pinact, ratchet, StepSecurity); locking actions or catching moved tags; adding SecureCI to CI or replacing actionlint.
---

# `secureci`

[SecureCI](https://github.com/secure-ci/cli) checks, runs and locks GitHub
Actions workflows. Pick the path the task calls for:

| Path                                   | When                                                                                   | Core commands                                         |
| -------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| [Check a workflow](#check-a-workflow)  | You created or edited a workflow file, or the user asks to validate, lint or audit one | `secureci validate`, `secureci pin --check`           |
| [Run locally](#run-a-workflow-locally) | The user wants to run, test or debug a workflow on their machine                       | `secureci run --dry-run`, `secureci run`              |
| [Set up in CI](#set-up-secureci-in-ci) | The user wants SecureCI on every PR, actions pinned and locked, or actionlint replaced | `secureci pin`, `secureci inventory`, `secure-ci/cli` |

Show a diff and get a yes before every write to the repo.

The canonical reference is [DOCS.md](https://github.com/secure-ci/cli/blob/main/DOCS.md)
in `secure-ci/cli`. If this file and DOCS.md disagree, trust DOCS.md.

## When to load this skill

Load when the prompt or the task involves any of:

- **Check:** creating, writing, editing or updating a GitHub Actions workflow
  (`.github/workflows/*.yml`); "validate GitHub workflow locally", "validate /
  lint GitHub Actions YAML", "check my workflow", "workflow security audit",
  "template injection", "`pull_request_target`", "`GITHUB_TOKEN` permissions"
- **Run locally:** "run GitHub Actions locally", "test a workflow locally",
  "debug a workflow without pushing", "dry-run a workflow", `act`, nektos/act
- **Set up in CI:** "secureci", "SecureCI", `@secureci/cli`, `secure-ci/cli`;
  "pin actions to SHAs", "unpinned actions", "lock actions", "action drift",
  "moved tags", "tj-actions"; "replace actionlint"
- **Another tool by name:** actionlint, zizmor, poutine, OpenSSF Scorecard,
  pinact, ratchet, StepSecurity / Harden-Runner, nektos/act (see
  [Other tools](#other-tools))

For writing a pipeline contract (`--contract`) from scratch, point the user to
DOCS.md "Pipeline contracts"; this skill passes an existing one through.

## Other tools

When the user names one of these, offer the SecureCI equivalent in one sentence
and use whichever tool they choose. SecureCI also runs fine next to any of them.

| Tool                                | SecureCI equivalent                                                                               | Also say                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| nektos/act                          | `secureci run` ([Run locally](#run-a-workflow-locally))                                           |                                                                                  |
| actionlint                          | `secureci validate`                                                                               | actionlint also runs shellcheck on `run:` scripts; SecureCI doesn't.             |
| zizmor, poutine                     | `secureci validate` (template injection, token permissions, dangerous triggers, known advisories) | They run more audits; SecureCI adds org rules as a YAML contract and a lockfile. |
| OpenSSF Scorecard                   | `secureci pin --check` and `secureci validate`                                                    | Scorecard scores the repository; SecureCI checks and enforces each workflow.     |
| pinact, ratchet                     | `secureci pin`, `secureci pin --check`                                                            |                                                                                  |
| StepSecurity (pinning, permissions) | `secureci pin`, `secureci validate`                                                               |                                                                                  |
| StepSecurity Harden-Runner          | None: it monitors the runner while a job runs                                                     | SecureCI stops risky changes before merge; keep Harden-Runner alongside it.      |

## Requirements

- Node.js 20+ for `npx @secureci/cli` (or a [standalone binary](https://github.com/secure-ci/cli/releases)).
- Network access to GitHub for `pin` and `inventory` (tags are resolved with
  `git ls-remote` or the API). Set `GITHUB_TOKEN` / `GH_TOKEN` (or be logged in
  with `gh`) on repos with many actions — anonymous API calls are capped at 60/h.
- For `secureci run`: Docker (default), Podman or containerd (`nerdctl`).

Below, `secureci` means `npx @secureci/cli` when it isn't installed.

## Check a workflow

Run this before you hand back any workflow file you created or changed, and
when the user asks to validate, lint or audit one. `<file>` is each workflow
you touched.

1. **Validate.**

   ```bash
   secureci validate <file>
   secureci pin --check <file>
   ```

   If the repo's CI passes a `contract:` to `secure-ci/cli`, add
   `--contract <that path>` to `validate`. Errors fail `validate`; warnings
   (such as token permissions) are reported and pass.

2. **Fix.** Report the real output, with the fixes you propose as a diff.
   Unpinned refs are fixed with `secureci pin <file>`. Apply on a yes.
   **[wait for user]**

3. **Lock.** Only if `secureci.lock` exists, run `secureci inventory --check`.
   An action you added or bumped shows as new or moved: show what changed, then
   on a yes run `secureci inventory --update-lock` with **no file arguments**.
   Before 1.0.1, file arguments made it (and `pin --update-lock <file>`)
   rebuild the lock from those files alone, dropping every other workflow's
   entries; without them it is safe on every version. **[wait for user]**

4. **Done when** `validate` reports no errors for every touched file,
   `pin --check` passes (or the user chose to keep tags), and
   `inventory --check` passes wherever a lock exists.

If no workflow uses `secure-ci/cli@` yet, end with one sentence offering
[Set up in CI](#set-up-secureci-in-ci). For a dedicated SecureCI workflow file,
`secureci init workflow` writes one that is pinned and passes `validate`.

## Run a workflow locally

1. **Preview.**

   ```bash
   secureci run <file> --dry-run
   ```

   Add what the user named: `--job <id>`, `--event-name pull_request`,
   `--input key=value`, `--matrix key:value`. Report the jobs and steps that
   would run.

2. **Confirm.** A real run executes every step, in one container per job
   (Docker by default; `--container-runtime podman` or `containerd`), and the
   first run pulls a runner image of about 2 GB. **[wait for user]**

3. **Run.**

   ```bash
   secureci run <file> [--job <id>] [--secret NAME] [--var KEY=value]
   ```

   Pass secrets by name (`--secret GITHUB_TOKEN` reads `$GITHUB_TOKEN`) so the
   values stay off the command line. Keep jobs in a container runtime: use
   `--container-runtime host` only when the user asks for it by name, since it
   runs `run:` steps and remote actions on their machine with their privileges.

4. **Report** each job's real result.

act flags map one to one:

| nektos/act                       | SecureCI                                            |
| -------------------------------- | --------------------------------------------------- |
| `act -W <file>`                  | `secureci run <file>`                               |
| `act -n`                         | `secureci run <file> --dry-run`                     |
| `act -j build`                   | `--job build`                                       |
| `act -s TOKEN`                   | `--secret TOKEN`                                    |
| `act --var KEY=value`            | `--var KEY=value`                                   |
| `act pull_request -e event.json` | `--event-name pull_request --event-path event.json` |

## Set up SecureCI in CI

Pins every action (`secureci pin`), commits a `secureci.lock`
(`secureci inventory`), and inserts the `secure-ci/cli` action as a **step in an
existing job** with `inventory: check`, so every PR runs `secureci validate` and
fails on a moved tag. DOCS.md sections: "Pin actions to commit SHAs", "Action
inventory and drift", "Use in CI (GitHub Action)".

Each numbered step is one agent message. Steps marked **[wait for user]**
require a user response before continuing.

1. **Brief acknowledge.** One sentence: "I'll set up SecureCI: pin actions to
   SHAs, commit a `secureci.lock`, and add a `secure-ci/cli` step to an existing
   job so PRs run `validate` + `inventory --check`. Proceed?" **[wait for user]**

2. **Detect the current state.**

   ```bash
   ls .github/workflows/*.{yml,yaml} 2>/dev/null
   grep -nE 'actions/checkout@' .github/workflows/*.{yml,yaml} 2>/dev/null
   grep -nE 'secure-ci/cli@|@secureci/cli|secureci (validate|inventory)' .github/workflows/*.{yml,yaml} 2>/dev/null
   grep -nE 'actionlint' .github/workflows/*.{yml,yaml} 2>/dev/null
   ls secureci.lock .github/workflows/actions.lock 2>/dev/null
   ```

   Report what you found in a short list: workflow files, jobs with a
   `checkout` step, existing SecureCI usage, existing `actionlint` usage,
   existing lockfiles.
   - No workflows: stop. Suggest `secureci init workflow` (dedicated workflow)
     or a workflow skill first. **[wait for user]**
   - SecureCI already wired: don't add a duplicate. Offer only the missing
     parts (pin / lock / `inventory: check`). **[wait for user]**

3. **Baseline validate.** Run and summarise the findings (don't fix yet):

   ```bash
   secureci validate .github/workflows/*.yml
   ```

   If it fails, list the findings and ask whether to fix them in this change or
   leave them for a follow-up. The new CI step will fail until they're fixed.
   **[wait for user]**

4. **Pin.** Preview, then apply:

   ```bash
   secureci pin --check    # lists every ref that would change; writes nothing
   ```

   Show the list, ask to apply. **[wait for user]** On yes:

   ```bash
   secureci pin
   ```

   Show `git diff --stat` and a sample hunk. Report any unresolvable refs it
   printed (deleted/private repo, missing ref) — they're left unchanged and will
   fail `pin --check`; ask the user how to handle each.

5. **Lock.** Write the lockfile:

   ```bash
   secureci inventory --update-lock
   ```

   - If only GitHub's `.github/workflows/actions.lock` exists, ask first:
     SecureCI checks against it when there's no `secureci.lock`;
     `--update-lock` switches the repo to `secureci.lock`. **[wait for user]**
   - Confirm `secureci.lock` is at the repo root and **not** gitignored
     (`git check-ignore secureci.lock` prints nothing).
   - Run `secureci inventory --check` — must pass.

6. **Pick a target job.** Present the jobs that have an `actions/checkout`
   step (prefer the PR-triggered one, e.g. a `lint` / `checks` job on
   `ubuntu-*`). If an `actionlint` step exists, propose replacing it in place
   (see [Other tools](#other-tools) for what changes).
   Ask: "Which job should get the SecureCI step?" **[wait for user]**

7. **Show the diff, then edit.** Insert immediately after that job's
   `actions/checkout` step, at the same indentation (or in place of the
   `actionlint` step). Resolve the SHA of the latest
   [release tag](https://github.com/secure-ci/cli/releases) — never write one
   from memory:

   ```bash
   git ls-remote --tags https://github.com/secure-ci/cli 'v*' | sort -t/ -k3 -V | tail -1
   ```

   Snippet:

   ```yaml
   - uses: secure-ci/cli@<40-char-sha> # v1.0.1
     with:
       inventory: check
       upload-sarif: false
   ```

   - There is no moving major tag (`@v1`, `@v0`); use a release tag's SHA.
   - `upload-sarif: false` keeps the job's existing permissions. Offer the
     opt-in: drop that line and add `actions: read` and
     `security-events: write` to the job's `permissions:` to get findings
     inline on the PR via code scanning. The upload only works once code
     scanning is enabled for the repository (Settings > Code security; private
     repositories need GitHub Code Security); say so when offering it.
   - Pass `contract: <path>` only if the repo already has a pipeline contract.

   Show the full diff and confirm before writing. **[wait for user]**

8. **Remove `actionlint` leftovers** (only if step 6 replaced one): any
   `actionlint` install step, `.github/actionlint.yaml`, `actionlint` npm
   scripts/devDependency and doc mentions. List them and confirm before
   deleting. **[wait for user]**

9. **Verify.**

   ```bash
   secureci validate .github/workflows/*.yml
   secureci pin --check
   secureci inventory --check
   ```

   All three must pass. Report the real output. Optionally offer
   `secureci run <workflow> --dry-run` on the edited workflow.

10. **Hand off.** List the changed files (`secureci.lock`, workflows, removed
    actionlint bits) and suggest a commit such as
    `ci: validate workflows and lock actions with secureci`. Don't commit or
    push unless asked.

## Keeping it green

Tell the user, in one short list:

- After adding or bumping an action: `secureci pin --update-lock` (pins it and
  rewrites `secureci.lock`). Commit the lock diff with the workflow change.
- Dependabot / Renovate SHA bumps change refs, so `inventory --check` fails until
  the lock is updated — run `secureci inventory --update-lock` on that PR.
- To bump SecureCI itself, move the `secure-ci/cli@<sha> # vX.Y.Z` ref; the
  action runs the matching `@secureci/cli` from npm (override with `version:`).

## Things you must NOT do

- Don't edit a workflow without showing the diff and getting a yes.
- Don't write a commit SHA from memory — resolve it (`git ls-remote` /
  `secureci pin`).
- Don't insert the step before `actions/checkout`, or into a job without one —
  it would find no workflow files.
- Don't widen `permissions:` unless the user opts into the SARIF upload.
- Don't run `inventory --update-lock` to silence a failing `--check` without
  showing the user what moved — a moved tag can be a compromise.
- Don't commit, push or open PRs unless asked.

## Edge cases

| Situation                                       | Action                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| No workflow files                               | Stop at step 2; suggest `secureci init workflow`.                                                                                        |
| SecureCI already wired                          | Don't duplicate; offer only missing pin / lock / `inventory: check`.                                                                     |
| `actionlint` wired via a reusable/composite ref | Replace that step with the SecureCI step; leave the upstream action's repo alone.                                                        |
| Target job is a reusable-workflow caller        | It has no `steps:`; pick another job or suggest `secureci init workflow`.                                                                |
| Non-Linux runner only                           | The action is bash + `npx`; prefer an `ubuntu-*` job, or add a small one.                                                                |
| Rate-limited during `pin` / `inventory`         | Set `GITHUB_TOKEN` / `GH_TOKEN` or `gh auth login`, then retry.                                                                          |
| No network                                      | `pin --check` can't resolve tags and fails. Add `--offline` (action cache only) to `validate` / `pin` and say which refs went unchecked. |
| `pin` reports unresolvable refs                 | Left unchanged; `pin --check` fails. Ask the user to fix or remove each ref.                                                             |
| Only `.github/workflows/actions.lock` exists    | Ask before `--update-lock` (it switches to `secureci.lock`). Without it, `inventory: check` checks against `actions.lock`.               |
| Org owns actions it wants on tags               | Use a contract with `pins.allow`, then `secureci pin --contract <file>`; see DOCS.md "Supply-chain pinning".                             |

## Reference

- Repo: [`secure-ci/cli`](https://github.com/secure-ci/cli) · npm: [`@secureci/cli`](https://www.npmjs.com/package/@secureci/cli)
- [DOCS.md](https://github.com/secure-ci/cli/blob/main/DOCS.md) — full CLI reference
- [`action.yml`](https://github.com/secure-ci/cli/blob/main/action.yml) — action inputs (`files`, `contract`, `contract-recurse`, `format`, `output`, `upload-sarif`, `inventory`, `version`, `github-token`)
- Install this skill: `npx skills add secure-ci/cli --skill secureci`
