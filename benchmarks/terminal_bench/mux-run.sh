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

command -v bun >/dev/null 2>&1 || fatal "bun is not installed"
project_path=$(resolve_project_path)

log "starting mux agent session for ${project_path}"
cd "${MUX_APP_ROOT}"

cmd=(bun src/cli/run.ts
  --dir "${project_path}"
  --model "${MUX_MODEL}"
  --mode "${MUX_MODE}"
  --thinking "${MUX_THINKING_LEVEL}"
  --json)

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

MUX_OUTPUT_FILE="/tmp/mux-output.jsonl"
MUX_TOKEN_FILE="/tmp/mux-tokens.json"

# Wrap command with timeout if MUX_TIMEOUT_MS is set (converts ms to seconds)
if [[ -n "${MUX_TIMEOUT_MS}" ]]; then
  timeout_sec=$((MUX_TIMEOUT_MS / 1000))
  cmd=(timeout "${timeout_sec}s" "${cmd[@]}")
fi

# Terminal-bench enforces timeouts via --global-agent-timeout-sec
# Capture output to file while streaming to terminal for token extraction
if ! printf '%s' "${instruction}" | "${cmd[@]}" | tee "${MUX_OUTPUT_FILE}"; then
  fatal "mux agent session failed"
fi

# Extract usage and cost from run-complete event (emitted at end of --json run)
python3 -c '
import json, sys
result = {"input": 0, "output": 0, "cost_usd": None}
for line in open(sys.argv[1]):
    try:
        obj = json.loads(line)
        if obj.get("type") == "run-complete":
            usage = obj.get("usage") or {}
            result["input"] = usage.get("inputTokens", 0) or 0
            result["output"] = usage.get("outputTokens", 0) or 0
            result["cost_usd"] = obj.get("cost_usd")
            break
    except: pass
print(json.dumps(result))
' "${MUX_OUTPUT_FILE}" > "${MUX_TOKEN_FILE}" 2>/dev/null || true
