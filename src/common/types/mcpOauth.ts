/**
 * Shared types for MCP OAuth (Model Context Protocol authorization).
 *
 * Important: These are wire/storage types only.
 * - Do NOT send access tokens or client secrets to the browser.
 * - Never persist tokens into project-local .mux/mcp.jsonc.
 */

import type { MCPServerTransport } from "./mcp";

/**
 * Transport types supported by MCP OAuth.
 *
 * OAuth is only supported for remote MCP servers (http/sse/auto), not stdio.
 */
export type MCPOAuthServerTransport = Exclude<MCPServerTransport, "stdio">;

/**
 * Ephemeral MCP server config used to start OAuth flows before the server is saved
 * into project config.
 */
export interface MCPOAuthPendingServerConfig {
  transport: MCPOAuthServerTransport;
  url: string;
}

/**
 * OAuth 2.1 token response.
 *
 * Matches the shape used by @ai-sdk/mcp.
 */
export interface MCPOAuthTokens {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
}

/**
 * OAuth dynamic client registration information.
 *
 * Matches the shape used by @ai-sdk/mcp.
 */
export interface MCPOAuthClientInformation {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
}

/**
 * Credentials stored globally per MCP server URL.
 *
 * NOTE: This object contains secrets and must never be returned over IPC.
 */
export interface MCPOAuthStoredCredentials {
  /**
   * The MCP server URL these credentials were created for.
   *
   * Used for defensive invalidation when the configured server URL changes.
   */
  serverUrl: string;

  clientInformation?: MCPOAuthClientInformation;
  tokens?: MCPOAuthTokens;

  updatedAtMs: number;
}

/**
 * Redacted auth status safe for IPC/UI.
 */
export interface MCPOAuthAuthStatus {
  serverUrl?: string;
  isLoggedIn: boolean;
  hasRefreshToken: boolean;
  scope?: string;
  updatedAtMs?: number;
}
