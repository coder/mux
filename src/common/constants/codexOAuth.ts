/**
 * Codex OAuth constants and helpers.
 *
 * Codex (ChatGPT subscription) authentication uses ChatGPT OAuth tokens rather
 * than a standard OpenAI API key.
 *
 * This module is intentionally shared (common/) so both the backend and future
 * UI can reference the same endpoints and model gating rules.
 */

// NOTE: These endpoints follow the standard Auth0-style paths used by ChatGPT.
// If OpenAI changes them, keep all updates centralized here.

export const CODEX_OAUTH_ORIGIN = "https://auth.openai.com";

// Public OAuth client id for ChatGPT/Codex flows.
//
// The exact value is not a secret, but it is intentionally centralized so we
// can update it without hunting through backend/UI code.
export const CODEX_OAUTH_CLIENT_ID = "chatgpt";

export const CODEX_OAUTH_AUTHORIZE_URL = `${CODEX_OAUTH_ORIGIN}/authorize`;
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ORIGIN}/oauth/token`;
export const CODEX_OAUTH_DEVICE_CODE_URL = `${CODEX_OAUTH_ORIGIN}/oauth/device/code`;

// ChatGPT subscription endpoint for Codex-flavored requests.
//
// IMPORTANT: This is *not* the public OpenAI platform endpoint (api.openai.com).
// Codex OAuth tokens are only valid against this ChatGPT backend.
export const CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

// We request offline_access to receive refresh tokens.
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";

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

export function buildCodexDeviceCodeBody(): URLSearchParams {
  const body = new URLSearchParams();
  body.set("client_id", CODEX_OAUTH_CLIENT_ID);
  body.set("scope", CODEX_OAUTH_SCOPE);
  return body;
}

export function buildCodexDeviceTokenBody(input: { deviceCode: string }): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
  body.set("client_id", CODEX_OAUTH_CLIENT_ID);
  body.set("device_code", input.deviceCode);
  return body;
}

/**
 * Models that may be routed through the Codex OAuth path.
 *
 * Later work will use these sets to choose whether a given OpenAI model should
 * use an API key or Codex OAuth tokens.
 */
export const CODEX_OAUTH_ALLOWED_MODELS = new Set<string>([
  "openai:gpt-5.2-codex",
  "openai:gpt-5.1-codex",
  "openai:gpt-5.1-codex-mini",
  "openai:gpt-5.1-codex-max",
]);

/**
 * Models that *require* Codex OAuth (i.e. cannot fall back to OpenAI API keys).
 *
 * For now, this matches CODEX_OAUTH_ALLOWED_MODELS.
 */
export const CODEX_OAUTH_REQUIRED_MODELS = new Set<string>(CODEX_OAUTH_ALLOWED_MODELS);

function normalizeCodexOauthModelId(modelId: string): string {
  // Most UI code uses the canonical provider:model format.
  //
  // Some settings store the provider model id without prefix, so accept both to
  // keep callers simple.
  if (modelId.includes(":")) {
    return modelId;
  }

  return `openai:${modelId}`;
}

export function isCodexOauthAllowedModelId(modelId: string): boolean {
  return CODEX_OAUTH_ALLOWED_MODELS.has(normalizeCodexOauthModelId(modelId));
}

export function isCodexOauthRequiredModelId(modelId: string): boolean {
  return CODEX_OAUTH_REQUIRED_MODELS.has(normalizeCodexOauthModelId(modelId));
}
