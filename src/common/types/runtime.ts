/**
 * Runtime configuration types for workspace execution environments
 */

import type { z } from "zod";
import type { RuntimeConfigSchema } from "../orpc/schemas";
import { RuntimeModeSchema } from "../orpc/schemas";

/** Runtime mode type - used in UI and runtime string parsing */
export type RuntimeMode = z.infer<typeof RuntimeModeSchema>;

/** Runtime mode constants */
export const RUNTIME_MODE = {
  LOCAL: "local" as const,
  SSH: "ssh" as const,
} as const;

/** Runtime string prefix for SSH mode (e.g., "ssh hostname") */
export const SSH_RUNTIME_PREFIX = "ssh ";

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Parse runtime string from localStorage or UI input into mode and host
 * Format: "ssh <host>" -> { mode: "ssh", host: "<host>" }
 *         "ssh" -> { mode: "ssh", host: "" }
 *         "local" or undefined -> { mode: "local", host: "" }
 *
 * Use this for UI state management (localStorage, form inputs)
 */
export function parseRuntimeModeAndHost(runtime: string | null | undefined): {
  mode: RuntimeMode;
  host: string;
} {
  if (!runtime) {
    return { mode: RUNTIME_MODE.LOCAL, host: "" };
  }

  const trimmed = runtime.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  // Check for "ssh <host>" format first (before trying to parse as plain mode)
  if (lowerTrimmed.startsWith(SSH_RUNTIME_PREFIX)) {
    const host = trimmed.substring(SSH_RUNTIME_PREFIX.length).trim();
    return { mode: RUNTIME_MODE.SSH, host };
  }

  // Try to parse as a plain mode ("ssh" or "local")
  const modeResult = RuntimeModeSchema.safeParse(lowerTrimmed);
  if (!modeResult.success) {
    // Default to local for unrecognized strings
    return { mode: RUNTIME_MODE.LOCAL, host: "" };
  }

  const mode = modeResult.data;

  if (mode === RUNTIME_MODE.SSH) {
    // Plain "ssh" without host
    return { mode, host: "" };
  }

  // Local mode or default
  return { mode: RUNTIME_MODE.LOCAL, host: "" };
}

/**
 * Build runtime string for storage/IPC from mode and host
 * Returns: "ssh <host>" for SSH with host, "ssh" for SSH without host, undefined for local
 */
export function buildRuntimeString(mode: RuntimeMode, host: string): string | undefined {
  if (mode === RUNTIME_MODE.SSH) {
    const trimmedHost = host.trim();
    // Persist SSH mode even without a host so UI remains in SSH state
    return trimmedHost ? `${SSH_RUNTIME_PREFIX}${trimmedHost}` : "ssh";
  }
  return undefined;
}

/**
 * Type guard to check if a runtime config is SSH
 */
export function isSSHRuntime(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { type: "ssh" }> {
  return config?.type === "ssh";
}
