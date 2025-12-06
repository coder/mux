/**
 * PostHog Telemetry Client (Frontend)
 *
 * Forwards telemetry events to the backend via ORPC.
 * The backend decides whether to actually send events to PostHog
 * (controlled by MUX_DISABLE_TELEMETRY environment variable).
 *
 * This design avoids ad-blocker issues and centralizes control.
 * All payloads are defined in ./payload.ts for transparency.
 */

import type { TelemetryEventPayload } from "./payload";

/**
 * Check if running in a CI/automation environment.
 * Covers major CI providers. This is a subset of what the backend checks
 * since the browser process has limited env var access.
 */
function isCIEnvironment(): boolean {
  if (typeof process === "undefined") {
    return false;
  }
  return (
    process.env.CI === "true" ||
    process.env.CI === "1" ||
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GITLAB_CI === "true" ||
    process.env.JENKINS_URL !== undefined ||
    process.env.CIRCLECI === "true"
  );
}

/**
 * Check if we're running in a test or CI environment
 */
function isTestEnvironment(): boolean {
  return (
    (typeof process !== "undefined" &&
      (process.env.NODE_ENV === "test" ||
        process.env.JEST_WORKER_ID !== undefined ||
        process.env.VITEST !== undefined ||
        process.env.TEST_INTEGRATION === "1")) ||
    isCIEnvironment()
  );
}

/**
 * Initialize telemetry (no-op, kept for API compatibility)
 */
export function initTelemetry(): void {
  // No-op - backend handles initialization
}

/**
 * Send a telemetry event via the backend
 * Events are type-safe and must match definitions in payload.ts
 *
 * The backend decides whether to actually send to PostHog.
 */
export function trackEvent(payload: TelemetryEventPayload): void {
  if (isTestEnvironment()) {
    return;
  }

  const client = window.__ORPC_CLIENT__;
  if (!client) {
    return;
  }

  // Fire and forget - don't block on telemetry
  client.telemetry.track(payload).catch(() => {
    // Silently ignore errors
  });
}

/**
 * Shutdown telemetry (no-op, kept for API compatibility)
 */
export function shutdownTelemetry(): void {
  // No-op - backend handles shutdown
}
