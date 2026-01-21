#!/usr/bin/env bash
# Sets up macOS code signing and notarization from GitHub secrets
# Usage: ./scripts/setup-macos-signing.sh
#
# Required environment variables:
#   MACOS_CERTIFICATE          - Base64-encoded .p12 certificate
#   MACOS_CERTIFICATE_PWD      - Certificate password
#   AC_APIKEY_P8_BASE64        - Base64-encoded Apple API key (.p8)
#   AC_APIKEY_ID               - Apple API Key ID
#   AC_APIKEY_ISSUER_ID        - Apple API Issuer ID

set -euo pipefail

# Setup code signing certificate
if [ -n "${MACOS_CERTIFICATE:-}" ]; then
  echo "Setting up code signing certificate..."
  echo "$MACOS_CERTIFICATE" | base64 -D >/tmp/certificate.p12
  echo "CSC_LINK=/tmp/certificate.p12" >>"$GITHUB_ENV"
  echo "CSC_KEY_PASSWORD=$MACOS_CERTIFICATE_PWD" >>"$GITHUB_ENV"
else
  echo "⚠️  No code signing certificate provided - building unsigned"
fi

# Setup notarization credentials
if [ -n "${AC_APIKEY_ID:-}" ]; then
  echo "Setting up notarization credentials..."
  echo "$AC_APIKEY_P8_BASE64" | base64 -D >/tmp/AuthKey.p8
  # shellcheck disable=SC2129 # Multiple appends are clearer than a grouped block here
  echo "APPLE_API_KEY=/tmp/AuthKey.p8" >>"$GITHUB_ENV"
  echo "APPLE_API_KEY_ID=$AC_APIKEY_ID" >>"$GITHUB_ENV"
  echo "APPLE_API_ISSUER=$AC_APIKEY_ISSUER_ID" >>"$GITHUB_ENV"
  echo "✅ Notarization credentials configured"
else
  echo "⚠️  No notarization credentials - skipping notarization"
fi
