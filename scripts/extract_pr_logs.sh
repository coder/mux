#!/usr/bin/env bash
# Extract logs from failed GitHub Actions runs for a PR
# Usage: ./scripts/extract_pr_logs.sh <pr_number_or_run_id> [job_name_pattern] [--wait]
#
# Examples:
#   ./scripts/extract_pr_logs.sh 329              # Latest failed run for PR #329
#   ./scripts/extract_pr_logs.sh 329 Integration  # Only Integration Test jobs
#   ./scripts/extract_pr_logs.sh 329 --wait       # Wait for logs to be available
#   ./scripts/extract_pr_logs.sh 18640062283      # Specific run ID

set -euo pipefail

INPUT="${1:-}"
JOB_PATTERN="${2:-}"
WAIT_FOR_LOGS=false

# Parse flags
if [[ "$JOB_PATTERN" == "--wait" ]]; then
  WAIT_FOR_LOGS=true
  JOB_PATTERN=""
elif [[ "${3:-}" == "--wait" ]]; then
  WAIT_FOR_LOGS=true
fi

if [[ -z "$INPUT" ]]; then
  echo "❌ Usage: $0 <pr_number_or_run_id> [job_name_pattern]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 329              # Latest failed run for PR #329 (RECOMMENDED)" >&2
  echo "  $0 329 Integration  # Only Integration Test jobs from PR #329" >&2
  echo "  $0 18640062283      # Specific run ID" >&2
  exit 1
fi

# Detect if input is PR number or run ID (run IDs are much longer)
if [[ "$INPUT" =~ ^[0-9]{1,5}$ ]]; then
  PR_NUMBER="$INPUT"
  echo "🔍 Finding latest failed run for PR #$PR_NUMBER..." >&2

  # Get the latest failed run for this PR
  RUN_ID=$(gh pr checks "$PR_NUMBER" --json name,link,state --jq '.[] | select(.state == "FAILURE") | .link' | head -1 | sed -E 's|.*/runs/([0-9]+).*|\1|' || echo "")

  if [[ -z "$RUN_ID" ]]; then
    echo "❌ No failed runs found for PR #$PR_NUMBER" >&2
    echo "" >&2
    echo "Current check status:" >&2
    gh pr checks "$PR_NUMBER" 2>&1 || true
    exit 1
  fi

  echo "📋 Found failed run: $RUN_ID" >&2
else
  RUN_ID="$INPUT"
  echo "📋 Fetching logs for run $RUN_ID..." >&2
fi

# Get all jobs for this run
JOBS=$(gh run view "$RUN_ID" --json jobs -q '.jobs[]' 2>/dev/null)

if [[ -z "$JOBS" ]]; then
  echo "❌ No jobs found for run $RUN_ID" >&2
  echo "" >&2
  echo "Check if run ID is correct:" >&2
  echo "  gh run list --limit 10" >&2
  exit 1
fi

# Filter to failed jobs only (unless specific pattern requested)
if [[ -z "$JOB_PATTERN" ]]; then
  FAILED_JOBS=$(echo "$JOBS" | jq -r 'select(.conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "CANCELLED")')
  if [[ -n "$FAILED_JOBS" ]]; then
    echo "🎯 Showing only failed jobs (use job_pattern to see others)" >&2
    JOBS="$FAILED_JOBS"
  fi
fi

# Parse jobs and filter by pattern if provided
if [[ -n "$JOB_PATTERN" ]]; then
  MATCHING_JOBS=$(echo "$JOBS" | jq -r "select(.name | test(\"$JOB_PATTERN\"; \"i\")) | .databaseId")
  if [[ -z "$MATCHING_JOBS" ]]; then
    echo "❌ No jobs matching pattern '$JOB_PATTERN'" >&2
    echo "" >&2
    echo "Available jobs:" >&2
    echo "$JOBS" | jq -r '.name' >&2
    exit 1
  fi
  JOB_IDS="$MATCHING_JOBS"
else
  JOB_IDS=$(echo "$JOBS" | jq -r '.databaseId')
fi

# Map job names to local commands for reproduction
suggest_local_command() {
  local job_name="$1"
  case "$job_name" in
    *"Static Checks"* | *"lint"* | *"typecheck"* | *"fmt"*)
      echo "💡 Reproduce locally: make static-check"
      ;;
    *"Integration Tests"*)
      echo "💡 Reproduce locally: make test-integration"
      ;;
    *"Test"*)
      echo "💡 Reproduce locally: make test"
      ;;
    *"Build"*)
      echo "💡 Reproduce locally: make build"
      ;;
    *"End-to-End"*)
      echo "💡 Reproduce locally: make test-e2e"
      ;;
  esac
}

# Extract and display logs for each job
for JOB_ID in $JOB_IDS; do
  JOB_INFO=$(echo "$JOBS" | jq -r "select(.databaseId == $JOB_ID)")
  JOB_NAME=$(echo "$JOB_INFO" | jq -r '.name')
  JOB_STATUS=$(echo "$JOB_INFO" | jq -r '.conclusion // .status')

  echo "" >&2
  echo "════════════════════════════════════════════════════════════" >&2
  echo "Job: $JOB_NAME (ID: $JOB_ID) - $JOB_STATUS" >&2
  echo "════════════════════════════════════════════════════════════" >&2

  # Suggest local reproduction command
  suggest_local_command "$JOB_NAME" >&2
  echo "" >&2

  # Fetch logs with retry logic if --wait flag is set
  MAX_RETRIES=3
  RETRY_COUNT=0

  while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    # Use gh api to fetch logs (works for individual completed jobs even if run is in progress)
    if gh api "/repos/coder/mux/actions/jobs/$JOB_ID/logs" 2>/dev/null; then
      break
    else
      RETRY_COUNT=$((RETRY_COUNT + 1))
      if [ $RETRY_COUNT -lt $MAX_RETRIES ] && [ "$WAIT_FOR_LOGS" = true ]; then
        echo "⏳ Logs not ready yet, waiting 5 seconds... (attempt $RETRY_COUNT/$MAX_RETRIES)" >&2
        sleep 5
      else
        echo "⚠️  Could not fetch logs for job $JOB_ID" >&2
        if [ "$WAIT_FOR_LOGS" = false ]; then
          echo "   Tip: Use --wait flag to retry if logs are still processing" >&2
        else
          echo "   (logs may have expired or are still processing)" >&2
        fi
        break
      fi
    fi
  done
done
