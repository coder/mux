#!/usr/bin/env bash

# Downloads pinact and runs it to pin all GitHub Actions to SHA hashes.
# Usage: ./pin-actions.sh [files...]
#
# If no files are specified, defaults to all workflow and action files.

set -euo pipefail

VERSION="v3.8.0"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Detect OS and architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
esac

# Download pinact
TARBALL="pinact_${OS}_${ARCH}.tar.gz"
curl -sSfL "https://github.com/suzuki-shunsuke/pinact/releases/download/${VERSION}/${TARBALL}" | tar xz -C "$TMPDIR"

# Run pinact with GitHub token
export GITHUB_TOKEN="${GH_TOKEN:-$(gh auth token)}"
"$TMPDIR/pinact" run "$@"
