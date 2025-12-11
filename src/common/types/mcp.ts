/** Normalized server info (always has disabled field) */
export interface MCPServerInfo {
  command: string;
  disabled: boolean;
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
