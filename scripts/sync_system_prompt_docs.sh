#!/usr/bin/env bash
# Syncs the code block in docs/system-prompt.md with src/node/services/systemMessage.ts
# Usage:
#   ./scripts/sync_system_prompt_docs.sh        # Update docs
#   ./scripts/sync_system_prompt_docs.sh check  # Check if in sync (exit 1 if not)

set -euo pipefail

SOURCE_FILE="src/node/services/systemMessage.ts"
DOCS_FILE="docs/system-prompt.md"

# Extract code between #region and #endregion SYSTEM_PROMPT_DOCS markers
extract_code_block() {
  sed -n '/^\/\/ #region SYSTEM_PROMPT_DOCS$/,/^\/\/ #endregion SYSTEM_PROMPT_DOCS$/p' "$SOURCE_FILE" \
    | sed '1d;$d' # Remove the marker lines themselves
}

# Generate the synced section (code block only)
generate_section() {
  echo '```typescript'
  extract_code_block
  echo '```'
}

# Extract the current synced section from docs
# Uses JSX-style comments for Mintlify MDX compatibility
extract_current_section() {
  sed -n '/{\/\* BEGIN SYSTEM_PROMPT_DOCS \*\/}/,/{\/\* END SYSTEM_PROMPT_DOCS \*\/}/p' "$DOCS_FILE" \
    | tail -n +2 | head -n -1 \
    |
    # Remove first and last lines (markers)
    sed '1{/^$/d}' | sed '${/^$/d}' # Trim leading/trailing blank lines
}

if [[ "${1:-}" == "check" ]]; then
  generated=$(generate_section)
  current=$(extract_current_section)

  if [[ "$generated" != "$current" ]]; then
    echo "❌ $DOCS_FILE is out of sync with $SOURCE_FILE"
    echo "Run 'make fmt' to update."
    exit 1
  fi
  echo "✅ $DOCS_FILE is in sync"
else
  # Replace section between markers using temp file approach
  # Uses JSX-style comments for Mintlify MDX compatibility
  {
    # Print everything up to and including BEGIN marker
    sed -n '1,/{\/\* BEGIN SYSTEM_PROMPT_DOCS \*\/}/p' "$DOCS_FILE"
    echo ""
    generate_section
    echo ""
    # Print END marker and everything after
    sed -n '/{\/\* END SYSTEM_PROMPT_DOCS \*\/}/,$p' "$DOCS_FILE"
  } >"$DOCS_FILE.tmp"
  mv "$DOCS_FILE.tmp" "$DOCS_FILE"
  echo "Updated $DOCS_FILE"
fi
