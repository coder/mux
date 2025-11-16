#!/usr/bin/env bash
# Extract logs from GitHub Actions runs for a PR (including in-progress jobs)
# Usage: ./scripts/extract_pr_logs.sh <pr_number_or_run_id> [job_name_pattern] [--all]
#
# Examples:
#   ./scripts/extract_pr_logs.sh 329              # Latest failed run for PR #329
#   ./scripts/extract_pr_logs.sh 329 Integration  # Only Integration Test jobs
#   ./scripts/extract_pr_logs.sh 329 --all        # Show all jobs (not just failed)
#   ./scripts/extract_pr_logs.sh 18640062283      # Specific run ID

set -euo pipefail

INPUT="${1:-}"
JOB_PATTERN="${2:-}"
SHOW_ALL_JOBS=false

# Parse flags
for arg in "$@"; do
  if [[ "$arg" == "--all" ]]; then
    SHOW_ALL_JOBS=true
  fi
done

# Remove flags from JOB_PATTERN if they were set as second arg
if [[ "$JOB_PATTERN" == "--all" ]]; then
  JOB_PATTERN=""
fi

if [[ -z "$INPUT" ]]; then
  echo "❌ Usage: $0 <pr_number_or_run_id> [job_name_pattern] [--all]" >&2
  echo "" >&2
  echo "Examples:" >&2
  echo "  $0 329              # Latest failed run for PR #329" >&2
  echo "  $0 329 Integration  # Only Integration Test jobs from PR #329" >&2
  echo "  $0 329 --all        # Show all jobs (not just failed/in-progress)" >&2
  echo "  $0 18640062283      # Specific run ID" >&2
  exit 1
fi

# Detect if input is PR number or run ID (run IDs are much longer)
if [[ "$INPUT" =~ ^[0-9]{1,5}$ ]]; then
  PR_NUMBER="$INPUT"
  
  # If --all flag is set or no failures, get latest run regardless of status
  if [[ "$SHOW_ALL_JOBS" == true ]]; then
    echo "🔍 Finding latest run for PR #$PR_NUMBER..." >&2
    RUN_ID=$(gh pr checks "$PR_NUMBER" --json name,link,state --jq '.[] | select(.link | contains("/runs/")) | .link' | head -1 | sed -E 's|.*/runs/([0-9]+).*|\1|' || echo "")
  else
    echo "🔍 Finding latest failed run for PR #$PR_NUMBER..." >&2
    # Get the latest failed run for this PR
    RUN_ID=$(gh pr checks "$PR_NUMBER" --json name,link,state --jq '.[] | select(.state == "FAILURE") | select(.link | contains("/runs/")) | .link' | head -1 | sed -E 's|.*/runs/([0-9]+).*|\1|' || echo "")
  fi

  if [[ -z "$RUN_ID" ]]; then
    echo "❌ No failed runs found for PR #$PR_NUMBER" >&2
    echo "" >&2
    echo "Current check status:" >&2
    gh pr checks "$PR_NUMBER" 2>&1 || true
    echo "" >&2
    echo "💡 Tip: Use --all flag to see logs from any run (not just failed)" >&2
    exit 1
  fi

  echo "📋 Found run: $RUN_ID" >&2
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

# Filter jobs based on flags and pattern
if [[ -z "$JOB_PATTERN" ]] && [[ "$SHOW_ALL_JOBS" == false ]]; then
  # Show failed/timed out/cancelled jobs, OR in-progress/pending jobs if no failures exist
  FAILED_JOBS=$(echo "$JOBS" | jq -r 'select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled")')
  IN_PROGRESS_JOBS=$(echo "$JOBS" | jq -r 'select(.status == "in_progress" or .status == "queued" or .status == "pending")')
  
  if [[ -n "$FAILED_JOBS" ]]; then
    echo "🎯 Showing only failed jobs (use --all to see all jobs)" >&2
    JOBS="$FAILED_JOBS"
  elif [[ -n "$IN_PROGRESS_JOBS" ]]; then
    echo "⏳ No failures yet - showing in-progress/pending jobs (use --all to see all)" >&2
    JOBS="$IN_PROGRESS_JOBS"
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

# Show step-by-step progress for in-progress/pending jobs
show_job_steps() {
  local job_id="$1"
  local job_status="$2"
  
  if [[ "$job_status" == "in_progress" ]] || [[ "$job_status" == "queued" ]] || [[ "$job_status" == "pending" ]]; then
    echo "" >&2
    echo "📊 Step-by-step status:" >&2
    gh api "/repos/coder/cmux/actions/jobs/$job_id" | jq -r '.steps[] | "  [\(.status | ascii_upcase)] \(.name)\(if .conclusion then " (\(.conclusion))" else "" end)"' >&2
    echo "" >&2
  fi
}

# Extract and display logs for each job
for JOB_ID in $JOB_IDS; do
  JOB_INFO=$(echo "$JOBS" | jq -r "select(.databaseId == $JOB_ID)")
  JOB_NAME=$(echo "$JOB_INFO" | jq -r '.name')
  JOB_STATUS=$(echo "$JOB_INFO" | jq -r '.status')
  JOB_CONCLUSION=$(echo "$JOB_INFO" | jq -r '.conclusion // "N/A"')
  
  # Display status: show conclusion if completed, otherwise show status
  if [[ "$JOB_STATUS" == "completed" ]]; then
    DISPLAY_STATUS="$JOB_CONCLUSION"
  else
    DISPLAY_STATUS="$JOB_STATUS"
  fi

  echo "" >&2
  echo "════════════════════════════════════════════════════════════" >&2
  echo "Job: $JOB_NAME (ID: $JOB_ID)" >&2
  echo "Status: $DISPLAY_STATUS" >&2
  echo "════════════════════════════════════════════════════════════" >&2

  # Suggest local reproduction command
  suggest_local_command "$JOB_NAME" >&2
  
  # Show step-by-step status for in-progress/pending jobs
  show_job_steps "$JOB_ID" "$JOB_STATUS"

  # Try to fetch logs
  if [[ "$JOB_STATUS" == "completed" ]]; then
    # Completed job - logs should be available
    if gh api "/repos/coder/cmux/actions/jobs/$JOB_ID/logs" 2>/dev/null; then
      echo "" >&2
    else
      echo "⚠️  Could not fetch logs for completed job $JOB_ID (logs may have expired)" >&2
      echo "" >&2
    fi
  else
    # In-progress/pending/queued job - GitHub API doesn't provide logs until completion
    echo "ℹ️  Job is $JOB_STATUS - logs not available via API until completion" >&2
    echo "" >&2
    
    # Show which step is currently running
    CURRENT_STEP=$(gh api "/repos/coder/cmux/actions/jobs/$JOB_ID" 2>/dev/null | jq -r '.steps[] | select(.status == "in_progress") | .name' | head -1)
    if [[ -n "$CURRENT_STEP" ]]; then
      echo "🔄 Currently running: $CURRENT_STEP" >&2
    fi
    
    # Construct GitHub URL for viewing live logs in browser
    echo "👁️  View live logs: https://github.com/coder/cmux/actions/runs/$RUN_ID/job/$JOB_ID" >&2
    echo "" >&2
  fi
done
