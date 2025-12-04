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
 * Check if we're running in a test environment
 */
function isTestEnvironment(): boolean {
  return (
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "test" ||
      process.env.JEST_WORKER_ID !== undefined ||
      process.env.VITEST !== undefined ||
      process.env.TEST_INTEGRATION === "1")
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
