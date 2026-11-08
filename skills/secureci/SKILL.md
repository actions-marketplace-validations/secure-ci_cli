---
name: secureci
description: Set up SecureCI (`@secureci/cli`) in a repo — pin every action to a commit SHA (`secureci pin`), commit a `secureci.lock` (`secureci inventory`), and insert the `secure-ci/cli` action as a step in an existing workflow job so PRs run `secureci validate` plus `inventory --check`. Also replaces an existing `actionlint` step. Load when the user asks to validate or lint GitHub Actions workflows, add SecureCI / secureci, replace actionlint, pin actions to SHAs, lock actions or catch tag drift. Do not load for creating a new top-level workflow file (use `secureci init workflow` or a workflow skill), or for running a workflow locally (`secureci run`, see DOCS.md).
---

# `secureci`

Sets up [SecureCI](https://github.com/secure-ci/cli) in the current repo:

1. `secureci pin` — rewrite action tags to commit SHAs (keeps a `# vX` comment).
2. `secureci inventory` — write `secureci.lock` (every action, transitive ones
   too, resolved to a commit) and commit it.
3. Insert the [`secure-ci/cli`](https://github.com/secure-ci/cli) composite
   action as a **step in an existing job**, with `inventory: check`, so every PR
   runs `secureci validate` and fails on a moved tag.

Prose-only: you (the agent) read the repo, show diffs and confirm with the user
before every write.

The canonical reference is [DOCS.md](https://github.com/secure-ci/cli/blob/main/DOCS.md)
in `secure-ci/cli` — sections "Pin actions to commit SHAs", "Action inventory and
drift" and "Use in CI (GitHub Action)". If this file and DOCS.md disagree, trust
DOCS.md.

## When to load this skill

Load when the user's prompt mentions any of:

- "secureci", "SecureCI", "`@secureci/cli`", "`secure-ci/cli`"
- "validate / lint workflows", "validate GitHub Actions YAML"
- "replace actionlint", "actionlint" (offer SecureCI as the replacement)
- "pin actions to SHAs", "lock actions", "action drift", "moved tags"

Do not load for:

- Creating a new top-level workflow — `secureci init workflow` writes a
  dedicated `.github/workflows/secureci.yml`; mention it and stop.
- Running a workflow locally — that's `secureci run <file> [--dry-run]`.
- Pipeline contracts (`--contract`) beyond passing an existing one through.

## Requirements

- Node.js 20+ for `npx @secureci/cli` (or a [standalone binary](https://github.com/secure-ci/cli/releases)).
- Network access to GitHub for `pin` and `inventory` (tags are resolved with
  `git ls-remote` or the API). Set `GITHUB_TOKEN` / `GH_TOKEN` (or be logged in
  with `gh`) on repos with many actions — anonymous API calls are capped at 60/h.

Below, `secureci` means `npx @secureci/cli` when it isn't installed.

## Conversation flow

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
   `ubuntu-*`). If an `actionlint` step exists, propose replacing it in place.
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
   - uses: secure-ci/cli@<40-char-sha> # v0.9.0
     with:
       inventory: check
       upload-sarif: false
   ```

   - There is no moving major tag (`@v1`, `@v0`); use a release tag's SHA.
   - `upload-sarif: false` keeps the job's existing permissions. Offer the
     opt-in: drop that line and add `security-events: write` to the job's
     `permissions:` to get findings inline on the PR via code scanning.
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

| Situation                                       | Action                                                                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| No workflow files                               | Stop at step 2; suggest `secureci init workflow`.                                                                          |
| SecureCI already wired                          | Don't duplicate; offer only missing pin / lock / `inventory: check`.                                                       |
| `actionlint` wired via a reusable/composite ref | Replace that step with the SecureCI step; leave the upstream action's repo alone.                                          |
| Target job is a reusable-workflow caller        | It has no `steps:`; pick another job or suggest `secureci init workflow`.                                                  |
| Non-Linux runner only                           | The action is bash + `npx`; prefer an `ubuntu-*` job, or add a small one.                                                  |
| Rate-limited during `pin` / `inventory`         | Set `GITHUB_TOKEN` / `GH_TOKEN` or `gh auth login`, then retry.                                                            |
| `pin` reports unresolvable refs                 | Left unchanged; `pin --check` fails. Ask the user to fix or remove each ref.                                               |
| Only `.github/workflows/actions.lock` exists    | Ask before `--update-lock` (it switches to `secureci.lock`). Without it, `inventory: check` checks against `actions.lock`. |
| Org owns actions it wants on tags               | Use a contract with `pins.allow`, then `secureci pin --contract <file>`; see DOCS.md "Supply-chain pinning".               |

## Reference

- Repo: [`secure-ci/cli`](https://github.com/secure-ci/cli) · npm: [`@secureci/cli`](https://www.npmjs.com/package/@secureci/cli)
- [DOCS.md](https://github.com/secure-ci/cli/blob/main/DOCS.md) — full CLI reference
- [`action.yml`](https://github.com/secure-ci/cli/blob/main/action.yml) — action inputs (`files`, `contract`, `contract-recurse`, `format`, `output`, `upload-sarif`, `inventory`, `version`, `github-token`)
- Install this skill: `npx skills add secure-ci/cli --skill secureci`
