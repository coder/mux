/**
 * Shared test utilities for integration tests
 *
 * This module handles:
 * - Loading .env configuration for tests
 * - Checking TEST_INTEGRATION flag
 * - Validating required API keys
 */

import { config } from "dotenv";
import * as path from "path";

// Load .env from project root on module import
// This runs once when the module is first imported
config({ path: path.resolve(__dirname, "../.env"), quiet: true });

/**
 * Check if integration tests should run
 * Tests are skipped if TEST_INTEGRATION env var is not set
 */
export function shouldRunIntegrationTests(): boolean {
  return process.env.TEST_INTEGRATION === "1";
}

/**
 * Validate required API keys are present
 * Throws if TEST_INTEGRATION is set but API keys are missing
 */
export function validateApiKeys(requiredKeys: string[]): void {
  if (!shouldRunIntegrationTests()) {
    return; // Skip validation if not running integration tests
  }

  const missing = requiredKeys.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Integration tests require the following environment variables: ${missing.join(", ")}\n` +
        `Please set them or unset TEST_INTEGRATION to skip these tests.`
    );
  }
}

/**
 * Get API key from environment or throw if missing (when TEST_INTEGRATION is set)
 */
export function getApiKey(keyName: string): string {
  if (!shouldRunIntegrationTests()) {
    throw new Error("getApiKey should only be called when TEST_INTEGRATION is set");
  }

  let value = process.env[keyName];

  // Fallback for Anthropic: support ANTHROPIC_AUTH_TOKEN for proxy/gateway setups
  if (!value && keyName === "ANTHROPIC_API_KEY") {
    value = process.env.ANTHROPIC_AUTH_TOKEN;
  }

  if (!value) {
    throw new Error(`Environment variable ${keyName} is required for integration tests`);
  }

  return value;
}
