#!/usr/bin/env bash

set -euo pipefail

log() {
  printf '[mux-run] %s\n' "$1"
}

fatal() {
  printf '[mux-run] ERROR: %s\n' "$1" >&2
  exit 1
}

instruction=${1:-}
if [[ -z "${instruction}" ]]; then
  fatal "instruction argument is required"
fi

export BUN_INSTALL="${BUN_INSTALL:-/root/.bun}"
export PATH="${BUN_INSTALL}/bin:${PATH}"

MUX_APP_ROOT="${MUX_APP_ROOT:-/opt/mux-app}"
MUX_CONFIG_ROOT="${MUX_CONFIG_ROOT:-/root/.mux}"
MUX_PROJECT_PATH="${MUX_PROJECT_PATH:-}"
MUX_PROJECT_CANDIDATES="${MUX_PROJECT_CANDIDATES:-/workspace:/app:/workspaces:/root/project}"
MUX_MODEL="${MUX_MODEL:-anthropic:claude-sonnet-4-5}"
MUX_TIMEOUT_MS="${MUX_TIMEOUT_MS:-}"
MUX_TRUNK="${MUX_TRUNK:-main}"
MUX_WORKSPACE_ID="${MUX_WORKSPACE_ID:-mux-bench}"
MUX_THINKING_LEVEL="${MUX_THINKING_LEVEL:-high}"
MUX_MODE="${MUX_MODE:-exec}"
MUX_RUNTIME="${MUX_RUNTIME:-}"
MUX_EXPERIMENTS="${MUX_EXPERIMENTS:-}"

resolve_project_path() {
  if [[ -n "${MUX_PROJECT_PATH}" ]]; then
    if [[ -d "${MUX_PROJECT_PATH}" ]]; then
      printf '%s\n' "${MUX_PROJECT_PATH}"
      return 0
    fi
    fatal "MUX_PROJECT_PATH=${MUX_PROJECT_PATH} not found"
  fi

  IFS=":" read -r -a candidates <<<"${MUX_PROJECT_CANDIDATES}"
  for candidate in "${candidates[@]}"; do
    if [[ -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  fatal "no project path located (searched ${MUX_PROJECT_CANDIDATES})"
}

ensure_git_repo() {
  local project_path=$1

  command -v git >/dev/null 2>&1 || return 0

  if git -C "${project_path}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "${project_path}" checkout "${MUX_TRUNK}" 2>/dev/null || \
      git -C "${project_path}" checkout -b "${MUX_TRUNK}" 2>/dev/null || true
    return 0
  fi

  log "initialising git repository at ${project_path}"
  git -C "${project_path}" init --initial-branch="${MUX_TRUNK}" 2>/dev/null || \
    (git -C "${project_path}" init && git -C "${project_path}" checkout -B "${MUX_TRUNK}") >/dev/null
  git -C "${project_path}" config user.name "mux-bench"
  git -C "${project_path}" config user.email "bench@mux.local"
  git -C "${project_path}" add -A >/dev/null
  git -C "${project_path}" commit -m "chore: initial snapshot" --allow-empty >/dev/null
}

command -v bun >/dev/null 2>&1 || fatal "bun is not installed"
project_path=$(resolve_project_path)
ensure_git_repo "${project_path}"

log "starting mux agent session for ${project_path}"
cd "${MUX_APP_ROOT}"

cmd=(bun src/cli/run.ts
  --dir "${project_path}"
  --model "${MUX_MODEL}"
  --mode "${MUX_MODE}"
  --thinking "${MUX_THINKING_LEVEL}"
  --config-root "${MUX_CONFIG_ROOT}"
  --workspace-id "${MUX_WORKSPACE_ID}"
  --json)

if [[ -n "${MUX_TIMEOUT_MS}" ]]; then
  cmd+=(--timeout "${MUX_TIMEOUT_MS}")
fi

if [[ -n "${MUX_RUNTIME}" ]]; then
  cmd+=(--runtime "${MUX_RUNTIME}")
fi

# Add experiment flags (comma-separated → repeated --experiment flags)
if [[ -n "${MUX_EXPERIMENTS}" ]]; then
  IFS=',' read -r -a experiments <<<"${MUX_EXPERIMENTS}"
  for exp in "${experiments[@]}"; do
    # Trim whitespace
    exp="${exp#"${exp%%[![:space:]]*}"}"
    exp="${exp%"${exp##*[![:space:]]}"}"
    if [[ -n "${exp}" ]]; then
      cmd+=(--experiment "${exp}")
    fi
  done
fi

# Terminal-bench enforces timeouts via --global-agent-timeout-sec
if ! printf '%s' "${instruction}" | "${cmd[@]}"; then
  fatal "mux agent session failed"
fi
