/**
 * Telemetry module public API
 *
 * This module provides telemetry tracking via PostHog.
 * See payload.ts for all data structures sent to PostHog.
 */

export {
  initTelemetry,
  trackEvent,
  shutdownTelemetry,
  isTelemetryInitialized,
  isTelemetryEnabled,
  setTelemetryEnabled,
} from "./client";
export { trackAppStarted } from "./lifecycle";
export type { TelemetryEventPayload, ErrorContext } from "./payload";
export { getBaseTelemetryProperties, roundToBase2 } from "./utils";
