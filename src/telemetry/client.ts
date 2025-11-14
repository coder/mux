/**
 * PostHog Telemetry Client
 *
 * Provides a type-safe interface for sending telemetry events to PostHog.
 * All payloads are defined in ./payload.ts for transparency.
 */

import posthog from "posthog-js";
import type { TelemetryEventPayload } from "./payload";

// Default configuration (public keys, safe to commit)
const DEFAULT_POSTHOG_KEY = "phc_vF1bLfiD5MXEJkxojjsmV5wgpLffp678yhJd3w9Sl4G";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// Get PostHog configuration from environment variables with fallback to defaults
// Note: Vite injects import.meta.env at build time, so this is safe in the browser
// In test environments, we never call this function (see isTestEnvironment check)
function getPosthogConfig(): { key: string; host: string } {
  // Use indirect access to avoid Jest parsing issues with import.meta
  // This works because Vite transforms import.meta.env at build time
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
    const meta = new Function("return import.meta")() as
      | {
          env?: { VITE_PUBLIC_POSTHOG_KEY?: string; VITE_PUBLIC_POSTHOG_HOST?: string };
        }
      | undefined;
    if (meta?.env) {
      return {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        key: meta.env.VITE_PUBLIC_POSTHOG_KEY || DEFAULT_POSTHOG_KEY,
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        host: meta.env.VITE_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
      };
    }
  } catch {
    // import.meta not available (e.g., in test environment)
  }
  return {
    key: DEFAULT_POSTHOG_KEY,
    host: DEFAULT_POSTHOG_HOST,
  };
}

let isInitialized = false;

// Storage key for telemetry enabled preference
const TELEMETRY_ENABLED_KEY = "mux_telemetry_enabled";
const LEGACY_TELEMETRY_KEY = "mux_telemetry_enabled";

/**
 * Check if telemetry is enabled by user preference
 * Default is true (opt-out model)
 * Checks legacy key for backward compatibility
 */
export function isTelemetryEnabled(): boolean {
  if (typeof window === "undefined") return true;

  // Try new key first, then legacy key
  const stored = localStorage.getItem(TELEMETRY_ENABLED_KEY);
  if (stored !== null) {
    return stored === "true";
  }

  // Migrate from legacy key if it exists
  const legacy = localStorage.getItem(LEGACY_TELEMETRY_KEY);
  if (legacy !== null) {
    localStorage.setItem(TELEMETRY_ENABLED_KEY, legacy);
    localStorage.removeItem(LEGACY_TELEMETRY_KEY);
    return legacy === "true";
  }

  return true; // Default to enabled
}

/**
 * Set telemetry enabled preference
 */
export function setTelemetryEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(TELEMETRY_ENABLED_KEY, enabled.toString());
  console.log(`[Telemetry] ${enabled ? "Enabled" : "Disabled"}`);
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
 * Initialize the PostHog client
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
    console.warn("Telemetry already initialized");
    return;
  }

  const config = getPosthogConfig();
  posthog.init(config.key, {
    api_host: config.host,
    // Disable all automatic tracking - we only send explicit events
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    capture_performance: false, // Disables web vitals
    disable_session_recording: true,
    // Note: We still want error tracking to work through our explicit error_occurred event
    loaded: (ph) => {
      // Identify user with a stable anonymous ID based on machine
      // This allows us to track usage patterns without PII
      ph.identify();
    },
  });

  isInitialized = true;
  console.debug("[Telemetry] PostHog initialized", { host: config.host });
}

/**
 * Send a telemetry event to PostHog
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

  if (!isInitialized) {
    console.debug("[Telemetry] Not initialized, skipping event:", payload.event);
    return;
  }

  // Debug log to verify events are being sent
  console.debug("[Telemetry] Sending event:", {
    event: payload.event,
    properties: payload.properties,
  });

  posthog.capture(payload.event, payload.properties);
}

/**
 * Shutdown telemetry and flush any pending events
 * Should be called on app close
 */
export function shutdownTelemetry(): void {
  if (!isInitialized) {
    return;
  }

  posthog.reset();
  isInitialized = false;
}

/**
 * Check if telemetry is initialized
 */
export function isTelemetryInitialized(): boolean {
  return isInitialized;
}
