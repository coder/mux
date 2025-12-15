/** Normalized server info (always has disabled field) */
export interface MCPServerInfo {
  command: string;
  disabled: boolean;
  /**
   * Optional tool allowlist at project level.
   * If set, only these tools are exposed from this server.
   * If not set, all tools are exposed.
   */
  toolAllowlist?: string[];
}

export interface MCPConfig {
  servers: Record<string, MCPServerInfo>;
}

/** Internal map of server name → command string (used after filtering disabled) */
export type MCPServerMap = Record<string, string>;

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
 * Stored in ~/.mux/config.json under each workspace entry.
 * Allows workspaces to override project-level server enabled/disabled state
 * and restrict tool allowlists.
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
