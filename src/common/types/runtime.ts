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
  DOCKER: "docker" as const,
} as const;

/**
 * Runtime modes that require a git repository.
 *
 * Worktree/SSH/Docker all depend on git operations (worktrees, clones, bundles).
 * Local runtime can operate directly in a directory without git.
 */
export const RUNTIME_MODES_REQUIRING_GIT: RuntimeMode[] = [
  RUNTIME_MODE.WORKTREE,
  RUNTIME_MODE.SSH,
  RUNTIME_MODE.DOCKER,
];

/** Runtime string prefix for SSH mode (e.g., "ssh hostname") */
export const SSH_RUNTIME_PREFIX = "ssh ";

/** Runtime string prefix for Docker mode (e.g., "docker ubuntu:22.04") */
export const DOCKER_RUNTIME_PREFIX = "docker ";

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

/**
 * Parsed runtime result - discriminated union based on mode.
 * SSH requires host, Docker requires image, others have no extra args.
 */
export type ParsedRuntime =
  | { mode: "local" }
  | { mode: "worktree" }
  | { mode: "ssh"; host: string }
  | { mode: "docker"; image: string; shareCredentials?: boolean };

/**
 * Parse runtime string from localStorage or UI input into structured result.
 * Format: "ssh <host>" -> { mode: "ssh", host: "<host>" }
 *         "docker <image>" -> { mode: "docker", image: "<image>" }
 *         "worktree" -> { mode: "worktree" }
 *         "local" -> { mode: "local" }
 *         undefined/null -> { mode: "worktree" } (default)
 *
 * Note: "ssh" or "docker" without arguments returns null (invalid).
 * Use this for UI state management (localStorage, form inputs).
 */
export function parseRuntimeModeAndHost(runtime: string | null | undefined): ParsedRuntime | null {
  if (!runtime) {
    return { mode: RUNTIME_MODE.WORKTREE };
  }

  const trimmed = runtime.trim();
  const lowerTrimmed = trimmed.toLowerCase();

  if (lowerTrimmed === RUNTIME_MODE.LOCAL) {
    return { mode: RUNTIME_MODE.LOCAL };
  }

  if (lowerTrimmed === RUNTIME_MODE.WORKTREE) {
    return { mode: RUNTIME_MODE.WORKTREE };
  }

  // Check for "ssh <host>" format
  if (lowerTrimmed.startsWith(SSH_RUNTIME_PREFIX)) {
    const host = trimmed.substring(SSH_RUNTIME_PREFIX.length).trim();
    if (!host) return null; // "ssh " without host is invalid
    return { mode: RUNTIME_MODE.SSH, host };
  }

  // Plain "ssh" without host is invalid
  if (lowerTrimmed === RUNTIME_MODE.SSH) {
    return null;
  }

  // Check for "docker <image>" format
  if (lowerTrimmed.startsWith(DOCKER_RUNTIME_PREFIX)) {
    const image = trimmed.substring(DOCKER_RUNTIME_PREFIX.length).trim();
    if (!image) return null; // "docker " without image is invalid
    return { mode: RUNTIME_MODE.DOCKER, image };
  }

  // Plain "docker" without image is invalid
  if (lowerTrimmed === RUNTIME_MODE.DOCKER) {
    return null;
  }

  // Try to parse as a plain mode (local/worktree)
  const modeResult = RuntimeModeSchema.safeParse(lowerTrimmed);
  if (modeResult.success) {
    const mode = modeResult.data;
    if (mode === "local") return { mode: "local" };
    if (mode === "worktree") return { mode: "worktree" };
    // ssh/docker without args handled above
  }

  // Unrecognized - return null
  return null;
}

/**
 * Build runtime string for storage/IPC from parsed runtime.
 * Returns: "ssh <host>" for SSH, "docker <image>" for Docker, "local" for local, undefined for worktree (default)
 */
export function buildRuntimeString(parsed: ParsedRuntime): string | undefined {
  switch (parsed.mode) {
    case RUNTIME_MODE.SSH:
      return `${SSH_RUNTIME_PREFIX}${parsed.host}`;
    case RUNTIME_MODE.DOCKER:
      return `${DOCKER_RUNTIME_PREFIX}${parsed.image}`;
    case RUNTIME_MODE.LOCAL:
      return "local";
    case RUNTIME_MODE.WORKTREE:
      // Worktree is default, no string needed
      return undefined;
  }
}

/**
 * Convert ParsedRuntime to RuntimeConfig for workspace creation.
 * This preserves all fields (like shareCredentials for Docker) that would be lost
 * in string serialization via buildRuntimeString + parseRuntimeString.
 */
export function buildRuntimeConfig(parsed: ParsedRuntime): RuntimeConfig | undefined {
  switch (parsed.mode) {
    case RUNTIME_MODE.SSH:
      return {
        type: RUNTIME_MODE.SSH,
        host: parsed.host,
        srcBaseDir: "~/mux", // Default remote base directory (tilde resolved by backend)
      };
    case RUNTIME_MODE.DOCKER:
      return {
        type: RUNTIME_MODE.DOCKER,
        image: parsed.image,
        shareCredentials: parsed.shareCredentials,
      };
    case RUNTIME_MODE.LOCAL:
      return { type: RUNTIME_MODE.LOCAL };
    case RUNTIME_MODE.WORKTREE:
      // Worktree uses system default config
      return undefined;
  }
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
 * Type guard to check if a runtime config is Docker
 */
export function isDockerRuntime(
  config: RuntimeConfig | undefined
): config is Extract<RuntimeConfig, { type: "docker" }> {
  return config?.type === "docker";
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
