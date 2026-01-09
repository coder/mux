import * as crypto from "crypto";
import * as http from "http";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildAuthorizeUrl,
  buildExchangeBody,
  MUX_GATEWAY_EXCHANGE_URL,
} from "@/common/constants/muxGatewayOAuth";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETED_DESKTOP_FLOW_TTL_MS = 60 * 1000;

interface DesktopFlow {
  flowId: string;
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

export class MuxGatewayOauthService {
  private readonly desktopFlows = new Map<string, DesktopFlow>();
  private readonly serverFlows = new Map<string, ServerFlow>();

  constructor(
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async startDesktopFlow(): Promise<
    Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>
  > {
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
    const authorizeUrl = buildAuthorizeUrl({ redirectUri, state: flowId });

    const timeout = setTimeout(() => {
      void this.finishDesktopFlow(flowId, Err("Timed out waiting for OAuth callback"));
    }, DEFAULT_DESKTOP_TIMEOUT_MS);

    this.desktopFlows.set(flowId, {
      flowId,
      authorizeUrl,
      redirectUri,
      server,
      timeout,
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    });

    log.debug(`Mux Gateway OAuth desktop flow started (flowId=${flowId})`);

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

    log.debug(`Mux Gateway OAuth desktop flow cancelled (flowId=${flowId})`);
    await this.finishDesktopFlow(flowId, Err("OAuth flow cancelled"));
  }

  startServerFlow(input: { redirectUri: string }): { authorizeUrl: string; state: string } {
    const state = crypto.randomUUID();
    // Prune expired flows (best-effort; avoids unbounded growth if callbacks never arrive).
    const now = Date.now();
    for (const [key, flow] of this.serverFlows) {
      if (flow.expiresAtMs <= now) {
        this.serverFlows.delete(key);
      }
    }

    const authorizeUrl = buildAuthorizeUrl({ redirectUri: input.redirectUri, state });

    this.serverFlows.set(state, {
      state,
      expiresAtMs: Date.now() + DEFAULT_SERVER_TIMEOUT_MS,
    });

    log.debug(`Mux Gateway OAuth server flow started (state=${state})`);

    return { authorizeUrl, state };
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
    this.serverFlows.delete(state);

    return this.handleCallbackAndExchange({
      state,
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

    log.debug(`Mux Gateway OAuth callback received (flowId=${input.flowId})`);

    const result = await this.handleCallbackAndExchange({
      state: input.flowId,
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });

    const title = result.success ? "Login complete" : "Login failed";
    const description = result.success
      ? "You can return to Mux. You may now close this tab."
      : escapeHtml(result.error);

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
            ${
              result.success
                ? '<p class="muted">Mux should now be in the foreground. You can close this tab.</p>'
                : '<p class="muted">You can close this tab.</p>'
            }
          </div>
        </div>
      </main>
    </div>

    <script>
      (() => {
        const ok = ${result.success ? "true" : "false"};
        if (!ok) {
          return;
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
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    if (input.error) {
      const message = input.errorDescription
        ? `${input.error}: ${input.errorDescription}`
        : input.error;
      return Err(`Mux Gateway OAuth error: ${message}`);
    }

    if (!input.code) {
      return Err("Missing OAuth code");
    }

    const tokenResult = await this.exchangeCodeForToken(input.code);
    if (!tokenResult.success) {
      return Err(tokenResult.error);
    }

    const persistResult = this.providerService.setConfig(
      "mux-gateway",
      ["couponCode"],
      tokenResult.data
    );
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    log.debug(`Mux Gateway OAuth exchange completed (state=${input.state})`);

    this.windowService?.focusMainWindow();

    return Ok(undefined);
  }

  private async exchangeCodeForToken(code: string): Promise<Result<string, string>> {
    try {
      const response = await fetch(MUX_GATEWAY_EXCHANGE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: buildExchangeBody({ code }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Mux Gateway exchange failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as { access_token?: unknown };
      const token = typeof json.access_token === "string" ? json.access_token : null;
      if (!token) {
        return Err("Mux Gateway exchange response missing access_token");
      }

      return Ok(token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Mux Gateway exchange failed: ${message}`);
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
