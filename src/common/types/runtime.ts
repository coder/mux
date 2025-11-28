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
  WORKTREE: "worktree" as const,
  SSH: "ssh" as const,
} as const;

/** Runtime string prefix for SSH mode (e.g., "ssh hostname") */
export const SSH_RUNTIME_PREFIX = "ssh ";

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Parse runtime string from localStorage or UI input into mode and host
 * Format: "ssh <host>" -> { mode: "ssh", host: "<host>" }
 *         "ssh" -> { mode: "ssh", host: "" }
 *         "worktree" -> { mode: "worktree", host: "" }
 *         "local" or undefined -> { mode: "local", host: "" }
 *
 * Use this for UI state management (localStorage, form inputs)
 */
export function parseRuntimeModeAndHost(runtime: string | null | undefined): {
  mode: RuntimeMode;
  host: string;
} {
  if (!runtime) {
    return { mode: RUNTIME_MODE.WORKTREE, host: "" };
  }

  const trimmed = runtime.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  if (lowerTrimmed === RUNTIME_MODE.LOCAL) {
    return { mode: RUNTIME_MODE.LOCAL, host: "" };
  }

  if (lowerTrimmed === RUNTIME_MODE.WORKTREE) {
    return { mode: RUNTIME_MODE.WORKTREE, host: "" };
  }

  // Check for "ssh <host>" format first (before trying to parse as plain mode)
  if (lowerTrimmed.startsWith(SSH_RUNTIME_PREFIX)) {
    const host = trimmed.substring(SSH_RUNTIME_PREFIX.length).trim();
    return { mode: RUNTIME_MODE.SSH, host };
  }

  // Plain "ssh" without host
  if (lowerTrimmed === RUNTIME_MODE.SSH) {
    return { mode: RUNTIME_MODE.SSH, host: "" };
  }

  // Try to parse as a plain mode
  const modeResult = RuntimeModeSchema.safeParse(lowerTrimmed);
  if (modeResult.success) {
    return { mode: modeResult.data, host: "" };
  }

  // Default to local for unrecognized strings
  return { mode: RUNTIME_MODE.LOCAL, host: "" };
}

/**
 * Build runtime string for storage/IPC from mode and host
 * Returns: "ssh <host>" for SSH, "local" for local, undefined for worktree (default)
 */
export function buildRuntimeString(mode: RuntimeMode, host: string): string | undefined {
  if (mode === RUNTIME_MODE.SSH) {
    const trimmedHost = host.trim();
    // Persist SSH mode even without a host so UI remains in SSH state
    return trimmedHost ? `${SSH_RUNTIME_PREFIX}${trimmedHost}` : "ssh";
  }
  if (mode === RUNTIME_MODE.LOCAL) {
    return "local";
  }
  // Worktree is default, no string needed
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

/**
 * Type guard to check if a runtime config uses worktree semantics.
 * This includes both explicit "worktree" type AND legacy "local" with srcBaseDir.
 */
export function isWorktreeRuntime(
  config: RuntimeConfig | undefined
): config is
  | Extract<RuntimeConfig, { type: "worktree" }>
  | Extract<RuntimeConfig, { type: "local"; srcBaseDir: string }> {
  if (!config) return false;
  if (config.type === "worktree") return true;
  // Legacy: "local" with srcBaseDir is treated as worktree
  if (config.type === "local" && "srcBaseDir" in config && config.srcBaseDir) return true;
  return false;
}

/**
 * Type guard to check if a runtime config is project-dir local (no isolation)
 */
export function isLocalProjectRuntime(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { type: "local"; srcBaseDir?: never }> {
  if (!config) return false;
  // "local" without srcBaseDir is project-dir runtime
  return config.type === "local" && !("srcBaseDir" in config && config.srcBaseDir);
}

/**
 * Type guard to check if a runtime config has srcBaseDir (worktree-style runtimes).
 * This narrows the type to allow safe access to srcBaseDir.
 */
export function hasSrcBaseDir(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { srcBaseDir: string }> {
  if (!config) return false;
  return "srcBaseDir" in config && typeof config.srcBaseDir === "string";
}

/**
 * Helper to safely get srcBaseDir from a runtime config.
 * Returns undefined for project-dir local configs.
 */
export function getSrcBaseDir(config: RuntimeConfig | undefined): string | undefined {
  if (!config) return undefined;
  if (hasSrcBaseDir(config)) return config.srcBaseDir;
  return undefined;
}
