/**
 * Telemetry lifecycle tracking
 *
 * Handles app startup events
 */

import { trackEvent } from "./index";

// Storage key for first launch tracking
const FIRST_LAUNCH_KEY = "mux_first_launch_complete";

/**
 * Check if this is the first app launch
 * Uses localStorage to persist flag across sessions
 */
function checkFirstLaunch(): boolean {
  const hasLaunchedBefore = localStorage.getItem(FIRST_LAUNCH_KEY);
  if (hasLaunchedBefore) {
    return false;
  }

  // First launch - set the flag
  localStorage.setItem(FIRST_LAUNCH_KEY, "true");
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
      isFirstLaunch,
    },
  });
}
