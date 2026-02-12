/**
 * Shared test utilities for integration tests
 *
 * This module handles:
 * - Loading .env configuration for tests
 * - Validating required API keys
 */

import { config } from "dotenv";
import * as path from "path";

// Load .env from project root on module import
// This runs once when the module is first imported
config({ path: path.resolve(__dirname, "../.env"), quiet: true });

/**
 * Validate required API keys are present.
 * Throws if any key is missing from the environment.
 */
export function validateApiKeys(requiredKeys: string[]): void {
  const missing = requiredKeys.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}\n` +
        `Set them in .env or the environment to run these tests.`
    );
  }
}

/**
 * Get API key from environment or throw if missing.
 */
export function getApiKey(keyName: string): string {
  const value = process.env[keyName];
  if (!value) {
    throw new Error(`Environment variable ${keyName} is required for integration tests`);
  }

  return value;
}
