/**
 * Coder OAuth + AI Bridge constants and helpers.
 *
 * "Login with Coder" authenticates against a user-supplied Coder deployment via
 * standard OAuth2 authorization-code + PKCE (RFC 8414 discovery, RFC 7591
 * dynamic client registration). The resulting access token is a regular Coder
 * API key accepted by the deployment's AI Bridge endpoints.
 *
 * This module is intentionally shared (common/) so both the backend and UI can
 * reference the same endpoints and helpers.
 */

/** Unauthenticated probe used to validate that a URL points at a Coder deployment. */
export const CODER_BUILDINFO_PATH = "/api/v2/buildinfo";

/** RFC 8414 authorization server metadata (served by coderd with --experiments=oauth2). */
export const CODER_OAUTH_DISCOVERY_PATH = "/.well-known/oauth-authorization-server";

/** Loopback callback path for the desktop authorization-code flow. */
export const CODER_OAUTH_CALLBACK_PATH = "/callback";

/** Client name registered via RFC 7591 dynamic client registration. */
export const CODER_OAUTH_CLIENT_NAME = "Mux";

/** AI Bridge mount point on the deployment. */
export const CODER_AIBRIDGE_PATH = "/api/v2/aibridge";

/** Upstream origins the AI Bridge can route to (per-origin endpoints). */
export const CODER_AIBRIDGE_ORIGINS = ["anthropic", "openai"] as const;
export type CoderAibridgeOrigin = (typeof CODER_AIBRIDGE_ORIGINS)[number];

export function isCoderAibridgeOrigin(value: string): value is CoderAibridgeOrigin {
  return (CODER_AIBRIDGE_ORIGINS as readonly string[]).includes(value);
}

/**
 * Normalize a user-supplied deployment URL: require http(s), strip trailing
 * slashes and any path/query/fragment noise. Returns null when invalid.
 */
export function normalizeCoderDeploymentUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }

  // Coder access URLs are origin-scoped; drop any accidental path suffix.
  return url.origin;
}

/**
 * Per-origin AI Bridge base URL, e.g.
 *   https://coder.example.com/api/v2/aibridge/anthropic/v1
 *   https://coder.example.com/api/v2/aibridge/openai/v1
 *
 * Both the Anthropic and OpenAI AI SDK providers append their route suffixes
 * (/messages, /chat/completions, /responses) to a .../v1 base URL.
 */
export function coderAibridgeBaseUrl(deploymentUrl: string, origin: CoderAibridgeOrigin): string {
  return `${deploymentUrl}${CODER_AIBRIDGE_PATH}/${origin}/v1`;
}

export function buildCoderAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // No scope requested: Coder currently ignores scopes and issues full-privilege
  // tokens; sending none keeps the flow forward-compatible with scoped tokens.
  return url.toString();
}

export function buildCoderTokenExchangeBody(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", input.clientId);
  // Coder's token endpoint requires client_secret even for native apps
  // (DetermineClientType() treats every client as confidential).
  body.set("client_secret", input.clientSecret);
  body.set("code", input.code);
  body.set("redirect_uri", input.redirectUri);
  body.set("code_verifier", input.codeVerifier);
  return body;
}

export function buildCoderRefreshBody(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("refresh_token", input.refreshToken);
  return body;
}

/**
 * RFC 7591/7592 client metadata. Coder validates redirect URIs with exact
 * matching (OAuth 2.1), so the current loopback redirect URI (with its
 * ephemeral port) must be (re-)registered before each login.
 */
export function buildCoderClientMetadata(redirectUri: string): Record<string, unknown> {
  return {
    client_name: CODER_OAUTH_CLIENT_NAME,
    client_uri: "https://mux.coder.com",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };
}
