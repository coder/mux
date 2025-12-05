/**
 * Telemetry lifecycle tracking
 *
 * Handles app startup events
 */

import { trackEvent } from "./index";
import { VIM_ENABLED_KEY } from "@/common/constants/storage";

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
 * Check if vim mode is enabled
 */
function checkVimModeEnabled(): boolean {
  return localStorage.getItem(VIM_ENABLED_KEY) === "true";
}

/**
 * Track app startup
 * Should be called once when the app initializes
 */
export function trackAppStarted(): void {
  const isFirstLaunch = checkFirstLaunch();
  const vimModeEnabled = checkVimModeEnabled();

  console.debug("[Telemetry] trackAppStarted", { isFirstLaunch, vimModeEnabled });

  trackEvent({
    event: "app_started",
    properties: {
      isFirstLaunch,
      vimModeEnabled,
    },
  });
}
