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
 * Matches the shape used by @ai-sdk/mcp (OAuthTokensSchema), including the
 * authorization-server binding fields the SDK appends via
 * addAuthorizationServerInformationToTokens() before saveTokens().
 */
export interface MCPOAuthTokens {
  access_token: string;
  id_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
  refresh_token?: string;
  /**
   * Authorization server URL these tokens were issued by.
   *
   * @ai-sdk/mcp auth() requires this (or the same field on clientInformation)
   * to be present before it will use refresh_token; when missing it
   * invalidates the stored tokens and demands interactive re-auth. Dropping
   * it from the persisted store breaks token refresh across app restarts.
   */
  authorization_server?: string;
  /** Token endpoint bound to authorization_server; required alongside it. */
  token_endpoint?: string;
}

/**
 * OAuth dynamic client registration information.
 *
 * Matches the shape used by @ai-sdk/mcp (OAuthClientInformationSchema),
 * including the same authorization-server binding fields as MCPOAuthTokens.
 */
export interface MCPOAuthClientInformation {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  /** See MCPOAuthTokens.authorization_server. */
  authorization_server?: string;
  /** See MCPOAuthTokens.token_endpoint. */
  token_endpoint?: string;
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
