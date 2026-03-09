#!/usr/bin/env bash
# Retry a command with backoff between attempts.
# Usage: scripts/retry.sh <max_attempts> <backoff_secs> <command...>
#
# Designed for CI (GitHub Actions): uses ::group:: markers for log folding
# and ::error:: annotations on final failure.
set -euo pipefail

max_attempts="${1:?Usage: retry.sh <max_attempts> <backoff_secs> <command...>}"
backoff_secs="${2:?Usage: retry.sh <max_attempts> <backoff_secs> <command...>}"
shift 2

for attempt in $(seq 1 "$max_attempts"); do
  echo "::group::Attempt $attempt of $max_attempts"
  if "$@"; then
    echo "::endgroup::"
    exit 0
  fi
  echo "::endgroup::"
  if [ "$attempt" -lt "$max_attempts" ]; then
    echo "⚠️ Attempt $attempt failed — retrying in ${backoff_secs}s..."
    sleep "$backoff_secs"
  fi
done

echo "::error::All $max_attempts attempts failed"
exit 1
