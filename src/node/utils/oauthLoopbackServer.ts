import http from "node:http";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import { closeServer, createDeferred, renderOAuthCallbackHtml } from "@/node/utils/oauthUtils";

/**
 * Shared loopback OAuth callback server.
 *
 * Four OAuth services (Gateway, Governor, Codex, MCP) spin up a local HTTP
 * server to receive the authorization code redirect. The pattern is identical
 * across all four — this module extracts that into a single reusable utility.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoopbackServerOptions {
  /** Port to listen on. 0 = random (default). Codex uses 1455. */
  port?: number;
  /** Host to bind to. Default: "127.0.0.1" */
  host?: string;
  /** Path to match for the OAuth callback. Default: "/callback" */
  callbackPath?: string;
  /** Expected state parameter value for CSRF validation. */
  expectedState: string;
  /** Whether to validate that remoteAddress is a loopback address. Default: false. Codex uses true. */
  validateLoopback?: boolean;
  /** Custom HTML renderer. If not provided, uses renderOAuthCallbackHtml with generic branding. */
  renderHtml?: (result: { success: boolean; error?: string }) => string;
}

export interface LoopbackCallbackResult {
  code: string;
  state: string;
}

export interface LoopbackServer {
  /** The full redirect URI (http://127.0.0.1:{port}{callbackPath}). */
  redirectUri: string;
  /** The underlying HTTP server (needed by OAuthFlowManager for cleanup). */
  server: http.Server;
  /** Resolves when callback received or resolves with Err on invalid state. */
  result: Promise<Result<LoopbackCallbackResult, string>>;
  /** Cancel and close the server. */
  cancel: () => Promise<void>;
  /** Close the server. */
  close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an address string is a loopback address.
 * Node may normalize IPv4 loopback to an IPv6-mapped address.
 *
 * Extracted from codexOauthService.ts where validateLoopback is used.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;

  // Node may normalize IPv4 loopback to an IPv6-mapped address.
  if (address === "::ffff:127.0.0.1") {
    return true;
  }

  return address === "127.0.0.1" || address === "::1";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Start a loopback HTTP server to receive an OAuth authorization code callback.
 *
 * Pattern extracted from the `http.createServer` blocks in Gateway, Governor,
 * Codex, and MCP OAuth services. The server:
 *
 * 1. Optionally validates the remote address is loopback (Codex).
 * 2. Matches only GET requests on `callbackPath`.
 * 3. Validates the `state` query parameter against `expectedState`.
 * 4. Extracts `code` from the query string.
 * 5. Responds with HTML (success or error).
 * 6. Resolves the result deferred — the caller then performs token exchange
 *    and calls `close()`.
 *
 * The server does NOT close itself after responding — the caller decides when
 * to close (matching the existing pattern where services call `closeServer`
 * after token exchange).
 */
export async function startLoopbackServer(options: LoopbackServerOptions): Promise<LoopbackServer> {
  const port = options.port ?? 0;
  const host = options.host ?? "127.0.0.1";
  const callbackPath = options.callbackPath ?? "/callback";
  const validateLoopback = options.validateLoopback ?? false;

  const deferred = createDeferred<Result<LoopbackCallbackResult, string>>();

  const render =
    options.renderHtml ??
    ((r: { success: boolean; error?: string }) =>
      renderOAuthCallbackHtml({
        title: r.success ? "Login complete" : "Login failed",
        message: r.success
          ? "You can return to Mux. You may now close this tab."
          : (r.error ?? "Unknown error"),
        success: r.success,
      }));

  const server = http.createServer((req, res) => {
    // Optionally reject non-loopback connections (Codex sets validateLoopback: true).
    if (validateLoopback && !isLoopbackAddress(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    const reqUrl = req.url ?? "/";
    const url = new URL(reqUrl, "http://localhost");

    if (req.method !== "GET" || url.pathname !== callbackPath) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const state = url.searchParams.get("state");
    if (!state || state !== options.expectedState) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/html");
      res.end("<h1>Invalid OAuth state</h1>");
      deferred.resolve(Err("Invalid OAuth state"));
      return;
    }

    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description") ?? undefined;

    if (error) {
      const errorMessage = errorDescription ? `${error}: ${errorDescription}` : error;
      res.setHeader("Content-Type", "text/html");
      res.statusCode = 400;
      res.end(render({ success: false, error: errorMessage }));
      deferred.resolve(Err(errorMessage));
      return;
    }

    if (!code) {
      const errorMessage = "Missing authorization code";
      res.setHeader("Content-Type", "text/html");
      res.statusCode = 400;
      res.end(render({ success: false, error: errorMessage }));
      deferred.resolve(Err(errorMessage));
      return;
    }

    res.setHeader("Content-Type", "text/html");
    res.end(render({ success: true }));
    deferred.resolve(Ok({ code, state }));
  });

  // Listen on the specified host/port — mirrors the existing
  // `server.listen(port, host, () => resolve())` pattern.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Failed to determine OAuth callback listener port");
  }

  const redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`;

  return {
    redirectUri,
    server,
    result: deferred.promise,
    cancel: async () => {
      deferred.resolve(Err("OAuth flow cancelled"));
      await closeServer(server);
    },
    close: () => closeServer(server),
  };
}
