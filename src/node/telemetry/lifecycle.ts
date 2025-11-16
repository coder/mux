/**
 * Telemetry lifecycle tracking
 *
 * Handles app startup events
 */

import { trackEvent, getBaseTelemetryProperties } from "./index";

/**
 * Check if this is the first app launch
 * Uses localStorage to persist flag across sessions
 * Checks legacy key for backward compatibility
 */
function checkFirstLaunch(): boolean {
  const key = "mux_first_launch_complete";
  const legacyKey = "cmux_first_launch_complete";

  // Check new key first
  const hasLaunchedBefore = localStorage.getItem(key);
  if (hasLaunchedBefore) {
    return false;
  }

  // Migrate from legacy key if it exists
  const legacyValue = localStorage.getItem(legacyKey);
  if (legacyValue) {
    localStorage.setItem(key, legacyValue);
    localStorage.removeItem(legacyKey);
    return false;
  }

  // First launch - set the flag
  localStorage.setItem(key, "true");
  return true;
}

/**
 * Track app startup
 * Should be called once when the app initializes
 */
export function trackAppStarted(): void {
  const isFirstLaunch = checkFirstLaunch();

  console.debug("[Telemetry] trackAppStarted", { isFirstLaunch });

  trackEvent({
    event: "app_started",
    properties: {
      ...getBaseTelemetryProperties(),
      isFirstLaunch,
    },
  });
}
