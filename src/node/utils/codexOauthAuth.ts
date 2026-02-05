/**
 * Codex OAuth token parsing + JWT claim extraction.
 *
 * We intentionally do not validate token signatures here; we only need to
 * extract non-sensitive claims (e.g. ChatGPT-Account-Id) from OAuth responses.
 */

export interface CodexOauthAuth {
  /** OAuth access token (JWT). */
  access: string;
  /** OAuth refresh token. */
  refresh: string;
  /** Unix epoch milliseconds when the access token expires. */
  expires: number;
  /** Value to send as the ChatGPT-Account-Id header. */
  accountId: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseCodexOauthAuth(value: unknown): CodexOauthAuth | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const access = value.access;
  const refresh = value.refresh;
  const expires = value.expires;
  const accountId = value.accountId;

  if (typeof access !== "string" || !access) return null;
  if (typeof refresh !== "string" || !refresh) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;
  if (typeof accountId !== "string" || !accountId) return null;

  return { access, refresh, expires, accountId };
}

export function isCodexOauthAuthExpired(
  auth: CodexOauthAuth,
  opts?: { nowMs?: number; skewMs?: number }
): boolean {
  const now = opts?.nowMs ?? Date.now();
  const skew = opts?.skewMs ?? 30_000;
  return now + skew >= auth.expires;
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  // JWT uses base64url encoding without padding.
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = normalized.length % 4;
  const padded = padding === 0 ? normalized : normalized + "=".repeat(4 - padding);

  try {
    const json = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort JWT claim decoding (no signature verification).
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  return decodeBase64UrlJson(parts[1]);
}

export function extractChatGptAccountIdFromClaims(claims: Record<string, unknown>): string | null {
  // Known patterns used by OpenAI/Auth0-style JWTs.
  const openAiAuth = claims["https://api.openai.com/auth"];
  if (isPlainObject(openAiAuth)) {
    const candidate =
      openAiAuth.chatgpt_account_id ?? openAiAuth.account_id ?? openAiAuth.accountId;
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  const directCandidates: unknown[] = [
    claims.chatgpt_account_id,
    claims.chatgptAccountId,
    claims.account_id,
    claims.accountId,
  ];

  for (const candidate of directCandidates) {
    if (typeof candidate === "string" && candidate) {
      return candidate;
    }
  }

  return null;
}

export function extractChatGptAccountIdFromToken(token: string): string | null {
  const claims = decodeJwtClaims(token);
  if (!claims) {
    return null;
  }

  return extractChatGptAccountIdFromClaims(claims);
}

export function extractChatGptAccountIdFromTokens(input: {
  accessToken: string;
  idToken?: string;
}): string | null {
  // Prefer id_token when present; fall back to access token.
  if (typeof input.idToken === "string" && input.idToken) {
    const fromId = extractChatGptAccountIdFromToken(input.idToken);
    if (fromId) {
      return fromId;
    }
  }

  return extractChatGptAccountIdFromToken(input.accessToken);
}
