/**
 * Anthropic OAuth constants and helpers.
 *
 * Anthropic (Claude Max/Pro subscription) authentication uses OAuth tokens
 * rather than a standard Anthropic API key.
 *
 * This module is intentionally shared (common/) so both the backend and
 * UI can reference the same endpoints.
 */

// Public OAuth client id for Claude Max/Pro flows.
export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";

// Redirect URI -- Anthropic's code-paste flow uses this fixed value.
// The server displays the auth code on this page for the user to copy.
export const ANTHROPIC_OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";

// Scopes needed for inference via subscription.
export const ANTHROPIC_OAUTH_SCOPE = "org:create_api_key user:profile user:inference";

// Beta header value required for OAuth-authed API requests.
export const ANTHROPIC_OAUTH_BETA_HEADER = "oauth-2025-04-20";

// Additional beta for interleaved thinking support.
export const ANTHROPIC_OAUTH_THINKING_BETA = "interleaved-thinking-2025-05-14";

// User-agent string to send with OAuth-authed requests.
export const ANTHROPIC_OAUTH_USER_AGENT = "claude-cli/2.1.2 (external, cli)";

// Tool name prefix required by Anthropic's OAuth API.
export const ANTHROPIC_OAUTH_TOOL_PREFIX = "mcp_";

// System prompt prefix required by Anthropic's OAuth API.
// The server validates that Claude Code OAuth requests include this identity
// prefix in the system prompt; without it the credential is rejected.
export const ANTHROPIC_OAUTH_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export function buildAnthropicAuthorizeUrl(input: {
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  // code=true tells the server to display a code for the user to copy/paste
  // instead of performing a redirect to localhost.
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function buildAnthropicTokenExchangeBody(input: {
  code: string;
  state: string;
  codeVerifier: string;
}): string {
  return JSON.stringify({
    code: input.code,
    state: input.state,
    grant_type: "authorization_code",
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
    code_verifier: input.codeVerifier,
  });
}

export function buildAnthropicRefreshBody(input: { refreshToken: string }): string {
  return JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
  });
}
