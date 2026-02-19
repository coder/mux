import * as crypto from "crypto";
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
import { createDeferred, renderOAuthCallbackHtml } from "@/node/utils/oauthUtils";
import { startLoopbackServer } from "@/node/utils/oauthLoopbackServer";
import { OAuthFlowManager } from "@/node/utils/oauthFlowManager";
import { getErrorMessage } from "@/common/utils/errors";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SERVER_TIMEOUT_MS = 10 * 60 * 1000;

interface ServerFlow {
  state: string;
  expiresAtMs: number;
}

export class MuxGatewayOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly serverFlows = new Map<string, ServerFlow>();

  constructor(
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async startDesktopFlow(): Promise<
    Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>
  > {
    const flowId = crypto.randomUUID();
    const resultDeferred = createDeferred<Result<void, string>>();

    let loopback;
    try {
      loopback = await startLoopbackServer({
        expectedState: flowId,
        deferSuccessResponse: true,
        renderHtml: (r) =>
          renderOAuthCallbackHtml({
            title: r.success ? "Login complete" : "Login failed",
            message: r.success
              ? "You can return to Mux. You may now close this tab."
              : (r.error ?? "Unknown error"),
            success: r.success,
            extraHead:
              '<meta name="theme-color" content="#0e0e0e" />\n    <link rel="stylesheet" href="https://gateway.mux.coder.com/static/css/site.css" />',
          }),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to start OAuth callback listener: ${message}`);
    }

    const authorizeUrl = buildAuthorizeUrl({ redirectUri: loopback.redirectUri, state: flowId });

    this.desktopFlows.register(flowId, {
      server: loopback.server,
      resultDeferred,
      // Keep server-side timeout tied to flow lifetime so abandoned flows
      // (e.g. callers that never invoke waitForDesktopFlow) still self-clean.
      timeoutHandle: setTimeout(() => {
        void this.desktopFlows.finish(flowId, Err("Timed out waiting for OAuth callback"));
      }, DEFAULT_DESKTOP_TIMEOUT_MS),
    });

    // Background task: await loopback callback, do token exchange, finish flow.
    // Race against resultDeferred so that if the flow is cancelled/timed out
    // externally, this task exits cleanly instead of dangling on loopback.result.
    void (async () => {
      const callbackOrDone = await Promise.race([
        loopback.result,
        resultDeferred.promise.then((): null => null),
      ]);

      // Flow was already finished externally (timeout or cancel).
      if (callbackOrDone === null) return;

      log.debug(`Mux Gateway OAuth callback received (flowId=${flowId})`);

      let result: Result<void, string>;
      if (callbackOrDone.success) {
        result = await this.handleCallbackAndExchange({
          state: callbackOrDone.data.state,
          code: callbackOrDone.data.code,
          error: null,
        });

        if (result.success) {
          loopback.sendSuccessResponse();
        } else {
          loopback.sendFailureResponse(result.error);
        }
      } else {
        result = Err(`Mux Gateway OAuth error: ${callbackOrDone.error}`);
      }

      await this.desktopFlows.finish(flowId, result);
    })();

    log.debug(`Mux Gateway OAuth desktop flow started (flowId=${flowId})`);

    return Ok({ flowId, authorizeUrl, redirectUri: loopback.redirectUri });
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    return this.desktopFlows.waitFor(flowId, opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS);
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    if (!this.desktopFlows.has(flowId)) return;
    log.debug(`Mux Gateway OAuth desktop flow cancelled (flowId=${flowId})`);
    await this.desktopFlows.cancel(flowId);
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
    await this.desktopFlows.shutdownAll();
    this.serverFlows.clear();
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
      const message = getErrorMessage(error);
      return Err(`Mux Gateway exchange failed: ${message}`);
    }
  }
}
