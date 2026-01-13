#!/usr/bin/env bash
# Validates that code references to docs (URLs and DocsLink paths) resolve to existing doc files.
set -euo pipefail

DOCS_BASE="https://mux.coder.com"
DOCS_DIR="docs"
EXIT_CODE=0

check_path() {
  local path="$1"
  local source="$2"

  # Strip anchor
  path="${path%%#*}"
  # Strip trailing slash
  path="${path%/}"
  # Empty path = index
  [[ -z "$path" ]] && path="index"
  # Strip leading slash
  path="${path#/}"

  # Check existence
  if [[ -f "$DOCS_DIR/${path}.mdx" ]] || [[ -f "$DOCS_DIR/${path}/index.mdx" ]]; then
    return 0
  fi

  echo "❌ Broken doc link: /${path}"
  echo "   Source: $source"
  EXIT_CODE=1
}

echo "🔗 Checking code-to-docs links..."

# Extract from README.md
while IFS= read -r url; do
  path="${url#"$DOCS_BASE"}"
  check_path "$path" "README.md"
done < <(grep -oP "https://mux\.coder\.com[^\s\)\"']*" README.md 2>/dev/null || true)

# Extract from source files (URLs) - skip gateway URLs and generated files
while IFS=: read -r file line url; do
  [[ "$url" == *"gateway."* ]] && continue
  [[ "$file" == *.generated.ts ]] && continue
  path="${url#"$DOCS_BASE"}"
  check_path "$path" "$file:$line"
done < <(grep -rn --include="*.ts" --include="*.tsx" -oP "https://mux\.coder\.com[^\s\)\"']*" src/ 2>/dev/null || true)

# Extract DocsLink paths
while IFS= read -r match; do
  file="${match%%:*}"
  rest="${match#*:}"
  line="${rest%%:*}"
  path=$(echo "$match" | grep -oP 'path="[^"]*"' | sed 's/path="//;s/"$//')
  check_path "$path" "$file:$line (DocsLink)"
done < <(grep -rn --include="*.tsx" 'DocsLink' src/ | grep 'path="' || true)

if [[ $EXIT_CODE -eq 0 ]]; then
  echo "✅ All code-to-docs links valid"
fi

exit $EXIT_CODE
