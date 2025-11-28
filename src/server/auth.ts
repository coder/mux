/**
 * Simple bearer token auth helpers for cmux-server
 *
 * Optional by design: if no token is configured, middleware is a no-op.
 * Token can be supplied via CLI flag (--auth-token) or env (MUX_SERVER_AUTH_TOKEN).
 *
 * WebSocket notes:
 * - React Native / Expo cannot always set custom Authorization headers.
 * - We therefore accept the token via any of the following (first match wins):
 *   1) Query param:   /ws?token=... (recommended for Expo)
 *   2) Authorization: Bearer <token>
 *   3) Sec-WebSocket-Protocol: a single value equal to the token
 */

import type { Request, Response, NextFunction } from "express";
import type { IncomingMessage } from "http";
import { URL } from "url";

export interface AuthConfig {
  token?: string | null;
}

export function createAuthMiddleware(config: AuthConfig) {
  const token = (config.token ?? "").trim();
  const enabled = token.length > 0;

  return function authMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!enabled) return next();

    // Skip health check and static assets by convention
    if (req.path === "/health" || req.path === "/version") return next();

    const header = req.headers.authorization; // e.g. "Bearer <token>"
    const candidate =
      typeof header === "string" && header.toLowerCase().startsWith("bearer ")
        ? header.slice("bearer ".length)
        : undefined;

    if (candidate && safeEq(candidate.trim(), token)) return next();

    res.status(401).json({ success: false, error: "Unauthorized" });
  };
}

export function extractWsToken(req: IncomingMessage): string | null {
  // 1) Query param token
  try {
    const url = new URL(req.url ?? "", "http://localhost");
    const qp = url.searchParams.get("token");
    if (qp && qp.trim().length > 0) return qp.trim();
  } catch {
    // ignore
  }

  // 2) Authorization header
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    const v = header.slice("bearer ".length).trim();
    if (v.length > 0) return v;
  }

  // 3) Sec-WebSocket-Protocol: use first comma-separated value as token
  const proto = req.headers["sec-websocket-protocol"];
  if (typeof proto === "string") {
    const first = proto
      .split(",")
      .map((s) => s.trim())
      .find((s) => s.length > 0);
    if (first) return first;
  }

  return null;
}

export function isWsAuthorized(req: IncomingMessage, config: AuthConfig): boolean {
  const token = (config.token ?? "").trim();
  if (token.length === 0) return true; // disabled
  const presented = extractWsToken(req);
  return presented != null && safeEq(presented, token);
}

// Time-constant-ish equality for short tokens
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}
