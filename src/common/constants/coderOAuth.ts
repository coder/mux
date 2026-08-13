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

/**
 * AI Gateway data-plane mount point on the deployment. Newer coderd also
 * serves the canonical alias /api/v2/ai-gateway, but the legacy prefix is
 * kept for backward compatibility and works on every deployment Mux
 * supports, so it stays the single prefix used here.
 */
export const CODER_AIBRIDGE_PATH = "/api/v2/aibridge";

/**
 * Admin CRUD endpoint listing the deployment's configured AI Gateway provider
 * instances ({name, type, enabled, ...}). Requires site-wide AIProvider read
 * (regular members receive 403); discovery falls back to probing default
 * provider names when this endpoint is unavailable.
 */
export const CODER_AI_PROVIDERS_PATH = "/api/v2/ai/providers";

/**
 * AI Gateway provider types (mirrors codersdk.AIProviderType). A deployment
 * can configure multiple provider instances per type, each with its own
 * name; the name is the URL route segment on the gateway's data plane
 * (/api/v2/aibridge/<name>/...). When admins don't set an explicit name it
 * defaults to the type.
 */
export const CODER_GATEWAY_PROVIDER_TYPES = [
  "anthropic",
  "openai",
  "azure",
  "google",
  "openai-compat",
  "openrouter",
  "vercel",
  "bedrock",
  "copilot",
] as const;
export type CoderGatewayProviderType = (typeof CODER_GATEWAY_PROVIDER_TYPES)[number];

/** A configured AI Gateway provider instance discovered from the deployment. */
export interface CoderGatewayProvider {
  /** Instance name — the gateway route segment and the model ID prefix. */
  name: string;
  /** Provider type (see CODER_GATEWAY_PROVIDER_TYPES); decides the wire protocol. */
  type: string;
}

/**
 * Default probe set when the providers listing is unavailable: every
 * non-Copilot type under its default (name === type) instance name. Copilot
 * is excluded because its gateway routes require request-time tokens only an
 * official Copilot client can mint — Mux's Coder OAuth token is not enough.
 */
export const CODER_GATEWAY_DEFAULT_PROVIDER_NAMES: readonly string[] =
  CODER_GATEWAY_PROVIDER_TYPES.filter((type) => type !== "copilot");

/**
 * Wire protocol Mux must speak to a gateway provider, derived from its type.
 * Mirrors the gateway's own client mapping: anthropic/bedrock are served by
 * its Anthropic client (/v1/messages), everything else by its OpenAI client.
 * Only the real OpenAI upstream reliably supports the Responses API; the
 * other OpenAI-wire types target OpenAI-compatible upstreams where only
 * /chat/completions can be assumed. Unknown (future) types default to
 * openai-chat to match the gateway's own default. Returns null for
 * unsupported types (copilot, see above).
 */
export type CoderGatewayWire = "anthropic" | "openai-responses" | "openai-chat";

export function coderGatewayWireProtocol(type: string): CoderGatewayWire | null {
  switch (type) {
    case "anthropic":
    case "bedrock":
      return "anthropic";
    case "openai":
      return "openai-responses";
    case "copilot":
      return null;
    default:
      return "openai-chat";
  }
}

/** Parse a persisted (hand-editable) gateway provider list, dropping malformed entries. */
export function parseCoderGatewayProviders(value: unknown): CoderGatewayProvider[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const providers: CoderGatewayProvider[] = [];
  for (const entry of value) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { name?: unknown }).name === "string" &&
      (entry as { name: string }).name &&
      typeof (entry as { type?: unknown }).type === "string"
    ) {
      providers.push({
        name: (entry as { name: string }).name,
        type: (entry as { type: string }).type,
      });
    }
  }
  return providers;
}

/**
 * Resolve a model-ID prefix to the gateway provider it addresses:
 * user-configured entries win (escape hatch for custom-named providers on
 * deployments where the member cannot list providers), then the discovered
 * catalog, then the default name === type convention.
 */
export function resolveCoderGatewayProvider(
  name: string,
  discovered: readonly CoderGatewayProvider[] | undefined,
  additional: readonly CoderGatewayProvider[] | undefined
): CoderGatewayProvider | null {
  const fromConfig =
    additional?.find((provider) => provider.name === name) ??
    discovered?.find((provider) => provider.name === name);
  if (fromConfig) {
    return fromConfig;
  }
  if ((CODER_GATEWAY_PROVIDER_TYPES as readonly string[]).includes(name)) {
    return { name, type: name };
  }
  return null;
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
 * Per-provider AI Gateway base URL, e.g.
 *   https://coder.example.com/api/v2/aibridge/anthropic/v1
 *   https://coder.example.com/api/v2/aibridge/my-openai/v1
 *
 * Both the Anthropic and OpenAI AI SDK providers append their route suffixes
 * (/messages, /chat/completions, /responses) to a .../v1 base URL.
 */
export function coderAibridgeBaseUrl(deploymentUrl: string, providerName: string): string {
  return `${deploymentUrl}${CODER_AIBRIDGE_PATH}/${providerName}/v1`;
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
