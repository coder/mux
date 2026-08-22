#!/usr/bin/env bash

set -euo pipefail

log() {
  printf '[xum-run] %s\n' "$1"
}

fatal() {
  printf '[xum-run] ERROR: %s\n' "$1" >&2
  exit 1
}

instruction=${1:-}
if [[ -z "${instruction}" ]]; then
  fatal "instruction argument is required"
fi

export BUN_INSTALL="${BUN_INSTALL:-/root/.bun}"
export PATH="${BUN_INSTALL}/bin:${PATH}"

# External benchmark jobs may still provide MUX_* variables. Canonical XUM_*
# values always win; legacy names are copied only when their replacement is unset.
for suffix in APP_ROOT CONFIG_ROOT ROOT PROJECT_PATH PROJECT_CANDIDATES MODEL TIMEOUT_MS WORKSPACE_ID EXPERIMENTS RUN_AS_GOAL RUN_ARGS LOG_DIR OUTPUT_FILE STDERR_FILE TOKEN_FILE; do
  canonical_name="XUM_${suffix}"
  legacy_name="MUX_${suffix}"
  if [[ ! -v "${canonical_name}" && -v "${legacy_name}" ]]; then
    export "${canonical_name}=${!legacy_name}"
  fi
done

XUM_APP_ROOT="${XUM_APP_ROOT:-/opt/xum-app}"

# Prefer an explicit XUM_CONFIG_ROOT, but fall back to XUM_ROOT for callers that
# only override the Xum home via XUM_ROOT.
XUM_CONFIG_ROOT="${XUM_CONFIG_ROOT:-${XUM_ROOT:-/root/.xum}}"

# Export XUM_ROOT so Xum's getXumHome() finds providers.jsonc and other config.
# Don't clobber caller-provided XUM_ROOT (e.g. local runs/tests with a custom root).
export XUM_ROOT="${XUM_ROOT:-${XUM_CONFIG_ROOT}}"
XUM_PROJECT_PATH="${XUM_PROJECT_PATH:-}"
XUM_PROJECT_CANDIDATES="${XUM_PROJECT_CANDIDATES:-/workspace:/app:/workspaces:/root/project}"
XUM_MODEL="${XUM_MODEL:-anthropic:claude-sonnet-4-5}"
XUM_TIMEOUT_MS="${XUM_TIMEOUT_MS:-}"
XUM_WORKSPACE_ID="${XUM_WORKSPACE_ID:-xum-bench}"
XUM_EXPERIMENTS="${XUM_EXPERIMENTS:-}"
XUM_RUN_AS_GOAL="${XUM_RUN_AS_GOAL:-}"

xum_run_as_goal_normalized="${XUM_RUN_AS_GOAL,,}"
xum_run_as_goal_normalized="${xum_run_as_goal_normalized#"${xum_run_as_goal_normalized%%[![:space:]]*}"}"
xum_run_as_goal_normalized="${xum_run_as_goal_normalized%"${xum_run_as_goal_normalized##*[![:space:]]}"}"
case "${xum_run_as_goal_normalized}" in
  "" | "0" | "false") xum_run_as_goal_enabled=0 ;;
  "1" | "true") xum_run_as_goal_enabled=1 ;;
  *) fatal "XUM_RUN_AS_GOAL must be one of: 1, true, 0, false" ;;
esac

resolve_project_path() {
  if [[ -n "${XUM_PROJECT_PATH}" ]]; then
    if [[ -d "${XUM_PROJECT_PATH}" ]]; then
      printf '%s\n' "${XUM_PROJECT_PATH}"
      return 0
    fi
    fatal "XUM_PROJECT_PATH=${XUM_PROJECT_PATH} not found"
  fi

  IFS=":" read -r -a candidates <<<"${XUM_PROJECT_CANDIDATES}"
  for candidate in "${candidates[@]}"; do
    if [[ -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  fatal "no project path located (searched ${XUM_PROJECT_CANDIDATES})"
}

command -v bun >/dev/null 2>&1 || fatal "bun is not installed"
project_path=$(resolve_project_path)

log "starting xum agent session for ${project_path}"
cd "${XUM_APP_ROOT}"

cmd=(bun src/cli/run.ts
  --dir "${project_path}"
  --model "${XUM_MODEL}"
  --keep-background-processes
  --json)

# Add experiment flags (comma-separated → repeated --experiment flags)
if [[ -n "${XUM_EXPERIMENTS}" ]]; then
  IFS=',' read -r -a experiments <<<"${XUM_EXPERIMENTS}"
  for exp in "${experiments[@]}"; do
    # Trim whitespace
    exp="${exp#"${exp%%[![:space:]]*}"}"
    exp="${exp%"${exp##*[![:space:]]}"}"
    if [[ -n "${exp}" ]]; then
      cmd+=(--experiment "${exp}")
    fi
  done
fi

if [[ "${xum_run_as_goal_enabled}" == "1" ]]; then
  log "strict xum goal mode enabled"
  cmd+=(--goal "${instruction}")
fi

xum_run_args=()
# Append arbitrary Xum run flags (e.g., --thinking high --mode exec --use-1m --budget 5.00)
if [[ -n "${XUM_RUN_ARGS:-}" ]]; then
  # Word-split intentional: XUM_RUN_ARGS contains space-separated CLI flags.
  # shellcheck disable=SC2206
  xum_run_args=(${XUM_RUN_ARGS})
  if [[ "${xum_run_as_goal_enabled}" == "1" ]]; then
    for arg in "${xum_run_args[@]}"; do
      if [[ "${arg}" == "--goal" || "${arg}" == --goal=* ]]; then
        fatal "XUM_RUN_ARGS must not include --goal when XUM_RUN_AS_GOAL is enabled"
      fi
    done
  fi
  cmd+=("${xum_run_args[@]}")
fi

# NOTE: Harbor only automatically collects /logs/agent on timeouts.
# Persist stdout/stderr there so partial agent output survives cancellation.
XUM_LOG_DIR="${XUM_LOG_DIR:-/logs/agent/command-0}"
mkdir -p "${XUM_LOG_DIR}"
XUM_OUTPUT_FILE="${XUM_LOG_DIR}/stdout.txt"
XUM_STDERR_FILE="${XUM_LOG_DIR}/stderr.txt"
XUM_TOKEN_FILE="${XUM_TOKEN_FILE:-/tmp/xum-tokens.json}"

# Let Harbor classify task timeouts; GNU timeout would surface as exit 124.
if [[ -n "${XUM_TIMEOUT_MS}" ]]; then
  if [[ ! "${XUM_TIMEOUT_MS}" =~ ^[0-9]+$ ]]; then
    fatal "XUM_TIMEOUT_MS must be an integer"
  fi
  log "XUM_TIMEOUT_MS=${XUM_TIMEOUT_MS} forwarded; Harbor remains timeout authority"
fi

# Capture output to file while streaming to terminal for token extraction.
# Keep stderr separate so the stdout log stays valid JSONL.
set +e
printf '%s' "${instruction}" \
  | "${cmd[@]}" \
    2> >(tee "${XUM_STDERR_FILE}" >&2) \
  | tee "${XUM_OUTPUT_FILE}"
pipeline_status=("${PIPESTATUS[@]}")
set -e
stdin_status="${pipeline_status[0]}"
xum_status="${pipeline_status[1]}"
tee_status="${pipeline_status[2]}"

# Extract usage and cost from the JSONL output.
# Prefer the run-complete event (emitted at end of --json run) which has aggregated
# totals. Fall back to summing usage-delta + session-usage-delta events when
# run-complete is missing (e.g. process killed by timeout, stdout not flushed).
python3 -c '
import json, sys
result = {"input": 0, "output": 0, "cost_usd": None}
# Track cumulative usage from usage-delta events (keyed by messageId).
# Each usage-delta contains cumulative totals for its message, so we keep the
# latest per message and sum across messages at the end.
cumulative_by_msg = {}
# Track sub-agent usage from session-usage-delta events. These carry per-model
# byModelDelta dicts with {input: {tokens, cost_usd}, output: {tokens, cost_usd}, ...}.
# Each event is an incremental delta, so we sum them all.
subagent_input = 0
subagent_output = 0
for line in open(sys.argv[1]):
    try:
        obj = json.loads(line)
        if obj.get("type") == "run-complete":
            usage = obj.get("usage") or {}
            result["input"] = usage.get("inputTokens", 0) or 0
            result["output"] = usage.get("outputTokens", 0) or 0
            result["cost_usd"] = obj.get("cost_usd")
            print(json.dumps(result))
            sys.exit(0)
        # Nested event wrapper: {"type":"event","payload":{"type":"usage-delta",...}}
        payload = obj.get("payload") or obj
        if payload.get("type") == "usage-delta":
            msg_id = payload.get("messageId", "")
            # Prefer cumulativeUsage (running total across all steps in a message)
            # over usage (per-step delta). Keeping the latest cumulative per message
            # gives the correct total when summed across messages.
            usage = payload.get("cumulativeUsage") or payload.get("usage") or {}
            cumulative_by_msg[msg_id] = usage
        elif payload.get("type") == "session-usage-delta":
            for model_usage in (payload.get("byModelDelta") or {}).values():
                subagent_input += (model_usage.get("input") or {}).get("tokens", 0)
                subagent_output += (model_usage.get("output") or {}).get("tokens", 0)
    except Exception:
        pass
# No run-complete found — aggregate the last usage-delta per message + sub-agent totals
for usage in cumulative_by_msg.values():
    result["input"] += (usage.get("inputTokens", 0) or 0)
    result["output"] += (usage.get("outputTokens", 0) or 0)
result["input"] += subagent_input
result["output"] += subagent_output
print(json.dumps(result))
' "${XUM_OUTPUT_FILE}" >"${XUM_TOKEN_FILE}" 2>/dev/null || true

if [[ "${xum_status}" -eq 3 && "${xum_run_as_goal_enabled}" == "1" ]]; then
  printf '[xum-run] WARNING: xum goal run stopped incomplete (exit 3); leaving workspace for verifier scoring\n' >&2
  xum_status=0
fi

if [[ "${xum_status}" -ne 0 ]]; then
  printf '[xum-run] ERROR: xum agent session failed (exit %s)\n' "${xum_status}" >&2
  exit "${xum_status}"
fi

if [[ "${tee_status}" -ne 0 ]]; then
  printf '[xum-run] ERROR: failed to capture xum stdout (exit %s)\n' "${tee_status}" >&2
  exit "${tee_status}"
fi

if [[ "${stdin_status}" -ne 0 ]]; then
  printf '[xum-run] ERROR: failed to send instruction to Xum (exit %s)\n' "${stdin_status}" >&2
  exit "${stdin_status}"
fi
