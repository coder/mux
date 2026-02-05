import * as crypto from "crypto";
import * as http from "http";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildCodexAuthorizeUrl,
  buildCodexDeviceCodeBody,
  buildCodexDeviceTokenBody,
  buildCodexRefreshBody,
  buildCodexTokenExchangeBody,
  CODEX_OAUTH_DEVICE_CODE_URL,
  CODEX_OAUTH_TOKEN_URL,
} from "@/common/constants/codexOAuth";
import type { Config } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  extractChatGptAccountIdFromTokens,
  isCodexOauthAuthExpired,
  parseCodexOauthAuth,
  type CodexOauthAuth,
} from "@/node/utils/codexOauthAuth";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DEVICE_TIMEOUT_MS = 15 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 60 * 1000;

interface DesktopFlow {
  flowId: string;
  authorizeUrl: string;
  redirectUri: string;
  codeVerifier: string;

  server: http.Server;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;

  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
  settled: boolean;
}

interface DeviceFlow {
  flowId: string;
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  intervalSeconds: number;
  expiresAtMs: number;

  abortController: AbortController;
  pollingStarted: boolean;

  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;

  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
  settled: boolean;
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

export class CodexOauthService {
  private readonly desktopFlows = new Map<string, DesktopFlow>();
  private readonly deviceFlows = new Map<string, DeviceFlow>();

  private readonly refreshMutex = new AsyncMutex();

  constructor(
    private readonly config: Config,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  disconnect(): Result<void, string> {
    // Clear stored ChatGPT OAuth tokens so Codex-only models are hidden again.
    return this.providerService.setConfigValue("openai", ["codexOauth"], undefined);
  }

  async startDesktopFlow(): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
    const flowId = randomBase64Url();

    const codeVerifier = randomBase64Url();
    const codeChallenge = sha256Base64Url(codeVerifier);

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
    const authorizeUrl = buildCodexAuthorizeUrl({
      redirectUri,
      state: flowId,
      codeChallenge,
    });

    const timeout = setTimeout(() => {
      void this.finishDesktopFlow(flowId, Err("Timed out waiting for OAuth callback"));
    }, DEFAULT_DESKTOP_TIMEOUT_MS);

    this.desktopFlows.set(flowId, {
      flowId,
      authorizeUrl,
      redirectUri,
      codeVerifier,
      server,
      timeout,
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    });

    log.debug(`[Codex OAuth] Desktop flow started (flowId=${flowId})`);

    return Ok({ flowId, authorizeUrl });
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

    log.debug(`[Codex OAuth] Desktop flow cancelled (flowId=${flowId})`);
    await this.finishDesktopFlow(flowId, Err("OAuth flow cancelled"));
  }

  async startDeviceFlow(): Promise<
    Result<
      {
        flowId: string;
        userCode: string;
        verifyUrl: string;
        intervalSeconds: number;
      },
      string
    >
  > {
    const flowId = randomBase64Url();

    const deviceCodeResult = await this.requestDeviceCode();
    if (!deviceCodeResult.success) {
      return Err(deviceCodeResult.error);
    }

    const { deviceCode, userCode, verifyUrl, intervalSeconds, expiresAtMs } = deviceCodeResult.data;

    const { promise: resultPromise, resolve: resolveResult } =
      createDeferred<Result<void, string>>();

    const abortController = new AbortController();

    const timeoutMs = Math.min(DEFAULT_DEVICE_TIMEOUT_MS, Math.max(0, expiresAtMs - Date.now()));
    const timeout = setTimeout(() => {
      void this.finishDeviceFlow(flowId, Err("Device code expired"));
    }, timeoutMs);

    this.deviceFlows.set(flowId, {
      flowId,
      deviceCode,
      userCode,
      verifyUrl,
      intervalSeconds,
      expiresAtMs,
      abortController,
      pollingStarted: false,
      timeout,
      cleanupTimeout: null,
      resultPromise,
      resolveResult,
      settled: false,
    });

    log.debug(`[Codex OAuth] Device flow started (flowId=${flowId})`);

    return Ok({ flowId, userCode, verifyUrl, intervalSeconds });
  }

  async waitForDeviceFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow) {
      return Err("OAuth flow not found");
    }

    if (!flow.pollingStarted) {
      flow.pollingStarted = true;
      this.pollDeviceFlow(flowId).catch((error) => {
        // The polling loop is responsible for resolving the flow; if we reach
        // here something unexpected happened.
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`[Codex OAuth] Device polling crashed (flowId=${flowId}): ${message}`);
        void this.finishDeviceFlow(flowId, Err(`Device polling crashed: ${message}`));
      });
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_DEVICE_TIMEOUT_MS;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for device authorization"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      // Ensure polling is cancelled on timeout/errors.
      void this.finishDeviceFlow(flowId, result);
    }

    return result;
  }

  async cancelDeviceFlow(flowId: string): Promise<void> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow) return;

    log.debug(`[Codex OAuth] Device flow cancelled (flowId=${flowId})`);
    await this.finishDeviceFlow(flowId, Err("OAuth flow cancelled"));
  }

  async getValidAuth(): Promise<Result<CodexOauthAuth, string>> {
    const stored = this.readStoredAuth();
    if (!stored) {
      return Err("Codex OAuth is not configured");
    }

    if (!isCodexOauthAuthExpired(stored)) {
      return Ok(stored);
    }

    await using _lock = await this.refreshMutex.acquire();

    // Re-read after acquiring lock in case another caller refreshed first.
    const latest = this.readStoredAuth();
    if (!latest) {
      return Err("Codex OAuth is not configured");
    }

    if (!isCodexOauthAuthExpired(latest)) {
      return Ok(latest);
    }

    const refreshed = await this.refreshTokens(latest);
    if (!refreshed.success) {
      return Err(refreshed.error);
    }

    return Ok(refreshed.data);
  }

  async dispose(): Promise<void> {
    const desktopIds = [...this.desktopFlows.keys()];
    await Promise.all(desktopIds.map((id) => this.finishDesktopFlow(id, Err("App shutting down"))));

    const deviceIds = [...this.deviceFlows.keys()];
    await Promise.all(deviceIds.map((id) => this.finishDeviceFlow(id, Err("App shutting down"))));

    for (const flow of this.desktopFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    for (const flow of this.deviceFlows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
    }

    this.desktopFlows.clear();
    this.deviceFlows.clear();
  }

  private readStoredAuth(): CodexOauthAuth | null {
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const openaiConfig = providersConfig.openai as Record<string, unknown> | undefined;
    return parseCodexOauthAuth(openaiConfig?.codexOauth);
  }

  private persistAuth(auth: CodexOauthAuth): Result<void, string> {
    return this.providerService.setConfigValue("openai", ["codexOauth"], auth);
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

    log.debug(`[Codex OAuth] Desktop callback received (flowId=${input.flowId})`);

    const result = await this.handleDesktopCallbackAndExchange({
      flowId: input.flowId,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier,
      code: input.code,
      error: input.error,
      errorDescription: input.errorDescription,
    });

    const title = result.success ? "Login complete" : "Login failed";
    const description = result.success
      ? "You can return to Mux. You may now close this tab."
      : escapeHtml(result.error);

    input.res.setHeader("Content-Type", "text/html");
    if (!result.success) {
      input.res.statusCode = 400;
    }

    input.res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${description}</p>
    <script>
      (() => {
        const ok = ${result.success ? "true" : "false"};
        if (!ok) return;
        try { window.close(); } catch {}
        setTimeout(() => { try { window.close(); } catch {} }, 50);
      })();
    </script>
  </body>
</html>`);

    await this.finishDesktopFlow(input.flowId, result);
  }

  private async handleDesktopCallbackAndExchange(input: {
    flowId: string;
    redirectUri: string;
    codeVerifier: string;
    code: string | null;
    error: string | null;
    errorDescription?: string;
  }): Promise<Result<void, string>> {
    if (input.error) {
      const message = input.errorDescription
        ? `${input.error}: ${input.errorDescription}`
        : input.error;
      return Err(`Codex OAuth error: ${message}`);
    }

    if (!input.code) {
      return Err("Missing OAuth code");
    }

    const tokenResult = await this.exchangeCodeForTokens({
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });
    if (!tokenResult.success) {
      return Err(tokenResult.error);
    }

    const persistResult = this.persistAuth(tokenResult.data);
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    log.debug(`[Codex OAuth] Desktop exchange completed (flowId=${input.flowId})`);

    this.windowService?.focusMainWindow();

    return Ok(undefined);
  }

  private async exchangeCodeForTokens(input: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<Result<CodexOauthAuth, string>> {
    try {
      const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildCodexTokenExchangeBody({
          code: input.code,
          redirectUri: input.redirectUri,
          codeVerifier: input.codeVerifier,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Codex OAuth exchange failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Codex OAuth exchange returned an invalid JSON payload");
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);
      const idToken = typeof json.id_token === "string" ? json.id_token : undefined;

      if (!accessToken) {
        return Err("Codex OAuth exchange response missing access_token");
      }

      if (!refreshToken) {
        return Err("Codex OAuth exchange response missing refresh_token");
      }

      if (expiresIn === null) {
        return Err("Codex OAuth exchange response missing expires_in");
      }

      const accountId = extractChatGptAccountIdFromTokens({ accessToken, idToken });
      if (!accountId) {
        return Err("Codex OAuth exchange response missing ChatGPT account id claim");
      }

      return Ok({
        access: accessToken,
        refresh: refreshToken,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
        accountId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Codex OAuth exchange failed: ${message}`);
    }
  }

  private async refreshTokens(current: CodexOauthAuth): Promise<Result<CodexOauthAuth, string>> {
    try {
      const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildCodexRefreshBody({ refreshToken: current.refresh }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Codex OAuth refresh failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Codex OAuth refresh returned an invalid JSON payload");
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);
      const idToken = typeof json.id_token === "string" ? json.id_token : undefined;

      if (!accessToken) {
        return Err("Codex OAuth refresh response missing access_token");
      }

      if (expiresIn === null) {
        return Err("Codex OAuth refresh response missing expires_in");
      }

      const accountId =
        extractChatGptAccountIdFromTokens({ accessToken, idToken }) ?? current.accountId;

      const next: CodexOauthAuth = {
        access: accessToken,
        refresh: refreshToken ?? current.refresh,
        expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
        accountId,
      };

      const persistResult = this.persistAuth(next);
      if (!persistResult.success) {
        return Err(persistResult.error);
      }

      return Ok(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Codex OAuth refresh failed: ${message}`);
    }
  }

  private async requestDeviceCode(): Promise<
    Result<
      {
        deviceCode: string;
        userCode: string;
        verifyUrl: string;
        intervalSeconds: number;
        expiresAtMs: number;
      },
      string
    >
  > {
    try {
      const response = await fetch(CODEX_OAUTH_DEVICE_CODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildCodexDeviceCodeBody(),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Codex OAuth device code request failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Codex OAuth device code response returned an invalid JSON payload");
      }

      const deviceCode = typeof json.device_code === "string" ? json.device_code : null;
      const userCode = typeof json.user_code === "string" ? json.user_code : null;
      const verificationUri =
        typeof json.verification_uri === "string" ? json.verification_uri : null;
      const verificationUriComplete =
        typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : null;
      const interval = parseOptionalNumber(json.interval);
      const expiresIn = parseOptionalNumber(json.expires_in);

      if (!deviceCode || !userCode || !verificationUri) {
        return Err("Codex OAuth device code response missing required fields");
      }

      if (expiresIn === null) {
        return Err("Codex OAuth device code response missing expires_in");
      }

      const intervalSeconds = interval !== null ? Math.max(1, Math.floor(interval)) : 5;

      return Ok({
        deviceCode,
        userCode,
        verifyUrl: verificationUriComplete ?? verificationUri,
        intervalSeconds,
        expiresAtMs: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Codex OAuth device code request failed: ${message}`);
    }
  }

  private async pollDeviceFlow(flowId: string): Promise<void> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow || flow.settled) {
      return;
    }

    let intervalSeconds = flow.intervalSeconds;

    while (Date.now() < flow.expiresAtMs) {
      if (flow.abortController.signal.aborted) {
        await this.finishDeviceFlow(flowId, Err("OAuth flow cancelled"));
        return;
      }

      const attempt = await this.pollDeviceTokenOnce(flow, intervalSeconds);
      if (attempt.kind === "success") {
        const persistResult = this.persistAuth(attempt.auth);
        if (!persistResult.success) {
          await this.finishDeviceFlow(flowId, Err(persistResult.error));
          return;
        }

        log.debug(`[Codex OAuth] Device authorization completed (flowId=${flowId})`);
        this.windowService?.focusMainWindow();
        await this.finishDeviceFlow(flowId, Ok(undefined));
        return;
      }

      if (attempt.kind === "fatal") {
        await this.finishDeviceFlow(flowId, Err(attempt.message));
        return;
      }

      if (attempt.kind === "slow_down") {
        intervalSeconds = attempt.intervalSeconds;
      }

      try {
        await sleepWithAbort(intervalSeconds * 1000, flow.abortController.signal);
      } catch {
        // Abort is handled via cancelDeviceFlow()/finishDeviceFlow().
        return;
      }
    }

    await this.finishDeviceFlow(flowId, Err("Device code expired"));
  }

  private async pollDeviceTokenOnce(
    flow: DeviceFlow,
    intervalSeconds: number
  ): Promise<
    | { kind: "success"; auth: CodexOauthAuth }
    | { kind: "pending" }
    | { kind: "slow_down"; intervalSeconds: number }
    | { kind: "fatal"; message: string }
  > {
    try {
      const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: buildCodexDeviceTokenBody({ deviceCode: flow.deviceCode }),
        signal: flow.abortController.signal,
      });

      const json = (await response.json().catch(() => null)) as unknown;

      if (response.ok) {
        if (!isPlainObject(json)) {
          return { kind: "fatal", message: "Codex OAuth device token returned invalid JSON" };
        }

        const accessToken = typeof json.access_token === "string" ? json.access_token : null;
        const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
        const expiresIn = parseOptionalNumber(json.expires_in);
        const idToken = typeof json.id_token === "string" ? json.id_token : undefined;

        if (!accessToken || !refreshToken || expiresIn === null) {
          return {
            kind: "fatal",
            message: "Codex OAuth device token response missing required fields",
          };
        }

        const accountId = extractChatGptAccountIdFromTokens({ accessToken, idToken });
        if (!accountId) {
          return { kind: "fatal", message: "Codex OAuth token missing ChatGPT account id claim" };
        }

        return {
          kind: "success",
          auth: {
            access: accessToken,
            refresh: refreshToken,
            expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
            accountId,
          },
        };
      }

      if (!isPlainObject(json)) {
        return {
          kind: "fatal",
          message: `Codex OAuth device token request failed (${response.status})`,
        };
      }

      const error = typeof json.error === "string" ? json.error : null;
      const errorDescription =
        typeof json.error_description === "string" ? json.error_description : null;

      if (error === "authorization_pending") {
        return { kind: "pending" };
      }

      if (error === "slow_down") {
        return { kind: "slow_down", intervalSeconds: intervalSeconds + 5 };
      }

      if (error === "expired_token") {
        return { kind: "fatal", message: "Device code expired" };
      }

      if (error === "access_denied") {
        return { kind: "fatal", message: "Device authorization denied" };
      }

      const message = errorDescription ? `${error ?? "error"}: ${errorDescription}` : error;
      return { kind: "fatal", message: message ?? "Device authorization failed" };
    } catch (error) {
      // Abort is treated as cancellation.
      if (flow.abortController.signal.aborted) {
        return { kind: "fatal", message: "OAuth flow cancelled" };
      }

      const message = error instanceof Error ? error.message : String(error);
      return { kind: "fatal", message: `Device authorization failed: ${message}` };
    }
  }

  private async finishDesktopFlow(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.desktopFlows.get(flowId);
    if (!flow || flow.settled) return;

    flow.settled = true;
    clearTimeout(flow.timeout);

    try {
      flow.resolveResult(result);
      await closeServer(flow.server);
    } catch (error) {
      log.debug("[Codex OAuth] Failed to close OAuth callback listener:", error);
    } finally {
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
      flow.cleanupTimeout = setTimeout(() => {
        this.desktopFlows.delete(flowId);
      }, COMPLETED_FLOW_TTL_MS);
    }
  }

  private finishDeviceFlow(flowId: string, result: Result<void, string>): Promise<void> {
    const flow = this.deviceFlows.get(flowId);
    if (!flow || flow.settled) {
      return Promise.resolve();
    }

    flow.settled = true;
    clearTimeout(flow.timeout);
    flow.abortController.abort();

    try {
      flow.resolveResult(result);
    } finally {
      if (flow.cleanupTimeout !== null) {
        clearTimeout(flow.cleanupTimeout);
      }
      flow.cleanupTimeout = setTimeout(() => {
        this.deviceFlows.delete(flowId);
      }, COMPLETED_FLOW_TTL_MS);
    }

    return Promise.resolve();
  }
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }

  if (signal.aborted) {
    throw new Error("aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort);
  });
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
