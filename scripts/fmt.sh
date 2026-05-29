#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

PRETTIER_PATTERNS=(
  "src/**/*.{ts,tsx,js,jsx,json}"
  "tests/**/*.{ts,tsx,js,jsx,json}"
  "docs/**/*.{md,mdx}"
  "*.{json,md}"
)

run_prettier() {
  local mode="$1"
  local prettier_cmd
  if command -v prettier &>/dev/null; then
    prettier_cmd=(prettier)
  elif command -v bun &>/dev/null; then
    prettier_cmd=(bun x prettier)
  else
    echo "Error: prettier not found. Install Prettier or Bun to run formatting."
    exit 1
  fi

  if [ "$mode" = "--check" ]; then
    echo "Checking TypeScript/JSON/Markdown formatting..."
    "${prettier_cmd[@]}" --check "${PRETTIER_PATTERNS[@]}"
  else
    echo "Formatting TypeScript/JSON/Markdown files..."
    "${prettier_cmd[@]}" --write "${PRETTIER_PATTERNS[@]}"
  fi
}

format_nix() {
  if ! command -v nix &>/dev/null; then
    echo "Error: nix command not found. Install Nix to format flake.nix."
    exit 1
  fi

  local flake_path="$PROJECT_ROOT/flake.nix"
  if [ ! -f "$flake_path" ]; then
    echo "flake.nix not found at $flake_path; skipping Nix formatting."
    return
  fi

  echo "Formatting Nix flake..."
  nix fmt -- flake.nix
}

check_nix_format() (
  if ! command -v nix &>/dev/null; then
    echo "Error: nix command not found. Install Nix to check flake.nix formatting."
    exit 1
  fi

  local flake_path="$PROJECT_ROOT/flake.nix"
  if [ ! -f "$flake_path" ]; then
    echo "flake.nix not found at $flake_path; skipping Nix format check."
    exit 0
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/fmt-nix-check.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' EXIT
  cp "$flake_path" "$tmp_dir/flake.nix"
  (
    cd "$tmp_dir"
    nix fmt -- flake.nix
  )

  if ! cmp -s "$flake_path" "$tmp_dir/flake.nix"; then
    echo "flake.nix is not formatted correctly. Run ./scripts/fmt.sh --nix or make fmt-nix."
    diff -u "$flake_path" "$tmp_dir/flake.nix" || true
    exit 1
  fi
)

format_shell() {
  if ! command -v shfmt &>/dev/null; then
    echo "shfmt not found. Installing via brew..."
    if command -v brew &>/dev/null; then
      brew install shfmt
    else
      echo "Error: brew not found. Please install shfmt manually:"
      echo "  macOS: brew install shfmt"
      echo "  Linux: apt-get install shfmt or snap install shfmt"
      echo "  Go: go install mvdan.cc/sh/v3/cmd/shfmt@latest"
      exit 1
    fi
  fi
  echo "Formatting shell scripts..."
  shfmt -i 2 -ci -bn -w scripts
}

if [ "$1" = "--check" ]; then
  run_prettier --check
elif [ "$1" = "--shell" ]; then
  format_shell
elif [ "$1" = "--nix" ]; then
  format_nix
elif [ "$1" = "--nix-check" ]; then
  check_nix_format
elif [ "$1" = "--all" ]; then
  run_prettier
  format_nix
  format_shell
else
  run_prettier
fi
