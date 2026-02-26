#!/usr/bin/env bun

/**
 * Lightweight loopback CORS proxy for mobile-web development.
 *
 * User rationale: mobile web runs at one origin (for example localhost:8081)
 * while mux dev-server runs at another (for example 127.0.0.1:3900). The
 * backend intentionally enforces strict same-origin checks for API routes, so
 * this proxy keeps backend validation strict while providing a same-origin-ish
 * bridge for local UI work.
 */

import * as http from "node:http";

function readOptionalEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw == null) {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredHostEnv(name: string, fallback: string): string {
  const value = readOptionalEnv(name) ?? fallback;
  if (value.length === 0) {
    throw new Error(`Expected ${name} to be a non-empty host`);
  }
  return value;
}

function readPortEnv(name: string, fallback: number): number {
  const rawValue = readOptionalEnv(name);
  if (rawValue == null) {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`Expected ${name} to be a positive integer port`);
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Expected ${name} to be an integer port in range 1..65535`);
  }

  return parsed;
}

function normalizeOrigin(origin: string): string | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    return parsed.origin;
  } catch {
    return null;
  }
}

function parseAllowedOrigins(rawAllowedOrigins: string | undefined): Set<string> {
  const fallback = "http://localhost:8081,http://127.0.0.1:8081";
  const source = rawAllowedOrigins ?? fallback;

  const origins = source
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => {
      const normalized = normalizeOrigin(value);
      if (!normalized) {
        throw new Error(
          `Expected MOBILE_CORS_ALLOWED_ORIGINS entry to be a valid http(s) origin: ${value}`
        );
      }
      return normalized;
    });

  if (origins.length === 0) {
    throw new Error("Expected at least one allowed origin for mobile CORS proxy");
  }

  return new Set(origins);
}

function buildCorsHeaders(origin: string): http.OutgoingHttpHeaders {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-credentials": "true",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

async function main(): Promise<void> {
  const backendHost = readRequiredHostEnv("MOBILE_BACKEND_HOST", "127.0.0.1");
  const proxyHost = readRequiredHostEnv("MOBILE_CORS_PROXY_HOST", "127.0.0.1");

  const backendPort = readPortEnv("MOBILE_BACKEND_PORT", 3900);
  const proxyPort = readPortEnv("MOBILE_CORS_PROXY_PORT", 3901);

  if (backendPort === proxyPort && backendHost === proxyHost) {
    throw new Error("MOBILE_CORS_PROXY_PORT must differ from MOBILE_BACKEND_PORT on the same host");
  }

  const targetOrigin = `http://${backendHost}:${backendPort}`;
  const allowedOrigins = parseAllowedOrigins(readOptionalEnv("MOBILE_CORS_ALLOWED_ORIGINS"));

  const server = http.createServer((clientReq, clientRes) => {
    const rawOriginHeader =
      typeof clientReq.headers.origin === "string" ? clientReq.headers.origin : null;
    const normalizedOriginHeader = rawOriginHeader ? normalizeOrigin(rawOriginHeader) : null;

    if (rawOriginHeader && !normalizedOriginHeader) {
      clientRes.writeHead(400, { vary: "Origin" });
      clientRes.end("Invalid Origin header");
      return;
    }

    const originAllowed = normalizedOriginHeader
      ? allowedOrigins.has(normalizedOriginHeader)
      : true;

    if (!originAllowed) {
      clientRes.writeHead(403, { vary: "Origin" });
      clientRes.end("Origin not allowed");
      return;
    }

    const corsHeaders = normalizedOriginHeader
      ? buildCorsHeaders(normalizedOriginHeader)
      : ({ vary: "Origin" } satisfies http.OutgoingHttpHeaders);

    if (clientReq.method === "OPTIONS") {
      if (!normalizedOriginHeader) {
        clientRes.writeHead(403, { vary: "Origin" });
        clientRes.end("Origin required for preflight");
        return;
      }

      clientRes.writeHead(204, corsHeaders);
      clientRes.end();
      return;
    }

    if (!clientReq.url) {
      clientRes.writeHead(400, corsHeaders);
      clientRes.end("Missing request URL");
      return;
    }

    const upstreamUrl = new URL(clientReq.url, targetOrigin);

    const upstreamHeaders: http.OutgoingHttpHeaders = { ...clientReq.headers };
    // User rationale: validate caller Origin before dropping it so we preserve
    // same-origin protections against unrelated browser tabs/sites.
    delete upstreamHeaders.origin;
    delete upstreamHeaders["x-forwarded-host"];
    delete upstreamHeaders["x-forwarded-proto"];
    upstreamHeaders.host = `${backendHost}:${backendPort}`;

    const upstreamReq = http.request(
      upstreamUrl,
      {
        method: clientReq.method,
        headers: upstreamHeaders,
      },
      (upstreamRes) => {
        const responseHeaders: http.OutgoingHttpHeaders = {
          ...upstreamRes.headers,
          ...corsHeaders,
        };

        clientRes.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
        upstreamRes.pipe(clientRes);
      }
    );

    upstreamReq.on("error", (error) => {
      console.error("[mobile-cors-proxy] upstream request failed", {
        message: error.message,
        method: clientReq.method,
        path: clientReq.url,
      });

      if (clientRes.headersSent) {
        clientRes.end();
        return;
      }

      clientRes.writeHead(502, corsHeaders);
      clientRes.end("Bad Gateway");
    });

    clientReq.pipe(upstreamReq);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, proxyHost, () => {
      resolve();
    });
  });

  console.log("\nStarting mobile CORS proxy...");
  console.log(`  Target backend: ${targetOrigin}`);
  console.log(`  Proxy URL:      http://${proxyHost}:${proxyPort}`);
  console.log(`  Allowed origins: ${Array.from(allowedOrigins).join(", ")}`);

  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`\nReceived ${signal}; shutting down mobile CORS proxy...`);
    server.close((error) => {
      if (error) {
        console.error("Failed to stop mobile CORS proxy cleanly", error);
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("Failed to start mobile CORS proxy", error);
  process.exit(1);
});
