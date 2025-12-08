export interface MCPConfig {
  servers: Record<string, string>;
}

export type MCPServerMap = Record<string, string>;

/** Result of testing an MCP server connection */
export type MCPTestResult = { success: true; tools: string[] } | { success: false; error: string };
