/**
 * OAuth service for Mux Governor enrollment.
 *
 * Similar pattern to MuxGatewayOauthService but:
 * - Takes a user-provided governor origin (not hardcoded)
 * - Persists credentials to config.json (muxGovernorUrl + muxGovernorToken)
 */

import * as crypto from "crypto";
import * as http from "http";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildGovernorAuthorizeUrl,
  buildGovernorExchangeBody,
  buildGovernorExchangeUrl,
  normalizeGovernorUrl,
} from "@/common/constants/muxGovernorOAuth";
import type { Config } from "@/node/config";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETED_DESKTOP_FLOW_TTL_MS = 60 * 1000;

interface DesktopFlow {
  flowId: string;
  governorOrigin: string;
  authorizeUrl: string;
  redirectUri: string;
  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
  settled: boolean;
}

interface ServerFlow {
  state: string;
  governorOrigin: string;
  expiresAtMs: number;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

export class MuxGovernorOauthService {
  private readonly desktopFlows = new Map<string, DesktopFlow>();
  private readonly serverFlows = new Map<string, ServerFlow>();

  constructor(
    private readonly config: Config,
    private readonly windowService?: WindowService
  ) {}

  async startDesktopFlow(input: {
    governorOrigin: string;
  }): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    // Normalize and validate the governor origin
    let governorOrigin: string;
    try {
      governorOrigin = normalizeGovernorUrl(input.governorOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Invalid Governor URL: ${message}`);
    }

    const flowId = crypto.randomUUID();

    const { promise: resultPromise, resolve: resolveResult } =
      createDeferred<Result<void, string>>();

    const server = http.createServer((req, res) => {
      const reqUrl = req.url ?? "/";
      const url = new URL(reqUrl, "http://localhost");

      if (req.method !== "GET" || url.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const state = url.searchParams.get("state");
      if (!state || state !== flowId) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html");
        res.end("<h1>Invalid OAuth state</h1>");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const errorDescription = url.searchParams.get("error_description") ?? undefined;

      void this.handleDesktopCallback({
        flowId,
        governorOrigin,
        code,
        error,
        errorDescription,
        res,
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to start OAuth callback listener: ${message}`);
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      return Err("Failed to determine OAuth callback listener port");
    }

    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const authorizeUrl = buildGovernorAuthorizeUrl({
      governorOrigin,
      redirectUri,
      state: flowId,
    });

    const timeout = setTimeout(() => {
      void this.finishDesktopFlow(flowId, Err("Timed out waiting for OAuth callback"));
    }, DEFAULT_DESKTOP_TIMEOUT_MS);

    this.desktopFlows.set(flowId, {
      flowId,
      governorOrigin,
      authorizeUrl,
      redirectUri,
      server,
      timeout,
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    });

    log.debug(
      `Mux Governor OAuth desktop flow started (flowId=${flowId}, origin=${governorOrigin})`
    );

    return Ok({ flowId, authorizeUrl, redirectUri });
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow) {
      return Err("OAuth flow not found");
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for OAuth callback"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      // Ensure listener is closed on timeout/errors.
      void this.finishDesktopFlow(flowId, result);
    }

    return result;
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow) return;

    log.debug(`Mux Governor OAuth desktop flow cancelled (flowId=${flowId})`);
    await this.finishDesktopFlow(flowId, Err("OAuth flow cancelled"));
  }

  startServerFlow(input: {
    governorOrigin: string;
    redirectUri: string;
  }): Result<{ authorizeUrl: string; state: string }, string> {
    // Normalize and validate the governor origin
    let governorOrigin: string;
    try {
      governorOrigin = normalizeGovernorUrl(input.governorOrigin);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Invalid Governor URL: ${message}`);
    }

    const state = crypto.randomUUID();

    // Prune expired flows (best-effort; avoids unbounded growth if callbacks never arrive).
    const now = Date.now();
    for (const [key, flow] of this.serverFlows) {
      if (flow.expiresAtMs <= now) {
        this.serverFlows.delete(key);
      }
    }

    const authorizeUrl = buildGovernorAuthorizeUrl({
      governorOrigin,
      redirectUri: input.redirectUri,
      state,
    });

    this.serverFlows.set(state, {
      state,
      governorOrigin,
      expiresAtMs: Date.now() + DEFAULT_SERVER_TIMEOUT_MS,
    });

    log.debug(`Mux Governor OAuth server flow started (state=${state}, origin=${governorOrigin})`);

    return Ok({ authorizeUrl, state });
  }

  async handleServerCallbackAndExchange(input: {
    state: string | null;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    const state = input.state;
    if (!state) {
      return Err("Missing OAuth state");
    }

    const flow = this.serverFlows.get(state);
    if (!flow) {
      return Err("Unknown OAuth state");
    }

    if (Date.now() > flow.expiresAtMs) {
      this.serverFlows.delete(state);
      return Err("OAuth flow expired");
    }

    // Regardless of outcome, this flow should not be reused.
    const governorOrigin = flow.governorOrigin;
    this.serverFlows.delete(state);

    return this.handleCallbackAndExchange({
      state,
      governorOrigin,
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });
  }

  async dispose(): Promise<void> {
    // Best-effort: cancel all in-flight flows.
    const flowIds = [...this.desktopFlows.keys()];
    await Promise.all(flowIds.map((id) => this.finishDesktopFlow(id, Err("App shutting down"))));

    for (const flow of this.desktopFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    this.desktopFlows.clear();
    this.serverFlows.clear();
  }

  private async handleDesktopCallback(input: {
    flowId: string;
    governorOrigin: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
    res: http.ServerResponse;
  }): Promise<void> {
    const flow = this.desktopFlows.get(input.flowId);
    if (!flow || flow.settled) {
      input.res.statusCode = 409;
      input.res.setHeader("Content-Type", "text/html");
      input.res.end("<h1>OAuth flow already completed</h1>");
      return;
    }

    log.debug(`Mux Governor OAuth callback received (flowId=${input.flowId})`);

    const result = await this.handleCallbackAndExchange({
      state: input.flowId,
      governorOrigin: input.governorOrigin,
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });

    const title = result.success ? "Enrollment complete" : "Enrollment failed";
    const description = result.success
      ? "You can return to Mux. You may now close this tab."
      : escapeHtml(result.error);

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 600px; margin: 4rem auto; padding: 1rem; }
      h1 { margin-bottom: 1rem; }
      .muted { color: #666; }
    </style>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${description}</p>
    ${
      result.success
        ? '<p class="muted">Mux should now be in the foreground. You can close this tab.</p>'
        : '<p class="muted">You can close this tab.</p>'
    }
    <script>
      (() => {
        const ok = ${result.success ? "true" : "false"};
        if (!ok) return;
        try { window.close(); } catch {}
        setTimeout(() => { try { window.close(); } catch {} }, 50);
      })();
    </script>
  </body>
</html>`;

    input.res.setHeader("Content-Type", "text/html");
    if (!result.success) {
      input.res.statusCode = 400;
    }

    input.res.end(html);

    await this.finishDesktopFlow(input.flowId, result);
  }

  private async handleCallbackAndExchange(input: {
    state: string;
    governorOrigin: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    if (input.error) {
      const message = input.errorDescription
        ? `${input.error}: ${input.errorDescription}`
        : input.error;
      return Err(`Mux Governor OAuth error: ${message}`);
    }

    if (!input.code) {
      return Err("Missing OAuth code");
    }

    const tokenResult = await this.exchangeCodeForToken(input.code, input.governorOrigin);
    if (!tokenResult.success) {
      return Err(tokenResult.error);
    }

    // Persist to config.json
    try {
      await this.config.editConfig((config) => ({
        ...config,
        muxGovernorUrl: input.governorOrigin,
        muxGovernorToken: tokenResult.data,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to save Governor credentials: ${message}`);
    }

    log.debug(`Mux Governor OAuth exchange completed (state=${input.state})`);

    this.windowService?.focusMainWindow();

    return Ok(undefined);
  }

  private async exchangeCodeForToken(
    code: string,
    governorOrigin: string
  ): Promise<Result<string, string>> {
    const exchangeUrl = buildGovernorExchangeUrl(governorOrigin);

    try {
      const response = await fetch(exchangeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: buildGovernorExchangeBody({ code }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Mux Governor exchange failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as { access_token?: unknown };
      const token = typeof json.access_token === "string" ? json.access_token : null;
      if (!token) {
        return Err("Mux Governor exchange response missing access_token");
      }

      return Ok(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Mux Governor exchange failed: ${message}`);
    }
  }

  private async finishDesktopFlow(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow || flow.settled) return;

    flow.settled = true;
    clearTimeout(flow.timeout);

    try {
      flow.resolveResult(result);

      // Stop accepting new connections.
      await closeServer(flow.server);
    } catch (error) {
      log.debug("Failed to close OAuth callback listener:", error);
    } finally {
      // Keep the completed flow around briefly so callers can still await the result.
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
      flow.cleanupTimeout = setTimeout(() => {
        this.desktopFlows.delete(flowId);
      }, COMPLETED_DESKTOP_FLOW_TTL_MS);
    }
  }
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
