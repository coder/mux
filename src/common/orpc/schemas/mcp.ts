import { z } from "zod";

/**
 * Per-workspace MCP overrides.
 *
 * Stored in ~/.mux/config.json under each workspace entry.
 * Allows workspaces to disable servers or restrict tool allowlists
 * without modifying the project-level .mux/mcp.jsonc.
 */
export const WorkspaceMCPOverridesSchema = z.object({
  /** Server names to explicitly disable for this workspace. */
  disabledServers: z.array(z.string()).optional(),
  /** Server names to explicitly enable for this workspace (overrides project-level disabled). */
  enabledServers: z.array(z.string()).optional(),

  /**
   * Per-server tool allowlist.
   * Key: server name (from .mux/mcp.jsonc)
   * Value: raw MCP tool names (NOT namespaced)
   *
   * If omitted for a server => expose all tools from that server.
   * If present but empty => expose no tools from that server.
   */
  toolAllowlist: z.record(z.string(), z.array(z.string())).optional(),
});

export const MCPAddParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
  command: z.string(),
});

export const MCPRemoveParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
});

export const MCPSetEnabledParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
  enabled: z.boolean(),
});

export const MCPServerMapSchema = z.record(
  z.string(),
  z.object({
    command: z.string(),
    disabled: z.boolean(),
    toolAllowlist: z.array(z.string()).optional(),
  })
);

export const MCPSetToolAllowlistParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
  /** Tool names to allow. Empty array = no tools allowed. */
  toolAllowlist: z.array(z.string()),
});

/**
 * Unified test params - provide either name (to test configured server) or command (to test arbitrary command).
 * At least one of name or command must be provided.
 */
export const MCPTestParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string().optional(),
  command: z.string().optional(),
});

export const MCPTestResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), tools: z.array(z.string()) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
