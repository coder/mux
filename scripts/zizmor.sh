#!/usr/bin/env bash

# Usage: ./zizmor.sh [args...]
#
# This script lints GitHub Actions workflows with zizmor.
#
# Primary execution path: run zizmor via its Docker image (CI-friendly).
# Fallback: if Docker isn't available/running (common on dev machines), download a
# prebuilt zizmor binary from GitHub Releases and run it directly.

if ! command -v docker >/dev/null 2>&1; then
  echo "⚠️  docker not found; skipping zizmor" >&2
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  echo "⚠️  docker daemon not running; skipping zizmor" >&2
  exit 0
fi

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

zizmor_version="1.20.0"
image_tag="ghcr.io/zizmorcore/zizmor:${zizmor_version}"

docker_args=(
  "--rm"
  "--volume" "$(pwd):/repo"
  "--workdir" "/repo"
)

if [[ -t 0 ]]; then
  docker_args+=("-it")
fi

# If no GH_TOKEN is set, try to get one from `gh auth token`.
if [[ "${GH_TOKEN:-}" == "" ]] && command -v gh &>/dev/null; then
  set +e
  GH_TOKEN="$(gh auth token)"
  export GH_TOKEN
  set -e
fi

# Pass through the GitHub token if it's set, which allows zizmor to scan
# imported workflows too.
if [[ "${GH_TOKEN:-}" != "" ]]; then
  docker_args+=("--env" "GH_TOKEN")
fi

# Prefer Docker when available (faster + consistent in CI).
# If docker is present but the image can't be pulled (e.g., GHCR auth/rate limits),
# fall back to the prebuilt binary.
if command -v docker &>/dev/null && docker info &>/dev/null; then
  set +e
  docker run "${docker_args[@]}" "$image_tag" "$@"
  status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    exit 0
  fi

  # Exit code 125 indicates the docker invocation failed (image pull, daemon issues, etc.).
  # Only in that case do we fall back to the prebuilt binary.
  #
  # For other non-zero exit codes, zizmor itself failed (e.g., it found issues) and we should
  # propagate that failure rather than masking it.
  if [[ $status -ne 125 ]]; then
    exit $status
  fi

  echo "⚠️  Docker zizmor failed (exit $status); running prebuilt binary..."
else
  echo "⚠️  Docker unavailable; running zizmor via prebuilt binary..."
fi

os="$(uname -s)"
arch="$(uname -m)"

target=""
case "$os-$arch" in
  Darwin-arm64) target="aarch64-apple-darwin" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" ;;
  Linux-x86_64) target="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64 | Linux-arm64) target="aarch64-unknown-linux-gnu" ;;
  *)
    echo "❌ Unsupported platform for zizmor binary fallback: $os/$arch"
    exit 1
    ;;
esac

cache_dir="node_modules/.cache/mux-tools/zizmor/v${zizmor_version}/${target}"
bin_path="${cache_dir}/zizmor"

if [[ ! -x "$bin_path" ]]; then
  mkdir -p "$cache_dir"

  tmp_dir="$(mktemp -d)"
  archive_name="zizmor-${target}.tar.gz"
  url="https://github.com/zizmorcore/zizmor/releases/download/v${zizmor_version}/${archive_name}"

  curl -fsSL "$url" -o "${tmp_dir}/${archive_name}"
  tar -xzf "${tmp_dir}/${archive_name}" -C "$tmp_dir"
  mv "${tmp_dir}/zizmor" "$bin_path"
  chmod +x "$bin_path"
  rm -rf "$tmp_dir"
fi

exec "$bin_path" "$@"
