import { randomBytes } from "crypto";

/**
 * Check if a host string resolves to a loopback address.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith("127.")) return true;
  return normalized === "localhost" || normalized === "::1";
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
  const provided = explicitToken?.trim() || envToken?.trim();
  if (provided) return { token: provided, generated: false };
  if (isLoopbackHost(host)) return { token: undefined, generated: false };
  const token = randomBytes(32).toString("hex");
  return { token, generated: true };
}
