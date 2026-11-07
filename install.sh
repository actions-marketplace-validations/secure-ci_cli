#!/bin/sh
# Install the SecureCI CLI standalone binary on Linux or macOS.
#
#   curl -fsSL https://secure-ci.dev/install.sh | sh
#
# Prefer to read it first (recommended for a security tool):
#
#   curl -fsSL https://secure-ci.dev/install.sh -o install.sh
#   less install.sh
#   sh install.sh
#
# What it does: picks the binary for this OS and CPU from the GitHub release,
# checks it against the release's SHA256SUMS (a mismatch aborts), verifies its
# build-provenance attestation when the GitHub CLI (gh) is signed in, then
# installs it as `secureci`. It never uses sudo.
#
# Environment variables:
#   SECURECI_VERSION              release to install, e.g. 0.10.0 (default: latest)
#   SECURECI_INSTALL_DIR          where to put `secureci` (default: ~/.local/bin)
#   SECURECI_REQUIRE_ATTESTATION  1 = fail unless gh verifies build provenance
#   SECURECI_DOWNLOAD_BASE        releases URL, for mirrors and tests
#                                 (default: https://github.com/secure-ci/cli/releases)
#
# Windows: see https://secure-ci.dev/docs#standalone-binary-no-nodejs-needed
#
# Everything runs inside main(), called on the last line, so a download cut
# off part-way through never runs a partial script.

set -eu

REPO="secure-ci/cli"
DOCS_URL="https://secure-ci.dev/docs#standalone-binary-no-nodejs-needed"

say() {
  printf 'secureci-install: %s\n' "$*" >&2
}

die() {
  say "error: $*"
  exit 1
}

has() {
  command -v "$1" >/dev/null 2>&1
}

detect_asset() {
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    MINGW* | MSYS* | CYGWIN* | Windows*)
      die "this script doesn't install on Windows. Download secureci-win-x64.exe instead: $DOCS_URL"
      ;;
    *) die "unsupported operating system: $os (Linux and macOS are supported; see $DOCS_URL)" ;;
  esac

  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "unsupported architecture: $arch (x64 and arm64 are supported)" ;;
  esac

  # An x64 shell under Rosetta on Apple silicon: install the native binary.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi

  echo "secureci-$os-$arch"
}

download() {
  # $1 = URL, $2 = output file. HTTPS only, including redirects (file:// is
  # allowed for SECURECI_DOWNLOAD_BASE mirrors and tests).
  if has curl; then
    curl -fsSL --proto '=https,file' --proto-redir '=https' -o "$2" "$1" ||
      die "download failed: $1"
  elif has wget; then
    wget -q --https-only -O "$2" "$1" || die "download failed: $1"
  else
    die "curl or wget is required"
  fi
}

sha256_of() {
  if has sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif has shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify the download"
  fi
}

verify_attestation() {
  # $1 = file. Build provenance proves the binary was built by this repo's CI;
  # the checksum alone only proves it matches the release's SHA256SUMS.
  if has gh && gh auth status >/dev/null 2>&1; then
    gh attestation verify "$1" --repo "$REPO" >/dev/null ||
      die "build-provenance attestation did not verify; not installing"
    say "build provenance verified (gh attestation verify)"
  elif [ "${SECURECI_REQUIRE_ATTESTATION:-}" = 1 ]; then
    die "SECURECI_REQUIRE_ATTESTATION=1 but the GitHub CLI (gh) isn't installed and signed in"
  else
    say "note: GitHub CLI not signed in, so build provenance wasn't checked. To check it:"
    say "  gh attestation verify \"\$(command -v secureci)\" --repo $REPO"
  fi
}

main() {
  base=${SECURECI_DOWNLOAD_BASE:-https://github.com/$REPO/releases}
  version=${SECURECI_VERSION:-latest}
  install_dir=${SECURECI_INSTALL_DIR:-}
  [ -n "$install_dir" ] || install_dir="$HOME/.local/bin"

  if [ "$version" = latest ]; then
    url="$base/latest/download"
  else
    version=${version#v}
    case "$version" in
      *[!0-9A-Za-z.-]* | "") die "invalid SECURECI_VERSION: $version" ;;
    esac
    url="$base/download/v$version"
  fi

  asset=$(detect_asset)
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 130' INT TERM

  say "downloading $asset ($version)"
  download "$url/$asset" "$tmp/$asset"
  download "$url/SHA256SUMS" "$tmp/SHA256SUMS"

  expected=$(awk -v a="$asset" '$2 == a || $2 == "*" a { print $1; exit }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || die "$asset is not listed in SHA256SUMS; not installing"
  actual=$(sha256_of "$tmp/$asset")
  [ "$actual" = "$expected" ] ||
    die "checksum mismatch for $asset (expected $expected, got $actual); not installing"
  say "checksum OK ($actual)"

  verify_attestation "$tmp/$asset"

  mkdir -p "$install_dir" 2>/dev/null ||
    die "can't create $install_dir; set SECURECI_INSTALL_DIR to a directory you can write to"
  [ -w "$install_dir" ] ||
    die "can't write to $install_dir; set SECURECI_INSTALL_DIR to a directory you can write to"
  # Copy next to the target, then rename: an existing secureci is replaced in
  # one step, never left half-written.
  cp "$tmp/$asset" "$install_dir/.secureci.tmp.$$"
  chmod 755 "$install_dir/.secureci.tmp.$$"
  mv -f "$install_dir/.secureci.tmp.$$" "$install_dir/secureci"

  say "installed $install_dir/secureci"
  "$install_dir/secureci" --version

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) say "add $install_dir to your PATH, e.g.: export PATH=\"$install_dir:\$PATH\"" ;;
  esac
}

main "$@"
