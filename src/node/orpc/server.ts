/**
 * oRPC Server factory for mux.
 * Serves oRPC router over HTTP and WebSocket.
 *
 * This module exports the server creation logic so it can be tested.
 * The CLI entry point (server.ts) uses this to start the server.
 */
import cors from "cors";
import express, { type Express } from "express";
import * as fs from "fs/promises";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, type WebSocket } from "ws";
import { RPCHandler } from "@orpc/server/node";
import { RPCHandler as ORPCWebSocketServerHandler } from "@orpc/server/ws";
import { ORPCError, onError } from "@orpc/server";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { router, type AppRouter } from "@/node/orpc/router";
import type { ORPCContext } from "@/node/orpc/context";
import { extractWsHeaders, safeEq } from "@/node/orpc/authMiddleware";
import { VERSION } from "@/version";
import { formatOrpcError } from "@/node/orpc/formatOrpcError";
import { log } from "@/node/services/log";
import { attachStreamErrorHandler, isIgnorableStreamError } from "@/node/utils/streamErrors";

type AliveWebSocket = WebSocket & { isAlive?: boolean };

const WS_HEARTBEAT_INTERVAL_MS = 30_000;

// --- Types ---

export interface OrpcServerOptions {
  /** Host to bind to (default: "127.0.0.1") */
  host?: string;
  /** Port to bind to (default: 0 for random available port) */
  port?: number;
  /** oRPC context with services */
  context: ORPCContext;
  /** Whether to serve static files and SPA fallback (default: false) */
  serveStatic?: boolean;
  /** Directory to serve static files from (default: dist/ relative to dist/node/orpc/) */
  staticDir?: string;
  /** Custom error handler for oRPC errors */
  onOrpcError?: (error: unknown, options: unknown) => void;
  /** Optional bearer token for HTTP auth (used if router not provided) */
  authToken?: string;
  /** Optional pre-created router (if not provided, creates router(authToken)) */
  router?: AppRouter;
}

export interface OrpcServer {
  /** The HTTP server instance */
  httpServer: http.Server;
  /** The WebSocket server instance */
  wsServer: WebSocketServer;
  /** The Express app instance */
  app: Express;
  /** The port the server is listening on */
  port: number;
  /** Base URL for HTTP requests */
  baseUrl: string;
  /** WebSocket URL for WS connections */
  wsUrl: string;
  /** URL for OpenAPI spec JSON */
  specUrl: string;
  /** URL for Scalar API docs */
  docsUrl: string;
  /** Close the server and cleanup resources */
  close: () => Promise<void>;
}

// --- Server Factory ---

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();

  // IPv6 URLs must be bracketed: http://[::1]:1234
  if (trimmed.includes(":")) {
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      return trimmed;
    }

    // If the host contains a zone index (e.g. fe80::1%en0), percent must be encoded.
    const escaped = trimmed.replaceAll("%", "%25");
    return `[${escaped}]`;
  }

  return trimmed;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length ? token : null;
}
function injectBaseHref(indexHtml: string, baseHref: string): string {
  // Avoid double-injecting if the HTML already has a base tag.
  if (/<base\b/i.test(indexHtml)) {
    return indexHtml;
  }

  // Insert immediately after the opening <head> tag (supports <head> and <head ...attrs>).
  return indexHtml.replace(/<head[^>]*>/i, (match) => `${match}\n    <base href="${baseHref}" />`);
}

function escapeJsonForHtmlScript(value: unknown): string {
  // Prevent `</script>` injection when embedding untrusted strings in an inline <script>.
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}
function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Create an oRPC server with HTTP and WebSocket endpoints.
 *
 * HTTP endpoint: /orpc
 * WebSocket endpoint: /orpc/ws
 * Health check: /health
 * Version: /version
 */
export async function createOrpcServer({
  host = "127.0.0.1",
  port = 0,
  authToken,
  context,
  serveStatic = false,
  // From dist/node/orpc/, go up 2 levels to reach dist/ where index.html lives
  staticDir = path.join(__dirname, "../.."),
  onOrpcError = (error, options) => {
    // Auth failures are expected in browser mode while the user enters the token.
    // Avoid spamming error logs with stack traces on every unauthenticated request.
    if (error instanceof ORPCError && error.code === "UNAUTHORIZED") {
      log.debug("ORPC unauthorized request");
      return;
    }

    const formatted = formatOrpcError(error, options);
    log.error(formatted.message);

    if (log.isDebugMode()) {
      const suffix = Math.random().toString(16).slice(2);
      log.debug_obj(`orpc/${Date.now()}_${suffix}.json`, formatted.debugDump);
    }
  },
  router: existingRouter,
}: OrpcServerOptions): Promise<OrpcServer> {
  // Express app setup
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  let spaIndexHtml: string | null = null;

  // Static file serving (optional)
  if (serveStatic) {
    try {
      const indexHtmlPath = path.join(staticDir, "index.html");
      const indexHtml = await fs.readFile(indexHtmlPath, "utf8");
      spaIndexHtml = injectBaseHref(indexHtml, "/");
    } catch (error) {
      log.error("Failed to read index.html for SPA fallback:", error);
    }

    app.use(express.static(staticDir));
  }

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Version endpoint
  app.get("/version", (_req, res) => {
    res.json({ ...VERSION, mode: "server" });
  });

  // --- Mux Gateway OAuth (unauthenticated bootstrap routes) ---
  // These are raw Express routes (not oRPC) because the OAuth provider cannot
  // send a mux Bearer token during the redirect callback.
  app.get("/auth/mux-gateway/start", (req, res) => {
    if (authToken?.trim()) {
      const expectedToken = authToken.trim();
      const presentedToken = extractBearerToken(req.header("authorization"));
      if (!presentedToken || !safeEq(presentedToken, expectedToken)) {
        res.status(401).json({ error: "Invalid or missing auth token" });
        return;
      }
    }

    const hostHeader = req.get("x-forwarded-host") ?? req.get("host");
    const host = hostHeader?.split(",")[0]?.trim();
    if (!host) {
      res.status(400).json({ error: "Missing Host header" });
      return;
    }

    // When mux is running behind a reverse proxy, the terminating proxy may set
    // X-Forwarded-Proto / X-Forwarded-Host, while the direct connection to mux
    // is plain HTTP.
    const protoHeader = req.get("x-forwarded-proto");
    const forwardedProto = protoHeader?.split(",")[0]?.trim();
    const proto = forwardedProto?.length ? forwardedProto : req.protocol;

    const redirectUri = `${proto}://${host}/auth/mux-gateway/callback`;
    const { authorizeUrl, state } = context.muxGatewayOauthService.startServerFlow({ redirectUri });
    res.json({ authorizeUrl, state });
  });

  app.get("/auth/mux-gateway/callback", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const error = typeof req.query.error === "string" ? req.query.error : null;
    const errorDescription =
      typeof req.query.error_description === "string" ? req.query.error_description : undefined;

    const result = await context.muxGatewayOauthService.handleServerCallbackAndExchange({
      state,
      code,
      error,
      errorDescription,
    });

    const payload = {
      type: "mux-gateway-oauth",
      state,
      ok: result.success,
      error: result.success ? null : result.error,
    };

    const payloadJson = escapeJsonForHtmlScript(payload);

    const title = result.success ? "Login complete" : "Login failed";
    const description = result.success
      ? "You can return to Mux. You may now close this tab."
      : payload.error
        ? escapeHtml(payload.error)
        : "An unknown error occurred.";

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#0e0e0e" />
    <title>${title}</title>
    <link rel="stylesheet" href="https://gateway.mux.coder.com/static/css/site.css" />
  </head>
  <body>
    <div class="page">
      <header class="site-header">
        <div class="container">
          <div class="header-title">mux</div>
        </div>
      </header>

      <main class="site-main">
        <div class="container">
          <div class="content-surface">
            <h1>${title}</h1>
            <p>${description}</p>
            ${result.success ? '<p class="muted">This tab should close automatically.</p>' : ""}
            <p><a class="btn primary" href="/">Return to Mux</a></p>
          </div>
        </div>
      </main>
    </div>

    <script>
      (() => {
        const payload = ${payloadJson};
        const ok = payload.ok === true;

        try {
          if (window.opener && typeof window.opener.postMessage === "function") {
            window.opener.postMessage(payload, "*");
          }
        } catch {
          // Ignore postMessage failures.
        }

        if (!ok) {
          return;
        }

        try {
          if (window.opener && typeof window.opener.focus === "function") {
            window.opener.focus();
          }
        } catch {
          // Ignore focus failures.
        }

        try {
          window.close();
        } catch {
          // Ignore close failures.
        }

        setTimeout(() => {
          try {
            window.close();
          } catch {
            // Ignore close failures.
          }
        }, 50);

        setTimeout(() => {
          try {
            window.location.replace("/");
          } catch {
            // Ignore navigation failures.
          }
        }, 150);
      })();
    </script>
  </body>
</html>`;

    res.status(result.success ? 200 : 400);
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  const orpcRouter = existingRouter ?? router(authToken);

  // OpenAPI generator for spec endpoint
  const openAPIGenerator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });

  // OpenAPI spec endpoint
  app.get("/api/spec.json", async (_req, res) => {
    const versionRecord = VERSION as Record<string, unknown>;
    const gitDescribe =
      typeof versionRecord.git_describe === "string" ? versionRecord.git_describe : "unknown";

    const spec = await openAPIGenerator.generate(orpcRouter, {
      info: {
        title: "Mux API",
        version: gitDescribe,
        description: "API for Mux",
      },
      servers: [{ url: "/api" }],
      security: authToken ? [{ bearerAuth: [] }] : undefined,
      components: authToken
        ? {
            securitySchemes: {
              bearerAuth: {
                type: "http",
                scheme: "bearer",
              },
            },
          }
        : undefined,
    });
    res.json(spec);
  });

  // Scalar API reference UI
  app.get("/api/docs", (_req, res) => {
    const html = `<!doctype html>
<html>
  <head>
    <title>mux API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', {
        url: '/api/spec.json',
        ${authToken ? "authentication: { securitySchemes: { bearerAuth: { token: '' } } }," : ""}
      })
    </script>
  </body>
</html>`;
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  // OpenAPI REST handler (for Scalar/OpenAPI clients)
  const openAPIHandler = new OpenAPIHandler(orpcRouter, {
    interceptors: [onError(onOrpcError)],
  });

  app.use("/api", async (req, res, next) => {
    // Skip spec.json and docs routes - they're handled above
    if (req.path === "/spec.json" || req.path === "/docs") {
      return next();
    }
    const { matched } = await openAPIHandler.handle(req, res, {
      prefix: "/api",
      context: { ...context, headers: req.headers },
    });
    if (matched) return;
    next();
  });

  // oRPC HTTP handler
  const orpcHandler = new RPCHandler(orpcRouter, {
    interceptors: [onError(onOrpcError)],
  });

  // Mount ORPC handler on /orpc and all subpaths
  app.use("/orpc", async (req, res, next) => {
    const { matched } = await orpcHandler.handle(req, res, {
      prefix: "/orpc",
      context: { ...context, headers: req.headers },
    });
    if (matched) return;
    next();
  });

  // SPA fallback (optional, only for non-API routes)
  if (serveStatic) {
    app.use((req, res, next) => {
      // Don't swallow API/ORPC routes with index.html.
      if (req.path.startsWith("/orpc") || req.path.startsWith("/api")) {
        return next();
      }

      if (spaIndexHtml !== null) {
        res.setHeader("Content-Type", "text/html");
        res.send(spaIndexHtml);
        return;
      }

      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  // Create HTTP server
  const httpServer = http.createServer(app);

  // Avoid process crashes from unhandled socket/server errors.
  attachStreamErrorHandler(httpServer, "orpc-http-server", { logger: log });

  httpServer.on("clientError", (error, socket) => {
    if (isIgnorableStreamError(error)) {
      socket.destroy();
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;

    log.warn("ORPC HTTP client error", { code, message });

    try {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {
      socket.destroy();
    }
  });

  // oRPC WebSocket handler
  const wsServer = new WebSocketServer({ server: httpServer, path: "/orpc/ws" });

  attachStreamErrorHandler(wsServer, "orpc-ws-server", { logger: log });

  // WebSocket heartbeat: proactively terminate half-open connections (common with NAT/proxy setups).
  // When a client is unresponsive, closing the socket forces the browser to reconnect.
  const heartbeatInterval = setInterval(() => {
    for (const ws of wsServer.clients) {
      const socket = ws as AliveWebSocket;
      if (socket.isAlive === false) {
        ws.terminate();
        continue;
      }

      socket.isAlive = false;
      try {
        ws.ping();
      } catch {
        // Best-effort - ws may already be closing.
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);

  const orpcWsHandler = new ORPCWebSocketServerHandler(orpcRouter, {
    interceptors: [onError(onOrpcError)],
  });

  wsServer.on("connection", (ws, req) => {
    const terminate = () => {
      try {
        ws.terminate();
      } catch {
        // Best-effort.
      }
    };

    attachStreamErrorHandler(ws, "orpc-ws-connection", {
      logger: log,
      onIgnorable: terminate,
      onUnexpected: terminate,
    });
    const socket = ws as AliveWebSocket;
    socket.isAlive = true;
    ws.on("pong", () => {
      socket.isAlive = true;
    });

    const headers = extractWsHeaders(req);
    void orpcWsHandler.upgrade(ws, { context: { ...context, headers } });
  });

  // Start listening
  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error) => {
      httpServer.removeListener("error", onListenError);
      reject(error);
    };

    httpServer.once("error", onListenError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", onListenError);
      resolve();
    });
  });

  // Get actual port (useful when port=0)
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }
  const actualPort = address.port;

  // Wildcard addresses (0.0.0.0, ::) are not routable - convert to loopback for lockfile
  const connectableHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const connectableHostForUrl = formatHostForUrl(connectableHost);

  return {
    httpServer,
    wsServer,
    app,
    port: actualPort,
    baseUrl: `http://${connectableHostForUrl}:${actualPort}`,
    wsUrl: `ws://${connectableHostForUrl}:${actualPort}/orpc/ws`,
    specUrl: `http://${connectableHostForUrl}:${actualPort}/api/spec.json`,
    docsUrl: `http://${connectableHostForUrl}:${actualPort}/api/docs`,
    close: async () => {
      clearInterval(heartbeatInterval);
      for (const ws of wsServer.clients) {
        ws.terminate();
      }

      // Close WebSocket server first
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
      });
      // Then close HTTP server
      httpServer.closeIdleConnections?.();
      httpServer.closeAllConnections?.();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
  };
}
