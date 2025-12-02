/**
 * Anthropic OAuth Authentication
 *
 * Implements OAuth 2.0 + PKCE flow for authenticating with Claude Pro/Max accounts.
 * This allows users to use their subscription for API calls instead of per-token billing.
 *
 * Flow:
 * 1. Generate PKCE challenge/verifier
 * 2. Open browser to auth URL
 * 3. User logs in and authorizes
 * 4. User copies authorization code
 * 5. Exchange code for access_token + refresh_token
 * 6. Use Bearer token instead of x-api-key
 * 7. Refresh token when expired
 *
 * Based on the OAuth flow used by Claude Code CLI and OpenCode.
 */

import * as crypto from "crypto";

// Claude Code's registered OAuth client ID
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const OAUTH_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

// Required beta headers for OAuth-authenticated requests
const OAUTH_BETA_HEADERS = ["oauth-2025-04-20", "interleaved-thinking-2025-05-14"];

/**
 * OAuth token response from Anthropic
 */
export interface AnthropicOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Stored OAuth credentials
 */
export interface AnthropicOAuthCredentials {
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

/**
 * Result of starting the OAuth authorization flow
 */
export interface OAuthAuthorizationStart {
  /** URL to open in browser for user authorization */
  authUrl: string;
  /** PKCE verifier to use when exchanging the code (keep secret!) */
  verifier: string;
  /** Random state value for CSRF protection (echoed in callback) */
  state: string;
}

/**
 * Generate a cryptographically secure random string for PKCE
 */
function generateRandomString(length: number): string {
  const bytes = crypto.randomBytes(length);
  // Use URL-safe base64 encoding
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
    .slice(0, length);
}

/**
 * Generate SHA-256 hash and encode as base64url for PKCE challenge
 */
function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash("sha256").update(verifier).digest();
  return hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Generate PKCE challenge and verifier
 */
function generatePKCE(): { verifier: string; challenge: string } {
  // Use 43-128 characters for verifier (we use 64 for good entropy)
  const verifier = generateRandomString(64);
  const challenge = generateCodeChallenge(verifier);
  return { verifier, challenge };
}

/**
 * OAuth authorization mode
 * - "max": Use claude.ai (for Pro/Max subscribers)
 * - "console": Use console.anthropic.com (for API users)
 */
export type OAuthMode = "max" | "console";

/**
 * Start the OAuth authorization flow
 *
 * @param mode - Whether to use claude.ai (max) or console.anthropic.com (console)
 * @returns Authorization URL, PKCE verifier (secret), and state (for CSRF protection)
 */
export function startOAuthFlow(mode: OAuthMode = "max"): OAuthAuthorizationStart {
  const pkce = generatePKCE();
  // Generate separate state for CSRF protection - this value is echoed in the redirect
  // Keep the PKCE verifier secret and only send it during token exchange
  const state = generateRandomString(32);

  const baseUrl =
    mode === "console"
      ? "https://console.anthropic.com/oauth/authorize"
      : "https://claude.ai/oauth/authorize";

  const url = new URL(baseUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return {
    authUrl: url.toString(),
    verifier: pkce.verifier,
    state,
  };
}

/**
 * Exchange authorization code for tokens
 *
 * @param code - The authorization code from the callback (format: code#state)
 * @param verifier - The PKCE verifier from startOAuthFlow (kept secret)
 * @param expectedState - The state value from startOAuthFlow (for CSRF verification)
 * @returns Token response or null on failure
 */
export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  expectedState: string
): Promise<AnthropicOAuthTokens | null> {
  // Code format is "code#state" where state is echoed from the authorize request
  const [authCode, returnedState] = code.split("#");

  // Verify state matches to prevent CSRF attacks
  if (returnedState !== expectedState) {
    console.error("OAuth state mismatch - possible CSRF attack");
    return null;
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: authCode,
      state: returnedState,
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!response.ok) {
    console.error("OAuth token exchange failed:", response.status, await response.text());
    return null;
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Refresh an expired access token
 *
 * @param refreshToken - The refresh token from previous authentication
 * @returns New tokens or null on failure
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<AnthropicOAuthTokens | null> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    console.error("OAuth token refresh failed:", response.status, await response.text());
    return null;
  }

  const json = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
}

/**
 * Check if tokens are expired or about to expire (within 5 minutes)
 */
export function isTokenExpired(expiresAt: number): boolean {
  const bufferMs = 5 * 60 * 1000; // 5 minutes buffer
  return Date.now() >= expiresAt - bufferMs;
}

/**
 * Create a fetch wrapper that uses OAuth Bearer token authentication.
 * Automatically refreshes tokens when expired.
 *
 * @param credentials - Current OAuth credentials
 * @param onTokenRefresh - Callback to persist refreshed tokens
 * @param baseFetch - Base fetch function to wrap
 * @returns Wrapped fetch function (compatible with provider fetch signature)
 */
export function createOAuthFetch(
  credentials: AnthropicOAuthCredentials,
  onTokenRefresh: (newCredentials: AnthropicOAuthCredentials) => Promise<void>,
  baseFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  let currentCredentials = credentials;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Refresh token if expired
    if (isTokenExpired(currentCredentials.expiresAt)) {
      const newTokens = await refreshAccessToken(currentCredentials.refreshToken);
      if (!newTokens) {
        throw new Error("Failed to refresh OAuth token. Please re-authenticate.");
      }

      currentCredentials = {
        type: "oauth",
        accessToken: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresAt: newTokens.expiresAt,
      };

      await onTokenRefresh(currentCredentials);
    }

    // Build headers with OAuth authentication
    const existingHeaders = init?.headers ?? {};
    const headersInit =
      existingHeaders instanceof Headers
        ? Object.fromEntries(existingHeaders.entries())
        : Array.isArray(existingHeaders)
          ? Object.fromEntries(existingHeaders)
          : existingHeaders;

    // Merge beta headers
    const existingBeta =
      (headersInit as Record<string, string | undefined>)["anthropic-beta"] ?? "";
    const existingBetaList = existingBeta
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);

    const mergedBetas = [...new Set([...OAUTH_BETA_HEADERS, ...existingBetaList])].join(",");

    const headers: Record<string, string> = {
      ...headersInit,
      Authorization: `Bearer ${currentCredentials.accessToken}`,
      "anthropic-beta": mergedBetas,
    };

    // Remove x-api-key if present (OAuth uses Bearer token instead)
    delete headers["x-api-key"];

    return baseFetch(input, {
      ...init,
      headers,
    });
  };
}

/**
 * Get OAuth beta headers as a string (for use with existing header merging)
 */
export function getOAuthBetaHeaders(): string {
  return OAUTH_BETA_HEADERS.join(",");
}
