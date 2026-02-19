/**
 * OAuth service for Mux Governor enrollment.
 *
 * Similar pattern to MuxGatewayOauthService but:
 * - Takes a user-provided governor origin (not hardcoded)
 * - Persists credentials to config.json (muxGovernorUrl + muxGovernorToken)
 */

import * as crypto from "crypto";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildGovernorAuthorizeUrl,
  buildGovernorExchangeBody,
  buildGovernorExchangeUrl,
  normalizeGovernorUrl,
} from "@/common/constants/muxGovernorOAuth";
import type { Config } from "@/node/config";
import type { PolicyService } from "@/node/services/policyService";
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
  governorOrigin: string;
  expiresAtMs: number;
}

export class MuxGovernorOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly serverFlows = new Map<string, ServerFlow>();

  constructor(
    private readonly config: Config,
    private readonly windowService?: WindowService,
    private readonly policyService?: PolicyService
  ) {}

  async startDesktopFlow(input: {
    governorOrigin: string;
  }): Promise<Result<{ flowId: string; authorizeUrl: string; redirectUri: string }, string>> {
    // Normalize and validate the governor origin
    let governorOrigin: string;
    try {
      governorOrigin = normalizeGovernorUrl(input.governorOrigin);
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Invalid Governor URL: ${message}`);
    }

    const flowId = crypto.randomUUID();

    let loopback: Awaited<ReturnType<typeof startLoopbackServer>>;
    try {
      loopback = await startLoopbackServer({
        expectedState: flowId,
        deferSuccessResponse: true,
        renderHtml: (r) =>
          renderOAuthCallbackHtml({
            title: r.success ? "Enrollment complete" : "Enrollment failed",
            message: r.success
              ? "You can return to Mux. You may now close this tab."
              : (r.error ?? "Unknown error"),
            success: r.success,
          }),
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to start OAuth callback listener: ${message}`);
    }

    const authorizeUrl = buildGovernorAuthorizeUrl({
      governorOrigin,
      redirectUri: loopback.redirectUri,
      state: flowId,
    });

    const resultDeferred = createDeferred<Result<void, string>>();

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

      let result: Result<void, string>;
      if (callbackOrDone.success) {
        result = await this.handleCallbackAndExchange({
          state: flowId,
          governorOrigin,
          code: callbackOrDone.data.code,
          error: null,
        });
      } else {
        result = Err(`Mux Governor OAuth error: ${callbackOrDone.error}`);
      }

      // Render the final browser response based on exchange outcome.
      if (result.success) {
        loopback.sendSuccessResponse();
      } else {
        loopback.sendFailureResponse(result.error);
      }

      await this.desktopFlows.finish(flowId, result);
    })();

    log.debug(
      `Mux Governor OAuth desktop flow started (flowId=${flowId}, origin=${governorOrigin})`
    );

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
    log.debug(`Mux Governor OAuth desktop flow cancelled (flowId=${flowId})`);
    await this.desktopFlows.cancel(flowId);
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
      const message = getErrorMessage(error);
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
    await this.desktopFlows.shutdownAll();
    this.serverFlows.clear();
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
      const message = getErrorMessage(error);
      return Err(`Failed to save Governor credentials: ${message}`);
    }

    log.debug(`Mux Governor OAuth exchange completed (state=${input.state})`);

    this.windowService?.focusMainWindow();

    const refreshResult = await this.policyService?.refreshNow();
    if (refreshResult && !refreshResult.success) {
      log.warn("Policy refresh after Governor enrollment failed", {
        error: refreshResult.error,
      });
    }
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
      const message = getErrorMessage(error);
      return Err(`Mux Governor exchange failed: ${message}`);
    }
  }
}
