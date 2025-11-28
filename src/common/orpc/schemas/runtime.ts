import { z } from "zod";

export const RuntimeModeSchema = z.enum(["local", "worktree", "ssh"]);

/**
 * Runtime configuration union type.
 *
 * COMPATIBILITY NOTE:
 * - `type: "local"` with `srcBaseDir` = legacy worktree config (for backward compat)
 * - `type: "local"` without `srcBaseDir` = new project-dir runtime
 * - `type: "worktree"` = explicit worktree runtime (new workspaces)
 *
 * This allows two-way compatibility: users can upgrade/downgrade without breaking workspaces.
 */
export const RuntimeConfigSchema = z.union([
  // Legacy local with srcBaseDir (treated as worktree)
  z.object({
    type: z.literal("local"),
    srcBaseDir: z.string().meta({
      description: "Base directory where all workspaces are stored (legacy worktree config)",
    }),
  }),
  // New project-dir local (no srcBaseDir)
  z.object({
    type: z.literal("local"),
  }),
  // Explicit worktree runtime
  z.object({
    type: z.literal("worktree"),
    srcBaseDir: z
      .string()
      .meta({ description: "Base directory where all workspaces are stored (e.g., ~/.mux/src)" }),
  }),
  // SSH runtime
  z.object({
    type: z.literal("ssh"),
    host: z
      .string()
      .meta({ description: "SSH host (can be hostname, user@host, or SSH config alias)" }),
    srcBaseDir: z
      .string()
      .meta({ description: "Base directory on remote host where all workspaces are stored" }),
    identityFile: z
      .string()
      .optional()
      .meta({ description: "Path to SSH private key (if not using ~/.ssh/config or ssh-agent)" }),
    port: z.number().optional().meta({ description: "SSH port (default: 22)" }),
  }),
]);
