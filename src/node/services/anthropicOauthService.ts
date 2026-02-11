/**
 * Anthropic OAuth service for Claude Max/Pro subscription authentication.
 *
 * Uses a code-paste flow: user opens an auth URL, authorizes, and pastes
 * back the displayed code. Simpler than the Codex OAuth flow (no local
 * HTTP server, no device flow).
 */

import * as crypto from "crypto";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildAnthropicAuthorizeUrl,
  buildAnthropicTokenExchangeBody,
  buildAnthropicRefreshBody,
  ANTHROPIC_OAUTH_TOKEN_URL,
} from "@/common/constants/anthropicOAuth";
import type { Config } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  isAnthropicOauthAuthExpired,
  parseAnthropicOauthAuth,
  type AnthropicOauthAuth,
} from "@/node/utils/anthropicOauthAuth";

const DEFAULT_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingCodePasteFlow {
  flowId: string;
  /** Random state for CSRF validation. */
  state: string;
  /** PKCE code verifier. */
  codeVerifier: string;
  timeout: ReturnType<typeof setTimeout>;
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest().toString("base64url");
}

function randomBase64Url(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isInvalidGrantError(errorText: string): boolean {
  const trimmed = errorText.trim();
  if (trimmed.length === 0) return false;

  try {
    const json = JSON.parse(trimmed) as unknown;
    if (isPlainObject(json) && json.error === "invalid_grant") {
      return true;
    }
  } catch {
    // Fall through to substring check.
  }

  const lower = trimmed.toLowerCase();
  return lower.includes("invalid_grant") || lower.includes("revoked");
}

export class AnthropicOauthService {
  private pendingFlow: PendingCodePasteFlow | null = null;
  private readonly refreshMutex = new AsyncMutex();

  // In-memory cache so getValidAuth() skips disk reads when tokens are valid.
  // Invalidated on every write (exchange, refresh, disconnect).
  private cachedAuth: AnthropicOauthAuth | null = null;

  constructor(
    private readonly config: Config,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  /**
   * Start the OAuth code-paste flow: generate PKCE, build authorize URL.
   * The frontend opens the URL in the browser and shows a code input field.
   */
  startFlow(): Result<{ flowId: string; authorizeUrl: string }, string> {
    // Cancel any existing pending flow.
    if (this.pendingFlow) {
      clearTimeout(this.pendingFlow.timeout);
      this.pendingFlow = null;
    }

    const flowId = randomBase64Url();
    const state = randomBase64Url();
    const codeVerifier = randomBase64Url();
    const codeChallenge = sha256Base64Url(codeVerifier);

    const authorizeUrl = buildAnthropicAuthorizeUrl({ state, codeChallenge });

    const timeout = setTimeout(() => {
      if (this.pendingFlow?.flowId === flowId) {
        log.debug(`[Anthropic OAuth] Flow timed out (flowId=${flowId})`);
        this.pendingFlow = null;
      }
    }, DEFAULT_FLOW_TIMEOUT_MS);

    this.pendingFlow = { flowId, state, codeVerifier, timeout };

    log.debug(`[Anthropic OAuth] Flow started (flowId=${flowId})`);
    return Ok({ flowId, authorizeUrl });
  }

  /**
   * Submit the pasted authorization code from the user.
   * Expected format: "code#state" (as displayed by Anthropic's callback page).
   */
  async submitCode(input: { flowId: string; code: string }): Promise<Result<void, string>> {
    const flow = this.pendingFlow;
    if (!flow || flow.flowId !== input.flowId) {
      return Err("No pending OAuth flow with that ID");
    }

    // Parse "code#state" format
    const hashIndex = input.code.indexOf("#");
    if (hashIndex === -1) {
      return Err("Invalid authorization code format (expected code#state)");
    }

    const code = input.code.slice(0, hashIndex);
    const state = input.code.slice(hashIndex + 1);

    if (!code) {
      return Err("Authorization code is empty");
    }

    // Clear the pending flow before exchange (one-shot).
    clearTimeout(flow.timeout);
    this.pendingFlow = null;

    const exchangeResult = await this.exchangeCodeForTokens({
      code,
      state,
      codeVerifier: flow.codeVerifier,
    });

    if (!exchangeResult.success) {
      return Err(exchangeResult.error);
    }

    const persistResult = this.persistAuth(exchangeResult.data);
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    log.debug("[Anthropic OAuth] Successfully connected");

    // Focus the main window so the user sees the updated settings.
    this.windowService?.focusMainWindow();

    return Ok(undefined);
  }

  cancelFlow(flowId: string): void {
    if (this.pendingFlow?.flowId === flowId) {
      clearTimeout(this.pendingFlow.timeout);
      this.pendingFlow = null;
      log.debug(`[Anthropic OAuth] Flow cancelled (flowId=${flowId})`);
    }
  }

  disconnect(): Result<void, string> {
    this.cachedAuth = null;
    return this.providerService.setConfigValue("anthropic", ["anthropicOauth"], undefined);
  }

  async getValidAuth(): Promise<Result<AnthropicOauthAuth, string>> {
    const stored = this.readStoredAuth();
    if (!stored) {
      return Err("Anthropic OAuth is not configured");
    }

    if (!isAnthropicOauthAuthExpired(stored)) {
      return Ok(stored);
    }

    await using _lock = await this.refreshMutex.acquire();

    // Re-read after acquiring lock in case another caller refreshed first.
    const latest = this.readStoredAuth();
    if (!latest) {
      return Err("Anthropic OAuth is not configured");
    }

    if (!isAnthropicOauthAuthExpired(latest)) {
      return Ok(latest);
    }

    const refreshed = await this.refreshTokens(latest);
    if (!refreshed.success) {
      return Err(refreshed.error);
    }

    return Ok(refreshed.data);
  }

  dispose(): void {
    if (this.pendingFlow) {
      clearTimeout(this.pendingFlow.timeout);
      this.pendingFlow = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private readStoredAuth(): AnthropicOauthAuth | null {
    if (this.cachedAuth) {
      return this.cachedAuth;
    }
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const anthropicConfig = providersConfig.anthropic as Record<string, unknown> | undefined;
    const auth = parseAnthropicOauthAuth(anthropicConfig?.anthropicOauth);
    this.cachedAuth = auth;
    return auth;
  }

  private persistAuth(auth: AnthropicOauthAuth): Result<void, string> {
    const result = this.providerService.setConfigValue("anthropic", ["anthropicOauth"], auth);
    // Invalidate cache so the next read picks up the persisted value from disk.
    this.cachedAuth = null;
    return result;
  }

  private async exchangeCodeForTokens(input: {
    code: string;
    state: string;
    codeVerifier: string;
  }): Promise<Result<AnthropicOauthAuth, string>> {
    try {
      const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildAnthropicTokenExchangeBody({
          code: input.code,
          state: input.state,
          codeVerifier: input.codeVerifier,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Anthropic OAuth exchange failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Anthropic OAuth exchange returned an invalid JSON payload");
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);

      if (!accessToken) {
        return Err("Anthropic OAuth exchange response missing access_token");
      }

      if (!refreshToken) {
        return Err("Anthropic OAuth exchange response missing refresh_token");
      }

      if (expiresIn === null) {
        return Err("Anthropic OAuth exchange response missing expires_in");
      }

      return Ok({
        type: "oauth",
        access: accessToken,
        refresh: refreshToken,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Anthropic OAuth exchange failed: ${message}`);
    }
  }

  private async refreshTokens(
    current: AnthropicOauthAuth
  ): Promise<Result<AnthropicOauthAuth, string>> {
    try {
      const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildAnthropicRefreshBody({ refreshToken: current.refresh }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");

        // When the refresh token is invalid/revoked, clear persisted auth so
        // subsequent requests fall back to "not connected" behavior.
        if (isInvalidGrantError(errorText)) {
          log.debug("[Anthropic OAuth] Refresh token rejected; clearing stored auth");
          const disconnectResult = this.disconnect();
          if (!disconnectResult.success) {
            log.warn(
              `[Anthropic OAuth] Failed to clear stored auth after refresh failure: ${disconnectResult.error}`
            );
          }
        }

        const prefix = `Anthropic OAuth refresh failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Anthropic OAuth refresh returned an invalid JSON payload");
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);

      if (!accessToken) {
        return Err("Anthropic OAuth refresh response missing access_token");
      }

      if (expiresIn === null) {
        return Err("Anthropic OAuth refresh response missing expires_in");
      }

      const next: AnthropicOauthAuth = {
        type: "oauth",
        access: accessToken,
        refresh: refreshToken ?? current.refresh,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
      };

      const persistResult = this.persistAuth(next);
      if (!persistResult.success) {
        return Err(persistResult.error);
      }

      return Ok(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Anthropic OAuth refresh failed: ${message}`);
    }
  }
}
