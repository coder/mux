#!/usr/bin/env bash
# Generate src/node/services/agentDefinitions/builtInAgentContent.generated.ts
# This embeds the markdown content directly so it works with tsc (no esbuild .md loader)

set -e

OUTPUT="src/node/services/agentDefinitions/builtInAgentContent.generated.ts"
AGENT_DIR="src/node/builtinAgents"

# Start generating the file
cat >"$OUTPUT" <<HEADER
// AUTO-GENERATED - DO NOT EDIT
// Run: scripts/generate-builtin-agents.sh
// Source: src/node/builtinAgents/*.md

export const BUILTIN_AGENT_CONTENT = {
HEADER

# Process each .md file
for file in "$AGENT_DIR"/*.md; do
  name=$(basename "$file" .md)
  # Use node to properly escape the string
  escaped=$(node -e "console.log(JSON.stringify(require('fs').readFileSync('$file', 'utf8')))")
  echo "  \"$name\": $escaped," >>"$OUTPUT"
done

# Close the object
echo "};" >>"$OUTPUT"

echo "Generated $OUTPUT"
