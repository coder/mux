/**
 * Runtime configuration types for workspace execution environments
 */

/** Runtime mode type - used in UI and runtime string parsing */
export type RuntimeMode = "worktree" | "local" | "ssh";

/** Runtime mode constants */
export const RUNTIME_MODE = {
  WORKTREE: "worktree" as const,
  LOCAL: "local" as const,
  SSH: "ssh" as const,
} as const;

/** Runtime string prefix for SSH mode (e.g., "ssh hostname") */
export const SSH_RUNTIME_PREFIX = "ssh ";

export type RuntimeConfig =
  | {
      type: "worktree";
      /** Base directory where all workspaces are stored (e.g., ~/.mux/src) */
      srcBaseDir: string;
    }
  | {
      type: "local";
    }
  | {
      type: "ssh";
      /** SSH host (can be hostname, user@host, or SSH config alias) */
      host: string;
      /** Base directory on remote host where all workspaces are stored */
      srcBaseDir: string;
      /** Optional: Path to SSH private key (if not using ~/.ssh/config or ssh-agent) */
      identityFile?: string;
      /** Optional: SSH port (default: 22) */
      port?: number;
    };

/**
 * Parse runtime string from localStorage or UI input into mode and host
 * Format: "ssh <host>" -> { mode: "ssh", host: "<host>" }
 *         "ssh" -> { mode: "ssh", host: "" }
 *         "local" -> { mode: "local", host: "" }
 *         "worktree" or undefined -> { mode: "worktree", host: "" }
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

  // Handle both "ssh" and "ssh <host>"
  if (lowerTrimmed === RUNTIME_MODE.SSH || lowerTrimmed.startsWith(SSH_RUNTIME_PREFIX)) {
    const host = trimmed.substring(SSH_RUNTIME_PREFIX.length).trim();
    return { mode: RUNTIME_MODE.SSH, host };
  }

  // Default to worktree for unrecognized strings (backward compatibility)
  return { mode: RUNTIME_MODE.WORKTREE, host: "" };
}

/**
 * Build runtime string for storage/IPC from mode and host
 * Returns: "ssh <host>" for SSH with host, "ssh" for SSH without host,
 *          "local" for in-place local mode, undefined for worktree mode
 */
export function buildRuntimeString(mode: RuntimeMode, host: string): string | undefined {
  if (mode === RUNTIME_MODE.SSH) {
    const trimmedHost = host.trim();
    // Persist SSH mode even without a host so UI remains in SSH state
    return trimmedHost ? `${SSH_RUNTIME_PREFIX}${trimmedHost}` : RUNTIME_MODE.SSH;
  }

  if (mode === RUNTIME_MODE.LOCAL) {
    return RUNTIME_MODE.LOCAL;
  }

  // Worktree is the default - omit to keep backward compatibility with older prefs
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
