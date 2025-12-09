import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Default runtime configuration for worktree workspaces.
 * Uses git worktrees for workspace isolation.
 * Used when no runtime config is specified.
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  type: "worktree",
  srcBaseDir: "~/.mux/src",
} as const;
