/**
 * Codex OAuth constants and helpers.
 *
 * Codex (ChatGPT subscription) authentication uses ChatGPT OAuth tokens rather
 * than a standard OpenAI API key.
 *
 * This module is intentionally shared (common/) so both the backend and future
 * UI can reference the same endpoints and model gating rules.
 */

// NOTE: These endpoints + params follow the OpenCode Codex OAuth guide.
// If OpenAI changes them, keep all updates centralized here.

export const CODEX_OAUTH_ORIGIN = "https://auth.openai.com";

// Public OAuth client id for ChatGPT/Codex flows.
//
// The exact value is not a secret, but it is intentionally centralized so we
// can update it without hunting through backend/UI code.
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const CODEX_OAUTH_AUTHORIZE_URL = `${CODEX_OAUTH_ORIGIN}/oauth/authorize`;
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ORIGIN}/oauth/token`;

// ChatGPT subscription endpoint for Codex-flavored requests.
//
// IMPORTANT: This is *not* the public OpenAI platform endpoint (api.openai.com).
// Codex OAuth tokens are only valid against this ChatGPT backend.
export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// We request offline_access to receive refresh tokens.
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";

// Desktop browser redirect URI used by the simplified flow.
export const CODEX_OAUTH_BROWSER_REDIRECT_URI = "http://localhost:1455/auth/callback";

// Codex-specific device auth endpoints.
export const CODEX_OAUTH_DEVICE_USERCODE_URL = `${CODEX_OAUTH_ORIGIN}/api/accounts/deviceauth/usercode`;
export const CODEX_OAUTH_DEVICE_TOKEN_POLL_URL = `${CODEX_OAUTH_ORIGIN}/api/accounts/deviceauth/token`;
export const CODEX_OAUTH_DEVICE_VERIFY_URL = `${CODEX_OAUTH_ORIGIN}/codex/device`;

// ------------------------------------------------------------------------------------
// Guide-aligned alias exports (so future ports can follow the guide naming).
// ------------------------------------------------------------------------------------

export const ISSUER = CODEX_OAUTH_ORIGIN;
export const CLIENT_ID = CODEX_OAUTH_CLIENT_ID;
export const AUTHORIZE_ENDPOINT = CODEX_OAUTH_AUTHORIZE_URL;
export const TOKEN_ENDPOINT = CODEX_OAUTH_TOKEN_URL;
export const SCOPES = CODEX_OAUTH_SCOPE;
export const DEVICE_USERCODE = CODEX_OAUTH_DEVICE_USERCODE_URL;
export const DEVICE_TOKEN_POLL = CODEX_OAUTH_DEVICE_TOKEN_POLL_URL;
export const DEVICE_VERIFY_URL = CODEX_OAUTH_DEVICE_VERIFY_URL;
export const BROWSER_REDIRECT = CODEX_OAUTH_BROWSER_REDIRECT_URI;

export function buildCodexAuthorizeUrl(input: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(CODEX_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CODEX_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", CODEX_OAUTH_SCOPE);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  // Extra authorize params required by the Codex flow.
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "mux");

  return url.toString();
}

export function buildCodexTokenExchangeBody(input: {
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CODEX_OAUTH_CLIENT_ID);
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.codeVerifier);
  return body;
}

export function buildCodexRefreshBody(input: { refreshToken: string }): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", CODEX_OAUTH_CLIENT_ID);
  body.set("refresh_token", input.refreshToken);
  return body;
}

/**
 * Models that may be routed through the Codex OAuth path.
 *
 * The values in this set are providerModelIds (no `openai:` prefix).
 */
export const CODEX_OAUTH_ALLOWED_MODELS = new Set<string>([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
]);

/**
 * Models that *prefer* Codex OAuth routing.
 *
 * These models are initially gated behind OAuth but eventually become available
 * via regular API keys.  When the user has OAuth connected, we route through it;
 * otherwise we fall back to their API key and let OpenAI decide whether the
 * model is accessible.
 */
export const CODEX_OAUTH_REQUIRED_MODELS = new Set<string>([
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.1-codex",
]);

function normalizeCodexOauthModelId(modelId: string): string {
  // Accept either provider:model or bare model ids and normalize to providerModelId.
  const colonIndex = modelId.indexOf(":");
  if (colonIndex !== -1) {
    return modelId.slice(colonIndex + 1);
  }

  return modelId;
}

export function isCodexOauthAllowedModelId(modelId: string): boolean {
  return CODEX_OAUTH_ALLOWED_MODELS.has(normalizeCodexOauthModelId(modelId));
}

export function isCodexOauthRequiredModelId(modelId: string): boolean {
  return CODEX_OAUTH_REQUIRED_MODELS.has(normalizeCodexOauthModelId(modelId));
}
