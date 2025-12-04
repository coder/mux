/**
 * PostHog Telemetry Client (Frontend)
 *
 * Provides a type-safe interface for sending telemetry events to PostHog.
 * Events are forwarded to the backend via ORPC, which handles the actual
 * PostHog communication. This avoids ad-blocker issues.
 *
 * All payloads are defined in ./payload.ts for transparency.
 */

import type { TelemetryEventPayload } from "./payload";

let isInitialized = false;

// Storage key for telemetry enabled preference
const TELEMETRY_ENABLED_KEY = "mux_telemetry_enabled";

/**
 * Check if telemetry is enabled by user preference
 * Default is true (opt-out model)
 */
export function isTelemetryEnabled(): boolean {
  if (typeof window === "undefined") return true;

  const stored = localStorage.getItem(TELEMETRY_ENABLED_KEY);
  if (stored !== null) {
    return stored === "true";
  }

  return true; // Default to enabled
}

/**
 * Set telemetry enabled preference
 * This updates both local preference and notifies the backend
 */
export function setTelemetryEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;

  localStorage.setItem(TELEMETRY_ENABLED_KEY, enabled.toString());
  console.debug(`[Telemetry] ${enabled ? "Enabled" : "Disabled"}`);

  // Notify backend of preference change
  const client = window.__ORPC_CLIENT__;
  if (client) {
    client.telemetry.setEnabled({ enabled }).catch((err: unknown) => {
      console.debug("[Telemetry] Failed to sync enabled state to backend:", err);
    });
  }
}

/**
 * Check if we're running in a test environment
 */
function isTestEnvironment(): boolean {
  // Check various test environment indicators
  return (
    typeof process !== "undefined" &&
    (process.env.NODE_ENV === "test" ||
      process.env.JEST_WORKER_ID !== undefined ||
      process.env.VITEST !== undefined ||
      process.env.TEST_INTEGRATION === "1")
  );
}

/**
 * Initialize telemetry
 * Should be called once on app startup
 *
 * Note: Telemetry is automatically disabled in test environments or when user has opted out
 */
export function initTelemetry(): void {
  if (isTestEnvironment()) {
    return;
  }

  if (!isTelemetryEnabled()) {
    console.debug("[Telemetry] Disabled by user preference, skipping initialization");
    return;
  }

  if (isInitialized) {
    console.debug("[Telemetry] Already initialized");
    return;
  }

  isInitialized = true;
  console.debug("[Telemetry] Initialized (backend mode)");
  // No need to sync enabled state - backend defaults to enabled,
  // and frontend guards all trackEvent calls with isTelemetryEnabled()
}

/**
 * Send a telemetry event via the backend
 * Events are type-safe and must match definitions in payload.ts
 *
 * Note: Events are silently ignored in test environments or when disabled by user
 */
export function trackEvent(payload: TelemetryEventPayload): void {
  if (isTestEnvironment()) {
    // Silently ignore telemetry in tests
    return;
  }

  if (!isTelemetryEnabled()) {
    // Silently ignore when user has disabled telemetry
    return;
  }

  const client = window.__ORPC_CLIENT__;
  if (!client) {
    console.debug("[Telemetry] ORPC client not available, skipping event:", payload.event);
    return;
  }

  // Debug log to verify events are being sent
  console.debug("[Telemetry] Sending event via backend:", {
    event: payload.event,
  });

  // Fire and forget - don't block on telemetry
  client.telemetry.track(payload).catch((err: unknown) => {
    console.debug("[Telemetry] Failed to track event:", err);
  });
}

/**
 * Shutdown telemetry
 * The backend handles flushing pending events
 */
export function shutdownTelemetry(): void {
  if (!isInitialized) {
    return;
  }

  isInitialized = false;
  console.debug("[Telemetry] Shut down");
}

/**
 * Check if telemetry is initialized
 */
export function isTelemetryInitialized(): boolean {
  return isInitialized;
}
