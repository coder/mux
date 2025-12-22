import { z } from "zod";

/**
 * Per-workspace MCP overrides.
 *
 * Stored per-workspace in <workspace>/.mux/mcp.local.jsonc (workspace-local, intended to be gitignored).
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

export const MCPTransportSchema = z.enum(["stdio", "http", "sse", "auto"]);

export const MCPHeaderValueSchema = z.union([z.string(), z.object({ secret: z.string() })]);
export const MCPHeadersSchema = z.record(z.string(), MCPHeaderValueSchema);

export const MCPServerInfoSchema = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    command: z.string(),
    disabled: z.boolean(),
    toolAllowlist: z.array(z.string()).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    url: z.string(),
    headers: MCPHeadersSchema.optional(),
    disabled: z.boolean(),
    toolAllowlist: z.array(z.string()).optional(),
  }),
  z.object({
    transport: z.literal("sse"),
    url: z.string(),
    headers: MCPHeadersSchema.optional(),
    disabled: z.boolean(),
    toolAllowlist: z.array(z.string()).optional(),
  }),
  z.object({
    transport: z.literal("auto"),
    url: z.string(),
    headers: MCPHeadersSchema.optional(),
    disabled: z.boolean(),
    toolAllowlist: z.array(z.string()).optional(),
  }),
]);

export const MCPServerMapSchema = z.record(z.string(), MCPServerInfoSchema);

export const MCPAddParamsSchema = z
  .object({
    projectPath: z.string(),
    name: z.string(),

    // Backward-compatible: if transport omitted, interpret as stdio.
    transport: MCPTransportSchema.optional(),

    command: z.string().optional(),
    url: z.string().optional(),
    headers: MCPHeadersSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const transport = input.transport ?? "stdio";

    if (transport === "stdio") {
      if (!input.command?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "command is required for stdio" });
      }
      return;
    }

    if (!input.url?.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "url is required for http/sse/auto" });
    }
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

export const MCPSetToolAllowlistParamsSchema = z.object({
  projectPath: z.string(),
  name: z.string(),
  /** Tool names to allow. Empty array = no tools allowed. */
  toolAllowlist: z.array(z.string()),
});

/**
 * Unified test params - provide either:
 * - name (to test a configured server), OR
 * - command (to test arbitrary stdio command), OR
 * - url+transport (to test arbitrary http/sse/auto endpoint)
 */
export const MCPTestParamsSchema = z
  .object({
    projectPath: z.string(),
    name: z.string().optional(),

    transport: MCPTransportSchema.optional(),
    command: z.string().optional(),
    url: z.string().optional(),
    headers: MCPHeadersSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.name?.trim()) {
      return;
    }

    if (input.command?.trim()) {
      return;
    }

    if (input.url?.trim()) {
      const transport = input.transport;
      if (transport !== "http" && transport !== "sse" && transport !== "auto") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "transport must be http|sse|auto when testing by url",
        });
      }
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either name, command, or url is required",
    });
  });

export const MCPTestResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), tools: z.array(z.string()) }),
  z.object({ success: z.literal(false), error: z.string() }),
]);
