import { z } from "zod";

import {
  AgentPluginGitSourceSchema,
  AgentPluginInstallEntrySchema,
} from "@/common/config/schemas/agentPluginInstalls";

/**
 * oRPC shapes for the managed Agent Plugin installer (agent-plugins
 * experiment). Registry entry + source schemas are shared with the on-disk
 * config schema (single source of truth).
 */

export { AgentPluginGitSourceSchema, AgentPluginInstallEntrySchema };

export const AgentPluginPreviewSkillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

export const AgentPluginPreviewMcpServerSchema = z.object({
  serverName: z.string(),
  transport: z.enum(["stdio", "http", "sse"]),
  /** Human-readable command line (stdio) or URL (remote) shown in the consent preview. */
  summary: z.string(),
});

/** Manifest metadata surfaced in the consent preview (UI-safe projection of plugin.json). */
export const AgentPluginManifestSummarySchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  authorName: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
});

/**
 * Everything a user consents to before anything is written: the resolved
 * source + SHA, the manifest, every skill, and every MCP server command line.
 */
export const AgentPluginInstallPreviewSchema = z.object({
  source: AgentPluginGitSourceSchema,
  /** Commit SHA the preview was computed from; install verifies it gets the same tree. */
  lockedSha: z.string(),
  manifest: AgentPluginManifestSummarySchema,
  skills: z.array(AgentPluginPreviewSkillSchema),
  mcpServers: z.array(AgentPluginPreviewMcpServerSchema),
  /** Manifest warnings + component diagnostics from validating the staged clone. */
  warnings: z.array(z.string()),
  /** Final install directory (~/.mux/plugins/<name>). */
  targetPath: z.string(),
});

export const AgentPluginListItemSchema = z.object({
  name: z.string(),
  /** True when a registry entry exists; unmanaged dirs found by discovery are read-only. */
  managed: z.boolean(),
  /** False for managed entries whose directory vanished (registry self-heal display). */
  present: z.boolean(),
  /** Display location, e.g. "~/.mux/plugins/demo". */
  location: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  source: AgentPluginGitSourceSchema.optional(),
  lockedSha: z.string().optional(),
  installedAt: z.string().optional(),
  updatedAt: z.string().optional(),
  skillCount: z.number().int().nonnegative(),
  mcpServerCount: z.number().int().nonnegative(),
});

export const AgentPluginUpdateCheckSchema = z.object({
  name: z.string(),
  status: z.enum(["up-to-date", "update-available", "tag-moved", "pinned", "error"]),
  /** Remote tip SHA for update-available / tag-moved. */
  remoteSha: z.string().optional(),
  /** Error detail when status is "error". */
  message: z.string().optional(),
});

export type AgentPluginPreviewSkill = z.infer<typeof AgentPluginPreviewSkillSchema>;
export type AgentPluginPreviewMcpServer = z.infer<typeof AgentPluginPreviewMcpServerSchema>;
export type AgentPluginManifestSummary = z.infer<typeof AgentPluginManifestSummarySchema>;
export type AgentPluginInstallPreview = z.infer<typeof AgentPluginInstallPreviewSchema>;
export type AgentPluginListItem = z.infer<typeof AgentPluginListItemSchema>;
export type AgentPluginUpdateCheck = z.infer<typeof AgentPluginUpdateCheckSchema>;
