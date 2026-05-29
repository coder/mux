#!/usr/bin/env bash

set -e

DOCS_DIR="/tmp/ai-sdk-docs"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "Fetching Vercel AI SDK documentation..."

cd "$TEMP_DIR"
git init -q
git remote add origin https://github.com/vercel/ai.git
git config core.sparseCheckout true
mkdir -p .git/info
echo "content/*" >.git/info/sparse-checkout

git fetch --depth=1 origin main
git checkout main

if [ -d "$DOCS_DIR" ]; then
  echo "Removing existing ai-sdk-docs directory..."
  rm -rf "$DOCS_DIR"
fi

mkdir -p "$DOCS_DIR"

if [ -d "content" ]; then
  echo "Copying documentation to $DOCS_DIR..."
  cp -r content/* "$DOCS_DIR/"
  echo "Documentation updated successfully!"
else
  echo "Error: content directory not found in repository"
  exit 1
fi

echo "Vercel AI SDK documentation has been updated in $DOCS_DIR"
