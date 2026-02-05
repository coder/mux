/**
 * Codex OAuth token parsing + JWT claim extraction.
 *
 * We intentionally do not validate token signatures here; we only need to
 * extract non-sensitive claims (e.g. ChatGPT-Account-Id) from OAuth responses.
 */

export interface CodexOauthAuth {
  type: "oauth";
  /** OAuth access token (JWT). */
  access: string;
  /** OAuth refresh token. */
  refresh: string;
  /** Unix epoch milliseconds when the access token expires. */
  expires: number;
  /** Value to send as the ChatGPT-Account-Id header. */
  accountId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

export function parseCodexOauthAuth(value: unknown): CodexOauthAuth | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const type = value.type;
  const access = value.access;
  const refresh = value.refresh;
  const expires = value.expires;
  const accountId = value.accountId;

  if (type !== "oauth") return null;
  if (typeof access !== "string" || !access) return null;
  if (typeof refresh !== "string" || !refresh) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;

  if (typeof accountId !== "undefined") {
    if (typeof accountId !== "string" || !accountId) return null;
  }

  return { type: "oauth", access, refresh, expires, accountId };
}

export function isCodexOauthAuthExpired(
  auth: CodexOauthAuth,
  opts?: { nowMs?: number; skewMs?: number }
): boolean {
  const now = opts?.nowMs ?? Date.now();
  const skew = opts?.skewMs ?? 30_000;
  return now + skew >= auth.expires;
}

/**
 * Best-effort JWT claim decoding (no signature verification).
 */
export function parseJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractAccountIdFromClaims(claims: Record<string, unknown>): string | null {
  // OpenCode guide extraction order:
  // 1) claims.chatgpt_account_id
  // 2) claims["https://api.openai.com/auth"].chatgpt_account_id
  // 3) claims.organizations?.[0]?.id

  const direct = claims.chatgpt_account_id;
  if (typeof direct === "string" && direct) {
    return direct;
  }

  const openAiAuth = claims["https://api.openai.com/auth"];
  if (isPlainObject(openAiAuth)) {
    const candidate = openAiAuth.chatgpt_account_id;
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  const organizations = claims.organizations;
  if (isUnknownArray(organizations) && organizations.length > 0) {
    const first = organizations[0];
    if (isPlainObject(first)) {
      const candidate = first.id;
      if (typeof candidate === "string" && candidate) {
        return candidate;
      }
    }
  }

  return null;
}

export function extractAccountIdFromToken(token: string): string | null {
  const claims = parseJwtClaims(token);
  if (!claims) {
    return null;
  }

  return extractAccountIdFromClaims(claims);
}

export function extractAccountIdFromTokens(input: {
  accessToken: string;
  idToken?: string;
}): string | null {
  // Prefer id_token when present; fall back to access token.
  if (typeof input.idToken === "string" && input.idToken) {
    const fromId = extractAccountIdFromToken(input.idToken);
    if (fromId) {
      return fromId;
    }
  }

  return extractAccountIdFromToken(input.accessToken);
}

// ------------------------------------------------------------------------------------
// Backwards-compatible export names.
// ------------------------------------------------------------------------------------

export const decodeJwtClaims = parseJwtClaims;
export const extractChatGptAccountIdFromClaims = extractAccountIdFromClaims;
export const extractChatGptAccountIdFromToken = extractAccountIdFromToken;
export const extractChatGptAccountIdFromTokens = extractAccountIdFromTokens;
