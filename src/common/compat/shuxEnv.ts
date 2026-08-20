/**
 * Shared SHUX_* / MUX_* environment readers.
 *
 * Kept free of path aliases so Vite, Playwright, and sandbox scripts can import
 * it before packaged process-wide alias installation runs.
 */

const SHUX_ENV_PREFIX = "SHUX_";
const LEGACY_MUX_ENV_PREFIX = "MUX_";

export type ShuxEnvironment = Record<string, string | undefined>;

/** Resolve a canonical SHUX_* variable, falling back to its legacy MUX_* alias. */
export function resolveShuxEnvironmentValue(
  suffix: string,
  env: ShuxEnvironment
): string | undefined {
  return env[SHUX_ENV_PREFIX + suffix] ?? env[LEGACY_MUX_ENV_PREFIX + suffix];
}

/** Write both the canonical SHUX_* name and the legacy MUX_* alias. */
export function assignShuxEnvironmentValue(
  env: ShuxEnvironment,
  suffix: string,
  value: string
): void {
  env[SHUX_ENV_PREFIX + suffix] = value;
  env[LEGACY_MUX_ENV_PREFIX + suffix] = value;
}
