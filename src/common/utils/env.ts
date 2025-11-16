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
 * Parse DEBUG_UPDATER environment variable
 * Returns: { enabled: boolean, fakeVersion?: string }
 *
 * Examples:
 * - DEBUG_UPDATER=1 → { enabled: true }
 * - DEBUG_UPDATER=true → { enabled: true }
 * - DEBUG_UPDATER=1.2.3 → { enabled: true, fakeVersion: "1.2.3" }
 * - undefined → { enabled: false }
 */
export function parseDebugUpdater(value: string | undefined): {
  enabled: boolean;
  fakeVersion?: string;
} {
  if (!value) return { enabled: false };

  const normalized = value.toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return { enabled: true };
  }

  // Not a bool, treat as version string
  return { enabled: true, fakeVersion: value };
}
