import { z } from "zod";

/**
 * Managed Agent Plugin install registry — the `plugins` section of
 * `~/.mux/config.json`.
 *
 * Semantics (mirroring lazy.nvim / Claude Code): `source.ref` is the tracking
 * channel and `lockedSha` is what is actually on disk and runs. Install
 * resolves ref → SHA and records both; the runtime never follows a branch
 * implicitly — updates apply only on explicit user action.
 *
 * The registry only annotates installs. Plugin discovery
 * (src/node/services/agentPlugins/discovery.ts) remains the source of truth
 * for what loads, so drift between registry and disk self-heals: directories
 * without a registry entry show as "unmanaged", entries without a directory
 * show as "missing".
 */

export const AgentPluginGitSourceSchema = z.object({
  type: z.literal("git"),
  /** Normalized clone URL (https or ssh) derived from the user's input. */
  url: z.string().min(1),
  /** Tracking ref: branch name, tag name, or full 40-hex commit SHA. */
  ref: z.string().min(1),
  /**
   * How `ref` is treated by update checks: branches track their remote tip,
   * tags are pinned but warn when the tag moves, commits are fully pinned.
   */
  refType: z.enum(["branch", "tag", "commit"]),
  /**
   * Repo-relative directory of the plugin for monorepo installs. Parsed and
   * persisted from day one so the descriptor grammar is stable, but v1
   * rejects subpath installs (sparse-checkout staging lands in v2).
   */
  subpath: z.string().optional(),
});

/**
 * Tagged union so future source kinds (`path`, `archive`, `catalog`) slot in
 * without a registry migration.
 */
export const AgentPluginInstallSourceSchema = z.discriminatedUnion("type", [
  AgentPluginGitSourceSchema,
]);

export const AgentPluginInstallEntrySchema = z.object({
  /** plugin.json `name`; also the directory name under `~/.mux/plugins`. */
  name: z.string().min(1),
  /** v1 installs are global-only; the installer never writes into project checkouts. */
  scope: z.literal("global"),
  source: AgentPluginInstallSourceSchema,
  /** Commit SHA of the tree installed on disk (what actually runs). */
  lockedSha: z.string().min(1),
  /** ISO-8601 install timestamp. */
  installedAt: z.string().min(1),
  /** ISO-8601 timestamp of the most recent applied update. */
  updatedAt: z.string().optional(),
  /** Cached manifest metadata so the list UI works offline / when the dir is missing. */
  manifest: z
    .object({
      version: z.string().optional(),
      description: z.string().optional(),
    })
    .optional(),
  /** Reserved: per-plugin opt-in auto-update. Unused in v1 — updates are badge + manual. */
  autoUpdate: z.boolean().optional(),
});

export const AgentPluginInstallsSchema = z.array(AgentPluginInstallEntrySchema);

export type AgentPluginGitSource = z.infer<typeof AgentPluginGitSourceSchema>;
export type AgentPluginInstallSource = z.infer<typeof AgentPluginInstallSourceSchema>;
export type AgentPluginInstallEntry = z.infer<typeof AgentPluginInstallEntrySchema>;
