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
   * Key: server name
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

export const MCPListParamsSchema = z.object({
  projectPath: z.string().optional(),
});

const MCPAddParamsBaseSchema = z.object({
  name: z.string(),

  // Backward-compatible: if transport omitted, interpret as stdio.
  transport: MCPTransportSchema.optional(),

  command: z.string().optional(),
  url: z.string().optional(),
  headers: MCPHeadersSchema.optional(),
});

type MCPAddParamsLike = z.infer<typeof MCPAddParamsBaseSchema>;

function refineMcpAddParams(input: MCPAddParamsLike, ctx: z.RefinementCtx): void {
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
}

/** Global MCP config mutation (no projectPath). */
export const MCPAddGlobalParamsSchema = MCPAddParamsBaseSchema.superRefine(refineMcpAddParams);

/** @deprecated Legacy project-scoped API shape (writes now apply to global config). */
export const MCPAddParamsSchema = MCPAddParamsBaseSchema.extend({
  projectPath: z.string(),
}).superRefine(refineMcpAddParams);

const MCPRemoveParamsBaseSchema = z.object({
  name: z.string(),
});

export const MCPRemoveGlobalParamsSchema = MCPRemoveParamsBaseSchema;

/** @deprecated Legacy project-scoped API shape (writes now apply to global config). */
export const MCPRemoveParamsSchema = MCPRemoveParamsBaseSchema.extend({
  projectPath: z.string(),
});

const MCPSetEnabledParamsBaseSchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
});

export const MCPSetEnabledGlobalParamsSchema = MCPSetEnabledParamsBaseSchema;

/** @deprecated Legacy project-scoped API shape (writes now apply to global config). */
export const MCPSetEnabledParamsSchema = MCPSetEnabledParamsBaseSchema.extend({
  projectPath: z.string(),
});

const MCPSetToolAllowlistParamsBaseSchema = z.object({
  name: z.string(),
  /** Tool names to allow. Empty array = no tools allowed. */
  toolAllowlist: z.array(z.string()),
});

export const MCPSetToolAllowlistGlobalParamsSchema = MCPSetToolAllowlistParamsBaseSchema;

/** @deprecated Legacy project-scoped API shape (writes now apply to global config). */
export const MCPSetToolAllowlistParamsSchema = MCPSetToolAllowlistParamsBaseSchema.extend({
  projectPath: z.string(),
});

/**
 * Unified test params - provide either:
 * - name (to test a configured server), OR
 * - command (to test arbitrary stdio command), OR
 * - url+transport (to test arbitrary http/sse/auto endpoint)
 *
 * For pending-server tests (e.g. add-server form), callers may also provide
 * name+url+transport so the backend can attach stored OAuth credentials.
 */
const MCPTestParamsBaseSchema = z.object({
  name: z.string().optional(),

  transport: MCPTransportSchema.optional(),
  command: z.string().optional(),
  url: z.string().optional(),
  headers: MCPHeadersSchema.optional(),
});

type MCPTestParamsLike = z.infer<typeof MCPTestParamsBaseSchema>;

function refineMcpTestParams(input: MCPTestParamsLike, ctx: z.RefinementCtx): void {
  const hasName = Boolean(input.name?.trim());
  const hasCommand = Boolean(input.command?.trim());
  const hasUrl = Boolean(input.url?.trim());

  if (!hasName && !hasCommand && !hasUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Either name, command, or url is required",
    });
    return;
  }

  if (hasUrl) {
    const transport = input.transport;
    if (transport !== "http" && transport !== "sse" && transport !== "auto") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "transport must be http|sse|auto when testing by url",
      });
    }
  }
}

/** Test endpoint input with optional projectPath (global-only secrets when omitted). */
export const MCPTestGlobalParamsSchema = MCPTestParamsBaseSchema.extend({
  projectPath: z.string().optional(),
}).superRefine(refineMcpTestParams);

/** @deprecated Legacy project-scoped API shape. */
export const MCPTestParamsSchema = MCPTestParamsBaseSchema.extend({
  projectPath: z.string(),
}).superRefine(refineMcpTestParams);

export const BearerChallengeSchema = z.object({
  scope: z.string().optional(),
  resourceMetadataUrl: z.url().optional(),
});

export const MCPTestResultSchema = z.discriminatedUnion("success", [
  z.object({ success: z.literal(true), tools: z.array(z.string()) }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    oauthChallenge: BearerChallengeSchema.optional(),
  }),
]);
