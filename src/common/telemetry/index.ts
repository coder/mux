/**
 * Telemetry module public API
 *
 * This module provides telemetry tracking via PostHog.
 * Events are forwarded to the backend via ORPC to avoid ad-blocker issues.
 * Backend controls whether telemetry is enabled (MUX_DISABLE_TELEMETRY env var).
 * See payload.ts for all data structures sent to PostHog.
 */

export { initTelemetry, trackEvent, shutdownTelemetry } from "./client";
export { trackAppStarted } from "./lifecycle";
export type { TelemetryEventPayload, ErrorContext } from "./payload";
export { roundToBase2 } from "./utils";
