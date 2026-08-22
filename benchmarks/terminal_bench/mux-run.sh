#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint for staged benchmark jobs created before the Xum rename.
exec bash "$(dirname "$0")/xum-run.sh" "$@"
