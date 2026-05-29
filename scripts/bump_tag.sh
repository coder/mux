#!/usr/bin/env bash
set -euo pipefail

# Bump version in package.json, commit, and create a git tag.
# Usage: ./scripts/bump_tag.sh [--minor]
#   --minor  Bump minor version (0.8.x -> 0.9.0), otherwise bumps patch (0.8.3 -> 0.8.4)

MINOR=false
if [[ "${1:-}" == "--minor" ]]; then
  MINOR=true
fi

# Get current version from package.json
CURRENT_VERSION=$(jq -r '.version' package.json)
if [[ -z "$CURRENT_VERSION" || "$CURRENT_VERSION" == "null" ]]; then
  echo "Error: Could not read version from package.json" >&2
  exit 1
fi

# Parse semver components
IFS='.' read -r MAJOR MINOR_V PATCH <<<"$CURRENT_VERSION"

# Calculate new version
if [[ "$MINOR" == "true" ]]; then
  NEW_VERSION="${MAJOR}.$((MINOR_V + 1)).0"
else
  NEW_VERSION="${MAJOR}.${MINOR_V}.$((PATCH + 1))"
fi

echo "Bumping version: $CURRENT_VERSION -> $NEW_VERSION"

# Rollback function to restore original state on failure
rollback() {
  echo "Error: Rolling back changes..." >&2
  jq --arg v "$CURRENT_VERSION" '.version = $v' package.json >package.json.tmp
  mv package.json.tmp package.json
  git reset HEAD -- package.json 2>/dev/null || true
  exit 1
}

# Update package.json
jq --arg v "$NEW_VERSION" '.version = $v' package.json >package.json.tmp
mv package.json.tmp package.json

# Commit and tag (rollback on failure)
git add package.json || rollback
git commit -m "release: v${NEW_VERSION}" || rollback
git tag "v${NEW_VERSION}" || rollback

echo "Created tag v${NEW_VERSION}"
echo "Run 'git push && git push --tags' to publish"
