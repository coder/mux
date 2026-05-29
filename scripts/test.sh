#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

if [ "$1" = "--watch" ]; then
  echo "Running tests in watch mode..."
  jest --watch
elif [ "$1" = "--coverage" ]; then
  echo "Running tests with coverage..."
  jest --coverage
else
  echo "Running tests..."
  jest
fi
