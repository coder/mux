/**
 * Anthropic OAuth token parsing and validation.
 */

export interface AnthropicOauthAuth {
  type: "oauth";
  /** OAuth access token. */
  access: string;
  /** OAuth refresh token. */
  refresh: string;
  /** Unix epoch milliseconds when the access token expires. */
  expires: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseAnthropicOauthAuth(value: unknown): AnthropicOauthAuth | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const { type, access, refresh, expires } = value;

  if (type !== "oauth") return null;
  if (typeof access !== "string" || !access) return null;
  if (typeof refresh !== "string" || !refresh) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;

  return { type: "oauth", access, refresh, expires };
}

export function isAnthropicOauthAuthExpired(
  auth: AnthropicOauthAuth,
  opts?: { nowMs?: number; skewMs?: number }
): boolean {
  const now = opts?.nowMs ?? Date.now();
  const skew = opts?.skewMs ?? 30_000;
  return now + skew >= auth.expires;
}
