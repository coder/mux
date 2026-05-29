/**
 * Environment variable parsing utilities
 */

/**
 * Parse environment variable as boolean
 * Accepts: "1", "true", "TRUE", "yes", "YES" as true
 * Everything else (including undefined, "0", "false", "FALSE") as false
 */
export function parseBoolEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Parse DEBUG_UPDATER and DEBUG_UPDATER_FAIL environment variables.
 *
 * Returns:
 * - enabled: true when DEBUG_UPDATER is set to a truthy value or a version string
 * - fakeVersion: populated when DEBUG_UPDATER is a version string
 * - failPhase: optional simulated failure phase for fake updater flows
 *
 * Examples:
 * - DEBUG_UPDATER=1 → { enabled: true }
 * - DEBUG_UPDATER=true → { enabled: true }
 * - DEBUG_UPDATER=1.2.3 → { enabled: true, fakeVersion: "1.2.3" }
 * - DEBUG_UPDATER=1.2.3 DEBUG_UPDATER_FAIL=download →
 *   { enabled: true, fakeVersion: "1.2.3", failPhase: "download" }
 * - undefined → { enabled: false }
 */
export function parseDebugUpdater(
  value: string | undefined,
  failValue?: string
): {
  enabled: boolean;
  fakeVersion?: string;
  failPhase?: "check" | "download" | "install";
} {
  const result: {
    enabled: boolean;
    fakeVersion?: string;
    failPhase?: "check" | "download" | "install";
  } = { enabled: false };

  if (!value) {
    return result;
  }

  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    result.enabled = true;
  } else {
    // Not a bool, treat as version string
    result.enabled = true;
    result.fakeVersion = value;
  }

  if (failValue) {
    const normalizedFailValue = failValue.toLowerCase();
    if (
      normalizedFailValue === "check" ||
      normalizedFailValue === "download" ||
      normalizedFailValue === "install"
    ) {
      result.failPhase = normalizedFailValue;
    }
  }

  return result;
}
