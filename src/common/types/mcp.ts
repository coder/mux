/** Supported MCP server transports. */
export type MCPServerTransport = "stdio" | "http" | "sse" | "auto";

export type MCPHeaderValue = string | { secret: string };

export interface MCPServerBaseInfo {
  transport: MCPServerTransport;
  disabled: boolean;
  /**
   * Optional tool allowlist at project level.
   * If set, only these tools are exposed from this server.
   * If not set, all tools are exposed.
   */
  toolAllowlist?: string[];
}

/** stdio server definition (local process). */
export interface MCPStdioServerInfo extends MCPServerBaseInfo {
  transport: "stdio";
  command: string;
}

/** HTTP-based server definition. */
export interface MCPHttpServerInfo extends MCPServerBaseInfo {
  transport: "http" | "sse" | "auto";
  url: string;
  /** Optional headers (string literal or reference to a project secret key). */
  headers?: Record<string, MCPHeaderValue>;
}

/** Normalized server info (always has disabled field). */
export type MCPServerInfo = MCPStdioServerInfo | MCPHttpServerInfo;

export interface MCPConfig {
  servers: Record<string, MCPServerInfo>;
}

/**
 * Internal map of server name → server info (used after filtering disabled).
 * Values are not shown to the model; only server names are exposed.
 */
export type MCPServerMap = Record<string, MCPServerInfo>;

/** Result of testing an MCP server connection */
export type MCPTestResult = { success: true; tools: string[] } | { success: false; error: string };

/** Cached test result with timestamp for age display */
export interface CachedMCPTestResult {
  result: MCPTestResult;
  testedAt: number; // Unix timestamp ms
}

/**
 * Per-workspace MCP overrides.
 *
 * Stored per-workspace in <workspace>/.mux/mcp.local.jsonc (workspace-local and intended to be gitignored).
 *
 * Legacy note: older mux versions stored these overrides in ~/.mux/config.json under each workspace entry.
 * Newer versions migrate those values into the workspace-local file on first read/write.
 */
export interface WorkspaceMCPOverrides {
  /**
   * Server names to explicitly disable for this workspace.
   * Overrides project-level enabled state.
   */
  disabledServers?: string[];

  /**
   * Server names to explicitly enable for this workspace.
   * Overrides project-level disabled state.
   */
  enabledServers?: string[];

  /**
   * Per-server tool allowlist.
   * Key: server name (from .mux/mcp.jsonc)
   * Value: raw MCP tool names (NOT namespaced)
   *
   * If omitted for a server => expose all tools from that server.
   * If present but empty => expose no tools from that server.
   */
  toolAllowlist?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Global MCP config + runtime status (issue #2060)
// ---------------------------------------------------------------------------

export type MCPServerOrigin = "global" | "project" | "inline";

export interface MCPServerWithOrigin {
  info: MCPServerInfo;
  origin: MCPServerOrigin;
}

export interface MCPConfigParseError {
  message: string;
  offset: number;
  length: number;
}

export interface MCPConfigValidationError {
  message: string;
  serverName?: string;
}

export interface MCPConfigDiagnostics {
  filePath: string;
  parseErrors: MCPConfigParseError[];
  validationErrors: MCPConfigValidationError[];
}

export type MCPServerRuntimeState = "not_started" | "starting" | "running" | "failed" | "stopped";

export interface MCPServerRuntimeStatus {
  state: MCPServerRuntimeState;
  toolCount?: number;
  resolvedTransport?: "stdio" | "http" | "sse";
  autoFallbackUsed?: boolean;
  lastStartedAt?: number;
  lastStoppedAt?: number;
  lastError?: string;
  lastErrorAt?: number;
}
