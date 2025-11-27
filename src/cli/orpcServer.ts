/**
 * oRPC Server factory for mux.
 * Serves oRPC router over HTTP and WebSocket.
 *
 * This module exports the server creation logic so it can be tested.
 * The CLI entry point (server.ts) uses this to start the server.
 */
import cors from "cors";
import express, { type Express } from "express";
import * as http from "http";
import * as path from "path";
import { WebSocketServer } from "ws";
import { RPCHandler } from "@orpc/server/node";
import { RPCHandler as ORPCWebSocketServerHandler } from "@orpc/server/ws";
import { onError } from "@orpc/server";
import { router } from "@/node/orpc/router";
import type { ORPCContext } from "@/node/orpc/context";
import { extractWsHeaders } from "@/node/orpc/authMiddleware";
import { VERSION } from "@/version";

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
  /** Directory to serve static files from (default: __dirname/..) */
  staticDir?: string;
  /** Custom error handler for oRPC errors */
  onOrpcError?: (error: unknown) => void;
  /** Optional bearer token for HTTP auth */
  authToken?: string;
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
  /** Close the server and cleanup resources */
  close: () => Promise<void>;
}

// --- Server Factory ---

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
  staticDir = path.join(__dirname, ".."),
  onOrpcError = (error) => console.error("ORPC Error:", error),
}: OrpcServerOptions): Promise<OrpcServer> {
  // Express app setup
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "50mb" }));

  // Static file serving (optional)
  if (serveStatic) {
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

  const orpcRouter = router(authToken);

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

  // SPA fallback (optional, only for non-orpc routes)
  if (serveStatic) {
    app.use((req, res, next) => {
      if (!req.path.startsWith("/orpc")) {
        res.sendFile(path.join(staticDir, "index.html"));
      } else {
        next();
      }
    });
  }

  // Create HTTP server
  const httpServer = http.createServer(app);

  // oRPC WebSocket handler
  const wsServer = new WebSocketServer({ server: httpServer, path: "/orpc/ws" });
  const orpcWsHandler = new ORPCWebSocketServerHandler(orpcRouter, {
    interceptors: [onError(onOrpcError)],
  });
  wsServer.on("connection", (ws, req) => {
    const headers = extractWsHeaders(req);
    void orpcWsHandler.upgrade(ws, { context: { ...context, headers } });
  });

  // Start listening
  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });

  // Get actual port (useful when port=0)
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address");
  }
  const actualPort = address.port;

  return {
    httpServer,
    wsServer,
    app,
    port: actualPort,
    baseUrl: `http://${host}:${actualPort}`,
    wsUrl: `ws://${host}:${actualPort}/orpc/ws`,
    close: async () => {
      // Close WebSocket server first
      wsServer.close();
      // Then close HTTP server
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
