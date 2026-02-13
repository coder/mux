import { randomBytes } from "crypto";

/**
 * Check if a host string is a literal loopback address.
 *
 * Only matches literal IPv4/IPv6 loopback addresses and "localhost".
 * Hostnames that happen to start with "127." (e.g., "127.example.com") are
 * NOT treated as loopback — this matters for auth-token generation policy.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();

  // Strip IPv6 brackets if present (e.g., "[::1]" → "::1").
  const bare =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;

  if (bare === "localhost" || bare === "::1") return true;

  // Match 127.x.y.z only for literal IPv4 addresses (4 numeric octets, 0-255).
  // This prevents hostnames like "127.example.com" from being misclassified.
  if (bare.startsWith("127.")) {
    const parts = bare.split(".");
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
      return true;
    }
  }

  return false;
}

export interface ResolvedAuthToken {
  /** The token to use (undefined = no auth required). */
  token: string | undefined;
  /** Whether this token was auto-generated (vs. explicitly provided). */
  generated: boolean;
}

/**
 * Resolve the effective auth token for the server.
 *
 * Policy:
 * - If an explicit token or env var is provided, use it.
 * - If the host is loopback and no token is provided, allow unauthenticated (local dev).
 * - If the host is non-loopback and no token is provided, generate a secure ephemeral token.
 */
export function resolveServerAuthToken(
  host: string,
  explicitToken?: string,
  envToken?: string
): ResolvedAuthToken {
  const explicit = explicitToken?.trim();
  const env = envToken?.trim();
  const provided = explicit && explicit.length > 0 ? explicit : env && env.length > 0 ? env : null;
  if (provided != null) return { token: provided, generated: false };
  if (isLoopbackHost(host)) return { token: undefined, generated: false };
  const token = randomBytes(32).toString("hex");
  return { token, generated: true };
}
