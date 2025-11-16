#!/usr/bin/env bash
# Smoke test for mux npm package
# Tests that the package can be installed and the server starts correctly

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
  echo -e "${GREEN}[INFO]${NC} $*"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $*"
}

# Cleanup function
cleanup() {
  local exit_code=$?
  log_info "Cleaning up..."

  # Kill server if it's running
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log_info "Stopping server (PID: $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  # Remove test directory
  if [[ -n "${TEST_DIR:-}" ]] && [[ -d "$TEST_DIR" ]]; then
    log_info "Removing test directory: $TEST_DIR"
    rm -rf "$TEST_DIR"
  fi

  if [[ $exit_code -eq 0 ]]; then
    log_info "✅ Smoke test completed successfully"
  else
    log_error "❌ Smoke test failed with exit code $exit_code"
  fi

  exit $exit_code
}

trap cleanup EXIT INT TERM

# Configuration
PACKAGE_TARBALL="${PACKAGE_TARBALL:-}"
SERVER_PORT="${SERVER_PORT:-3000}"
SERVER_HOST="${SERVER_HOST:-localhost}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-30}"
HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-10}"

# Validate required arguments
if [[ -z "$PACKAGE_TARBALL" ]]; then
  log_error "PACKAGE_TARBALL environment variable must be set"
  log_error "Usage: PACKAGE_TARBALL=/path/to/package.tgz $0"
  exit 1
fi

if [[ ! -f "$PACKAGE_TARBALL" ]]; then
  log_error "Package tarball not found: $PACKAGE_TARBALL"
  exit 1
fi

# Convert to absolute path before changing directories
PACKAGE_TARBALL=$(realpath "$PACKAGE_TARBALL")

log_info "Starting smoke test for package: $PACKAGE_TARBALL"

# Create temporary test directory
TEST_DIR=$(mktemp -d)
log_info "Created test directory: $TEST_DIR"

cd "$TEST_DIR"

# Initialize a minimal package.json to avoid npm warnings
cat >package.json <<EOF
{
  "name": "mux-smoke-test",
  "version": "1.0.0",
  "private": true
}
EOF

# Install the package
log_info "Installing package..."
if ! npm install --no-save "$PACKAGE_TARBALL"; then
  log_error "Failed to install package"
  exit 1
fi

log_info "✅ Package installed successfully"

# Verify the binary is available
if [[ ! -f "node_modules/.bin/mux" ]]; then
  log_error "mux binary not found in node_modules/.bin/"
  exit 1
fi

log_info "✅ mux binary found"

# Start the server in background
log_info "Starting mux server on $SERVER_HOST:$SERVER_PORT..."
node_modules/.bin/mux server --host "$SERVER_HOST" --port "$SERVER_PORT" >server.log 2>&1 &
SERVER_PID=$!

log_info "Server started with PID: $SERVER_PID"

# Wait for server to start
log_info "Waiting for server to start (timeout: ${STARTUP_TIMEOUT}s)..."
ELAPSED=0
while [[ $ELAPSED -lt $STARTUP_TIMEOUT ]]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log_error "Server process died unexpectedly"
    log_error "Server log:"
    cat server.log
    exit 1
  fi

  # Try to connect to the server
  if curl -sf "http://${SERVER_HOST}:${SERVER_PORT}/health" >/dev/null 2>&1; then
    log_info "✅ Server is responding"
    break
  fi

  sleep 1
  ELAPSED=$((ELAPSED + 1))
done

if [[ $ELAPSED -ge $STARTUP_TIMEOUT ]]; then
  log_error "Server failed to start within ${STARTUP_TIMEOUT}s"
  log_error "Server log:"
  cat server.log
  exit 1
fi

# Test healthcheck endpoint
log_info "Testing healthcheck endpoint..."
HEALTH_RESPONSE=$(curl -sf "http://${SERVER_HOST}:${SERVER_PORT}/health" || true)

if [[ -z "$HEALTH_RESPONSE" ]]; then
  log_error "Healthcheck returned empty response"
  exit 1
fi

log_info "Healthcheck response: $HEALTH_RESPONSE"

# Verify healthcheck response format
if ! echo "$HEALTH_RESPONSE" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  log_error "Healthcheck response does not contain expected 'status: ok'"
  log_error "Response: $HEALTH_RESPONSE"
  exit 1
fi

log_info "✅ Healthcheck endpoint returned valid response"

# Test that server is actually serving content
log_info "Testing root endpoint..."
if ! curl -sf "http://${SERVER_HOST}:${SERVER_PORT}/" >/dev/null 2>&1; then
  log_error "Failed to fetch root endpoint"
  exit 1
fi

log_info "✅ Root endpoint is accessible"

# All tests passed
log_info "🎉 All smoke tests passed!"
