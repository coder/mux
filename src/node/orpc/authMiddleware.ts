import { timingSafeEqual } from "crypto";
import { os } from "@orpc/server";
import type { IncomingHttpHeaders, IncomingMessage } from "http";
import { URL } from "url";

// Time-constant string comparison using Node's crypto module
export function safeEq(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Perform a dummy comparison to maintain constant time
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function extractBearerToken(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h?.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim() || null;
}

/** Create auth middleware that validates Authorization header from context */
export function createAuthMiddleware(authToken?: string) {
  if (!authToken?.trim()) {
    return os.middleware(({ next }) => next());
  }

  const expectedToken = authToken.trim();

  return os
    .$context<{ headers?: IncomingHttpHeaders }>()
    .errors({
      UNAUTHORIZED: {
        message: "Invalid or missing auth token",
      },
    })
    .middleware(({ context, errors, next }) => {
      const presentedToken = extractBearerToken(context.headers?.authorization);

      if (!presentedToken || !safeEq(presentedToken, expectedToken)) {
        throw errors.UNAUTHORIZED();
      }

      return next();
    });
}

/** Extract auth token from WS upgrade request and build headers object with synthetic Authorization */
export function extractWsHeaders(req: IncomingMessage): IncomingHttpHeaders {
  // Start with actual headers
  const headers = { ...req.headers };

  // If no Authorization header, try fallback methods
  if (!headers.authorization) {
    // 1) Query param: ?token=...
    try {
      const url = new URL(req.url ?? "", "http://localhost");
      const qp = url.searchParams.get("token");
      if (qp?.trim()) {
        headers.authorization = `Bearer ${qp.trim()}`;
        return headers;
      }
    } catch {
      /* ignore */
    }

    // 2) Sec-WebSocket-Protocol (first value as token)
    const proto = req.headers["sec-websocket-protocol"];
    if (typeof proto === "string") {
      const first = proto
        .split(",")
        .map((s) => s.trim())
        .find((s) => s);
      if (first) {
        headers.authorization = `Bearer ${first}`;
      }
    }
  }

  return headers;
}
