#!/usr/bin/env bash
# Scan every GitHub Actions workflow in an organisation with the SecureCI CLI,
# for a SecureCI supply-chain assessment.
#
#   bash org-scan.sh <org>
#
# Read it before you run it (it's short, on purpose):
#
#   curl -fsSL https://secure-ci.dev/org-scan.sh -o org-scan.sh
#   less org-scan.sh
#   GITHUB_TOKEN=... bash org-scan.sh my-org
#
# or, with the CLI installed: `secureci org scan my-org` runs this same script
# (`secureci org scan --print-script` prints it).
#
# What it does, for each repository in the organisation (or in --repos):
#
#   1. Clones only the .github/ directory (a shallow, sparse clone: your
#      application code is never downloaded) into a temporary directory.
#   2. Runs `secureci validate --format json` on its workflows, and
#      `secureci inventory --dry-run` on each workflow.
#   3. Saves that JSON under the output directory and deletes the clone.
#
# Then it writes manifest.json (what was scanned, when, with which versions)
# and packs everything into <output>.tar.gz. That archive is what you email to
# hello@secure-ci.dev (if your policy doesn't allow email, tell us and we'll
# agree another way).
# It holds only the JSON results (repository and workflow names, the actions
# they use, and the findings), never your source code. Look inside before you
# send it: `tar -tzf <output>.tar.gz`.
#
# Archived repositories are skipped, and so are forks unless --include-forks.
#
# Your token stays on this machine: it is passed to curl on stdin and to git
# through environment variables, never on a command line, and it is not
# written to any output file.
#
# Requirements: bash, git 2.31+, curl, base64, tar, and the SecureCI CLI
# (https://secure-ci.dev/install.sh or `npm install -g @secureci/cli`).
#
# Environment variables:
#   GITHUB_TOKEN or GH_TOKEN  token that can read the organisation's
#                             repositories (contents: read, metadata: read).
#                             Needed for private repositories, and it raises
#                             API rate limits. The CLI also uses it to resolve
#                             action tags and look up security advisories.
#   GITHUB_SERVER_URL         default https://github.com; set it for GitHub
#                             Enterprise Server, e.g. https://github.example.com
#   GITHUB_API_URL            default https://api.github.com, or
#                             $GITHUB_SERVER_URL/api/v3 for Enterprise Server
#   SECURECI                  the secureci executable (default: secureci on PATH)
#
# Exit status: 0 when the scan finished (some repositories may have failed:
# see the summary and errors.log), 1 on an error, 2 on a usage error.

set -euo pipefail

SCAN_SCRIPT_VERSION=1
INSTALL_URL="https://secure-ci.dev/install.sh"
NAME_RE='^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'

usage() {
  cat <<'EOF'
Usage: org-scan.sh [options] <org>

Scan every GitHub Actions workflow in <org> with the SecureCI CLI and pack the
JSON results into <output>.tar.gz for a SecureCI supply-chain assessment.

Options:
  --repos <file>     scan only these repositories: one per line, "name" or
                     "owner/name"; blank lines and # comments are ignored
  --out <dir>        output directory (default: ./secureci-org-scan-<org>)
  --contract <file>  also check workflows against this pipeline contract
                     (a local file, or owner/repo/path@ref)
  --include-forks    also scan forked repositories
  -h, --help         show this help

Environment: GITHUB_TOKEN (or GH_TOKEN), GITHUB_SERVER_URL, GITHUB_API_URL,
SECURECI. See the comments at the top of this script.
EOF
}

say() {
  printf 'secureci-org-scan: %s\n' "$*" >&2
}

die() {
  say "error: $*"
  exit 1
}

usage_error() {
  say "$*"
  usage >&2
  exit 2
}

has() {
  command -v "$1" >/dev/null 2>&1
}

# JSON string literal for $1.
json_str() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\n'/\\n}
  printf '"%s"' "$s"
}

# Run the secureci CLI (SECURECI_ENTRY is set when SECURECI is node itself).
secureci() {
  if [ -n "${SECURECI_ENTRY:-}" ]; then
    "$SECURECI" "$SECURECI_ENTRY" "$@"
  else
    "$SECURECI" "$@"
  fi
}

# GET an API URL into a file; prints the HTTP status. The token goes to curl
# on stdin (--config -), so it never shows up in the process list.
api_get() {
  local url=$1 out=$2
  {
    printf 'url = "%s"\n' "$url"
    printf 'header = "Accept: application/vnd.github+json"\n'
    printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
    if [ -n "$TOKEN" ]; then
      printf 'header = "Authorization: Bearer %s"\n' "$TOKEN"
    fi
  } | curl --silent --show-error --location --config - \
    --output "$out" --write-out '%{http_code}' || echo 000
}

# Print owner/name for each repository in a page of the repos API, skipping
# archived repositories and (unless --include-forks) forks. Splitting on
# commas puts each top-level key on its own line; keys inside strings are
# escaped (\"full_name\") and can't match the anchored patterns.
parse_repos() {
  tr ',' '\n' <"$1" | awk -v forks="$INCLUDE_FORKS" '
    function flush() {
      if (name != "" && archived != "true" && (forks == "1" || fork != "true"))
        print name
      name = ""; fork = ""; archived = ""
    }
    /^[[:space:]{[]*"full_name"[[:space:]]*:/ {
      flush()
      line = $0
      sub(/^[^:]*:[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      name = line
      next
    }
    /^[[:space:]]*"fork"[[:space:]]*:/ {
      fork = ($0 ~ /true/) ? "true" : "false"; next
    }
    /^[[:space:]]*"archived"[[:space:]]*:/ {
      archived = ($0 ~ /true/) ? "true" : "false"; next
    }
    END { flush() }
  '
}

# List the organisation's repositories over the API (or the user's, when
# <org> is a user account), one owner/name per line.
list_repos() {
  local base="$API_URL/orgs/$ORG/repos?per_page=100" page=1 status
  local body="$WORK/page.json"
  while :; do
    status=$(api_get "$base&page=$page" "$body")
    if [ "$status" = 404 ] && [ "$page" = 1 ] && [ "${base#*/users/}" = "$base" ]; then
      base="$API_URL/users/$ORG/repos?per_page=100&type=owner"
      continue
    fi
    [ "$status" = 200 ] || die "listing repositories for $ORG failed: HTTP $status from ${base%%\?*} (check GITHUB_TOKEN and GITHUB_API_URL)"
    # An empty page ends the listing.
    if ! grep -q '"full_name"' "$body"; then
      break
    fi
    parse_repos "$body"
    page=$((page + 1))
  done
}

# Repositories from a --repos file, one owner/name per line.
read_repo_file() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    line=$(printf '%s' "$line" | tr -d '[:space:]')
    [ -n "$line" ] || continue
    case "$line" in
      */*) printf '%s\n' "$line" ;;
      *) printf '%s/%s\n' "$ORG" "$line" ;;
    esac
  done <"$1"
}

# git with the token as an HTTP header scoped to the server, passed through
# GIT_CONFIG_* environment variables rather than arguments or a URL.
git_auth() {
  if [ -n "$TOKEN" ]; then
    local basic
    basic=$(printf 'x-access-token:%s' "$TOKEN" | base64 | tr -d '\n')
    GIT_CONFIG_COUNT=1 \
      GIT_CONFIG_KEY_0="http.$SERVER_URL/.extraheader" \
      GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic" \
      GIT_TERMINAL_PROMPT=0 git "$@"
  else
    GIT_TERMINAL_PROMPT=0 git "$@"
  fi
}

# Clone .github/ of one repository and scan it. Sets STATUS and WORKFLOWS.
scan_repo() {
  local full=$1 dir="$WORK/clone" dest wf files=()
  STATUS=clone-failed
  WORKFLOWS=0
  rm -rf "$dir"
  if ! git_auth clone --quiet --depth 1 --filter=blob:none --sparse --no-tags \
    "$SERVER_URL/$full.git" "$dir" 2>>"$OUT/errors.log" ||
    ! git -C "$dir" sparse-checkout set .github 2>>"$OUT/errors.log"; then
    echo "[$full] clone failed" >>"$OUT/errors.log"
    return
  fi

  for wf in "$dir"/.github/workflows/*.yml "$dir"/.github/workflows/*.yaml; do
    [ -f "$wf" ] && files+=(".github/workflows/${wf##*/}")
  done
  WORKFLOWS=${#files[@]}
  if [ "$WORKFLOWS" = 0 ]; then
    STATUS=no-workflows
    rm -rf "$dir"
    return
  fi

  dest="$OUT/repos/${full%%/*}__${full#*/}"
  mkdir -p "$dest/inventory"
  echo "[$full] secureci output:" >>"$OUT/errors.log"
  # validate exits 1 when it finds errors; the JSON is still the result.
  (cd "$dir" && secureci validate --format json ${CONTRACT_ARG:+--contract "$CONTRACT_ARG"} "${files[@]}") \
    >"$dest/validate.json" 2>>"$OUT/errors.log" || true
  for wf in "${files[@]}"; do
    (cd "$dir" && secureci inventory --dry-run "$wf") \
      >"$dest/inventory/${wf##*/}.json" 2>>"$OUT/errors.log" || true
  done
  STATUS=scanned
  rm -rf "$dir"
}

main() {
  ORG=""
  OUT=""
  REPO_FILE=""
  CONTRACT=""
  INCLUDE_FORKS=0
  while [ $# -gt 0 ]; do
    case "$1" in
      -h | --help) usage; exit 0 ;;
      --repos) [ $# -ge 2 ] || usage_error "--repos needs a file"; REPO_FILE=$2; shift 2 ;;
      --out) [ $# -ge 2 ] || usage_error "--out needs a directory"; OUT=$2; shift 2 ;;
      --contract) [ $# -ge 2 ] || usage_error "--contract needs a file"; CONTRACT=$2; shift 2 ;;
      --include-forks) INCLUDE_FORKS=1; shift ;;
      -*) usage_error "unknown option: $1" ;;
      *)
        [ -z "$ORG" ] || usage_error "unexpected argument: $1"
        ORG=$1; shift ;;
    esac
  done
  [ -n "$ORG" ] || usage_error "missing <org>"
  [[ $ORG =~ ^[A-Za-z0-9._-]+$ ]] || usage_error "not an organisation name: $ORG"

  SECURECI=${SECURECI:-secureci}
  for tool in git curl base64 tar; do
    has "$tool" || die "$tool is required"
  done
  has "$SECURECI" || die "the SecureCI CLI ($SECURECI) was not found. Install it: curl -fsSL $INSTALL_URL | sh (or npm install -g @secureci/cli)"
  SECURECI_VERSION=$(secureci --version 2>/dev/null) || die "could not run $SECURECI --version"

  TOKEN=${GITHUB_TOKEN:-${GH_TOKEN:-}}
  SERVER_URL=${GITHUB_SERVER_URL:-https://github.com}
  SERVER_URL=${SERVER_URL%/}
  if [ -z "${GITHUB_API_URL:-}" ]; then
    if [ "$SERVER_URL" = https://github.com ]; then
      API_URL=https://api.github.com
    else
      API_URL="$SERVER_URL/api/v3"
    fi
  else
    API_URL=${GITHUB_API_URL%/}
  fi

  # A local contract is resolved now, because secureci runs inside each clone.
  CONTRACT_ARG=$CONTRACT
  if [ -n "$CONTRACT" ] && [ -f "$CONTRACT" ]; then
    CONTRACT_ARG="$(cd "$(dirname "$CONTRACT")" && pwd -P)/$(basename "$CONTRACT")"
  fi
  if [ -n "$REPO_FILE" ] && [ ! -f "$REPO_FILE" ]; then
    die "--repos file not found: $REPO_FILE"
  fi

  OUT=${OUT:-secureci-org-scan-$ORG}
  OUT=${OUT%/}
  [ ! -e "$OUT" ] || die "$OUT already exists; remove it or pass --out <dir>"
  [ ! -e "$OUT.tar.gz" ] || die "$OUT.tar.gz already exists; remove it or pass --out <dir>"
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/secureci-org-scan.XXXXXX")
  trap 'rm -rf "$WORK"' EXIT

  local repos=() full
  if [ -n "$REPO_FILE" ]; then
    while IFS= read -r full; do repos+=("$full"); done < <(read_repo_file "$REPO_FILE")
  else
    say "listing repositories in $ORG ($API_URL)"
    list_repos >"$WORK/repos.txt"
    while IFS= read -r full; do repos+=("$full"); done <"$WORK/repos.txt"
  fi

  local valid=()
  for full in ${repos[@]+"${repos[@]}"}; do
    if [[ $full =~ $NAME_RE ]] && [[ $full != *..* ]]; then
      valid+=("$full")
    else
      say "skipping unexpected repository name: $full"
    fi
  done
  [ ${#valid[@]} -gt 0 ] || die "no repositories to scan"

  mkdir -p "$OUT/repos"
  : >"$OUT/errors.log"
  OUT=$(cd "$OUT" && pwd -P)

  local total=${#valid[@]} i=0 scanned=0 empty=0 failed=0 entries=""
  for full in "${valid[@]}"; do
    i=$((i + 1))
    scan_repo "$full"
    case "$STATUS" in
      scanned) scanned=$((scanned + 1)) ;;
      no-workflows) empty=$((empty + 1)) ;;
      *) failed=$((failed + 1)) ;;
    esac
    say "[$i/$total] $full: $STATUS ($WORKFLOWS workflows)"
    entries+="${entries:+,}
    {\"name\": $(json_str "$full"), \"status\": \"$STATUS\", \"workflows\": $WORKFLOWS}"
  done

  local contract_json=null
  [ -z "$CONTRACT" ] || contract_json=$(json_str "$CONTRACT")
  cat >"$OUT/manifest.json" <<EOF
{
  "tool": "secureci-org-scan",
  "scriptVersion": $SCAN_SCRIPT_VERSION,
  "secureciVersion": $(json_str "$SECURECI_VERSION"),
  "org": $(json_str "$ORG"),
  "server": $(json_str "$SERVER_URL"),
  "scannedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "contract": $contract_json,
  "repos": [$entries
  ]
}
EOF

  tar -czf "$OUT.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")"

  cat <<EOF

Scanned $total repositories in $ORG: $scanned scanned, $empty without workflows, $failed failed.

Results: $OUT/
Archive: $OUT.tar.gz

The archive holds only JSON results (repository and workflow names, the
actions they use and the findings) plus errors.log, never source code.
Check it before you send it:  tar -tzf $OUT.tar.gz

Email it to hello@secure-ci.dev. If your policy doesn't allow sending it by
email, write to us there and we'll agree another way.
EOF
}

main "$@"
