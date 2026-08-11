import * as crypto from "crypto";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import {
  buildCoderAuthorizeUrl,
  buildCoderClientMetadata,
  buildCoderRefreshBody,
  buildCoderTokenExchangeBody,
  coderAibridgeBaseUrl,
  CODER_AIBRIDGE_ORIGINS,
  CODER_BUILDINFO_PATH,
  CODER_OAUTH_CALLBACK_PATH,
  CODER_OAUTH_DISCOVERY_PATH,
  normalizeCoderDeploymentUrl,
} from "@/common/constants/coderOAuth";
import type { Config } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import {
  isCoderOauthAuthExpired,
  parseCoderOauthAuth,
  type CoderOauthAuth,
} from "@/node/utils/coderOauthAuth";
import { createDeferred } from "@/node/utils/oauthUtils";
import { startLoopbackServer } from "@/node/utils/oauthLoopbackServer";
import { OAuthFlowManager } from "@/node/utils/oauthFlowManager";
import { getErrorMessage } from "@/common/utils/errors";

const DEFAULT_DESKTOP_TIMEOUT_MS = 5 * 60 * 1000;

/** RFC 8414 endpoints resolved from the deployment's discovery document. */
interface CoderOauthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
}

/** Dynamically registered OAuth client (RFC 7591/7592). */
interface CoderOauthClient {
  clientId: string;
  clientSecret: string;
  registrationAccessToken?: string;
  registrationClientUri?: string;
}

/** Token endpoint result; invalidGrant distinguishes dead refresh tokens from transient errors. */
type CoderTokenRequestResult =
  | { success: true; auth: CoderOauthAuth }
  | { success: false; error: string; invalidGrant: boolean };

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
  if (trimmed.length === 0) {
    return false;
  }

  try {
    const json = JSON.parse(trimmed) as unknown;
    if (isPlainObject(json) && json.error === "invalid_grant") {
      return true;
    }
  } catch {
    // Ignore parse failures - fall back to substring checks.
  }

  return trimmed.toLowerCase().includes("invalid_grant");
}

/** Discovery endpoint URLs must parse and use http(s). */
function parseEndpointUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export class CoderOauthService {
  private readonly desktopFlows = new OAuthFlowManager();
  private readonly refreshMutex = new AsyncMutex();

  // In-memory cache so getValidAuth() skips disk reads when tokens are valid.
  // Invalidated on every write (exchange, refresh, disconnect).
  private cachedAuth: CoderOauthAuth | null = null;

  constructor(
    private readonly config: Config,
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async disconnect(): Promise<Result<void, string>> {
    const auth = this.readStoredAuth();

    // Best-effort RFC 7009 revocation so the Coder-side API key is invalidated.
    // Revoke against the issuer stored in the blob (not the currently configured
    // deployment URL) so tokens are revoked on the deployment that minted them
    // even if the user changed the URL since logging in.
    if (auth) {
      await this.revokeTokens(auth.deploymentUrl, auth);
    }

    // Revocation may be slow, and the UI keeps login available while it runs:
    // a re-login can complete in the meantime. Only clear when the stored
    // credential is still the one this disconnect captured.
    this.cachedAuth = null;
    const current = this.readStoredAuth();
    if (auth && current && current.refresh !== auth.refresh) {
      log.debug("[Coder OAuth] Disconnect raced a newer login; keeping the new credentials");
      return Ok(undefined);
    }

    this.cachedAuth = null;
    const clearAuthResult = await this.providerService.setConfigValue(
      "coder",
      ["coderOauth"],
      undefined
    );
    if (!clearAuthResult.success) {
      return clearAuthResult;
    }

    // Models were fetched from the deployment's AI Bridge at login time; they
    // are meaningless without credentials and are refetched on the next login.
    return this.providerService.setModels("coder", []);
  }

  async startDesktopFlow(input: {
    deploymentUrl: string;
  }): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
    const deploymentUrl = normalizeCoderDeploymentUrl(input.deploymentUrl);
    if (!deploymentUrl) {
      return Err("Invalid Coder deployment URL (expected e.g. https://coder.example.com)");
    }

    const buildinfoResult = await this.validateDeployment(deploymentUrl);
    if (!buildinfoResult.success) {
      return Err(buildinfoResult.error);
    }

    const endpointsResult = await this.discoverEndpoints(deploymentUrl);
    if (!endpointsResult.success) {
      return Err(endpointsResult.error);
    }
    const endpoints = endpointsResult.data;

    // Persist the (normalized) deployment URL so the model factory and future
    // logins agree on the deployment this provider points at.
    const persistUrlResult = await this.providerService.setConfigValue(
      "coder",
      ["deploymentUrl"],
      deploymentUrl
    );
    if (!persistUrlResult.success) {
      return Err(persistUrlResult.error);
    }

    const flowId = randomBase64Url();
    const codeVerifier = randomBase64Url();
    const codeChallenge = sha256Base64Url(codeVerifier);

    // Ephemeral port: Coder requires exact redirect URI matching (OAuth 2.1),
    // so the freshly bound URI is (re-)registered on the client below.
    let loopback: Awaited<ReturnType<typeof startLoopbackServer>>;
    try {
      loopback = await startLoopbackServer({
        port: 0,
        host: "127.0.0.1",
        callbackPath: CODER_OAUTH_CALLBACK_PATH,
        validateLoopback: true,
        expectedState: flowId,
        deferSuccessResponse: true,
      });
    } catch (error) {
      return Err(`Failed to start OAuth callback listener: ${getErrorMessage(error)}`);
    }

    const clientResult = await this.ensureClient(deploymentUrl, endpoints, loopback.redirectUri);
    if (!clientResult.success) {
      await loopback.close();
      return Err(clientResult.error);
    }
    const client = clientResult.data;

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

    const authorizeUrl = buildCoderAuthorizeUrl({
      authorizationEndpoint: endpoints.authorizationEndpoint,
      clientId: client.clientId,
      redirectUri: loopback.redirectUri,
      state: flowId,
      codeChallenge,
    });

    // Background task: wait for the loopback callback, exchange code for tokens,
    // then finish the flow. Races against resultDeferred (which resolves on
    // cancel/timeout) so the task exits cleanly if the flow is cancelled.
    void (async () => {
      const callbackResult = await Promise.race([
        loopback.result,
        resultDeferred.promise.then(() => null),
      ]);

      // null means the flow was finished externally (cancel/timeout).
      if (!callbackResult) return;

      if (!callbackResult.success) {
        await this.desktopFlows.finish(flowId, Err(callbackResult.error));
        return;
      }

      const exchangeResult = await this.exchangeAndPersist({
        deploymentUrl,
        endpoints,
        client,
        code: callbackResult.data.code,
        redirectUri: loopback.redirectUri,
        codeVerifier,
        // Cancel/timeout can race the exchange round-trip; "Cancel" must stay
        // authoritative, so the exchange re-checks liveness before persisting.
        isFlowAlive: () => this.desktopFlows.has(flowId),
      });

      if (!exchangeResult.success) {
        loopback.sendFailureResponse(exchangeResult.error);
        await this.desktopFlows.finish(flowId, Err(exchangeResult.error));
        return;
      }

      // Cancellation may also race the persist write itself. `has` + `finish`
      // below run with no intervening await, so exactly one of Cancel and
      // completion wins the flow; if Cancel won mid-persist, roll back.
      if (!this.desktopFlows.has(flowId)) {
        await this.rollbackPersistedAuth(exchangeResult.data);
        return;
      }

      loopback.sendSuccessResponse();
      this.windowService?.focusMainWindow();
      await this.desktopFlows.finish(flowId, Ok(undefined));

      // Model discovery runs only after the flow is committed: Cancel is no
      // longer possible, so this network await cannot strand half-cancelled
      // state (persisted auth with a cancelled flow).
      await this.refreshBridgeModels(exchangeResult.data);
    })();

    log.debug(`[Coder OAuth] Desktop flow started (flowId=${flowId})`);

    return Ok({ flowId, authorizeUrl });
  }

  async waitForDesktopFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    return this.desktopFlows.waitFor(flowId, opts?.timeoutMs ?? DEFAULT_DESKTOP_TIMEOUT_MS);
  }

  async cancelDesktopFlow(flowId: string): Promise<void> {
    if (this.desktopFlows.has(flowId)) {
      log.debug(`[Coder OAuth] Desktop flow cancelled (flowId=${flowId})`);
    }
    await this.desktopFlows.cancel(flowId);
  }

  /**
   * Return a valid (non-expired) auth blob, refreshing when necessary.
   *
   * Coder rotates refresh tokens on every use, so refreshes are serialized via
   * a mutex and the rotated tokens are persisted before this resolves.
   */
  async getValidAuth(): Promise<Result<CoderOauthAuth, string>> {
    const stored = this.readStoredAuth();
    if (!stored) {
      return Err("Coder OAuth is not configured. Use 'Login with Coder' in Settings.");
    }

    // Tokens are bound to the deployment (issuer) that minted them: never hand
    // out a bearer token when the configured deployment URL has changed since
    // login, or the old deployment's API key would be sent to the new host.
    const deploymentUrl = this.getDeploymentUrl();
    if (!deploymentUrl || stored.deploymentUrl !== deploymentUrl) {
      return Err(
        "Coder deployment URL changed since login. Use 'Login with Coder' in Settings to reconnect."
      );
    }

    if (!isCoderOauthAuthExpired(stored)) {
      return Ok(stored);
    }

    await using _lock = await this.refreshMutex.acquire();

    // Re-read after acquiring lock in case another caller refreshed first.
    // Drop the in-memory cache: the mutex is process-local, and a concurrent
    // desktop/CLI process sharing providers.jsonc may have rotated the tokens
    // on disk while we waited.
    this.cachedAuth = null;
    const latest = this.readStoredAuth();
    if (!latest) {
      return Err("Coder OAuth is not configured. Use 'Login with Coder' in Settings.");
    }

    if (!isCoderOauthAuthExpired(latest)) {
      return Ok(latest);
    }

    // Await inside the mutex scope: a bare `return promise` would dispose the
    // lock before the refresh finishes, letting concurrent callers refresh too.
    const refreshed = await this.refreshTokens(latest);
    if (!refreshed.success) {
      return Err(refreshed.error);
    }

    return Ok(refreshed.data);
  }

  getDeploymentUrl(): string | null {
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const coderConfig = providersConfig.coder as Record<string, unknown> | undefined;
    const raw = coderConfig?.deploymentUrl;
    return typeof raw === "string" ? normalizeCoderDeploymentUrl(raw) : null;
  }

  async dispose(): Promise<void> {
    await this.desktopFlows.shutdownAll();
  }

  // -------------------------------------------------------------------------
  // Deployment validation + discovery
  // -------------------------------------------------------------------------

  private async validateDeployment(deploymentUrl: string): Promise<Result<void, string>> {
    try {
      const response = await fetch(`${deploymentUrl}${CODER_BUILDINFO_PATH}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return Err(
          `Could not reach Coder deployment at ${deploymentUrl} (buildinfo returned ${response.status})`
        );
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json) || typeof json.version !== "string") {
        return Err(`${deploymentUrl} does not look like a Coder deployment (invalid buildinfo)`);
      }

      return Ok(undefined);
    } catch (error) {
      return Err(`Could not reach Coder deployment: ${getErrorMessage(error)}`);
    }
  }

  private async discoverEndpoints(
    deploymentUrl: string
  ): Promise<Result<CoderOauthEndpoints, string>> {
    try {
      const response = await fetch(`${deploymentUrl}${CODER_OAUTH_DISCOVERY_PATH}`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        return Err(
          `OAuth discovery failed (${response.status}). Ensure the deployment runs with --experiments=oauth2.`
        );
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("OAuth discovery returned an invalid JSON payload");
      }

      const authorizationEndpoint = parseEndpointUrl(json.authorization_endpoint);
      const tokenEndpoint = parseEndpointUrl(json.token_endpoint);
      const registrationEndpoint = parseEndpointUrl(json.registration_endpoint);
      const revocationEndpoint = parseEndpointUrl(json.revocation_endpoint) ?? undefined;

      if (!authorizationEndpoint || !tokenEndpoint || !registrationEndpoint) {
        return Err("OAuth discovery response is missing required endpoints");
      }

      // Coder only supports S256; fail fast if a future deployment drops it.
      const methods = json.code_challenge_methods_supported;
      if (Array.isArray(methods) && !methods.includes("S256")) {
        return Err("Coder deployment does not support PKCE S256");
      }

      return Ok({ authorizationEndpoint, tokenEndpoint, registrationEndpoint, revocationEndpoint });
    } catch (error) {
      return Err(`OAuth discovery failed: ${getErrorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic client registration (RFC 7591) + redirect URI updates (RFC 7592)
  // -------------------------------------------------------------------------

  /**
   * Reuse the stored client when possible by pointing its registered redirect
   * URI at the current loopback port; otherwise register a fresh client.
   */
  private async ensureClient(
    deploymentUrl: string,
    endpoints: CoderOauthEndpoints,
    redirectUri: string
  ): Promise<Result<CoderOauthClient, string>> {
    const stored = this.readStoredAuth();
    // Only reuse a client registered on the SAME deployment; a client from a
    // different deployment is meaningless there (and its RFC 7592 endpoint
    // would point at the old host).
    if (
      stored?.deploymentUrl === deploymentUrl &&
      stored.registrationAccessToken &&
      stored.registrationClientUri
    ) {
      const updated = await this.updateClientRedirectUri(stored, redirectUri);
      if (updated.success) {
        return updated;
      }
      // Stored client may have been deleted server-side; fall through to re-register.
      log.debug(`[Coder OAuth] Client update failed, re-registering: ${updated.error}`);
    }

    return this.registerClient(endpoints.registrationEndpoint, redirectUri);
  }

  private async registerClient(
    registrationEndpoint: string,
    redirectUri: string
  ): Promise<Result<CoderOauthClient, string>> {
    try {
      const response = await fetch(registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildCoderClientMetadata(redirectUri)),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Coder OAuth client registration failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return Err("Coder OAuth client registration returned an invalid JSON payload");
      }

      const clientId = typeof json.client_id === "string" ? json.client_id : null;
      // Coder always issues a client secret (all clients are treated as
      // confidential) and requires it at the token endpoint.
      const clientSecret = typeof json.client_secret === "string" ? json.client_secret : null;

      if (!clientId || !clientSecret) {
        return Err("Coder OAuth client registration response missing client credentials");
      }

      const registrationAccessToken =
        typeof json.registration_access_token === "string" && json.registration_access_token
          ? json.registration_access_token
          : undefined;
      const registrationClientUri =
        typeof json.registration_client_uri === "string" && json.registration_client_uri
          ? json.registration_client_uri
          : undefined;

      return Ok({ clientId, clientSecret, registrationAccessToken, registrationClientUri });
    } catch (error) {
      return Err(`Coder OAuth client registration failed: ${getErrorMessage(error)}`);
    }
  }

  private async updateClientRedirectUri(
    stored: CoderOauthAuth,
    redirectUri: string
  ): Promise<Result<CoderOauthClient, string>> {
    if (!stored.registrationAccessToken || !stored.registrationClientUri) {
      return Err("No registration access token stored");
    }

    try {
      // RFC 7592 requires the full metadata set on update, not a partial patch.
      const response = await fetch(stored.registrationClientUri, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${stored.registrationAccessToken}`,
        },
        body: JSON.stringify({
          ...buildCoderClientMetadata(redirectUri),
          client_id: stored.clientId,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Coder OAuth client update failed (${response.status})`;
        return Err(errorText ? `${prefix}: ${errorText}` : prefix);
      }

      // Coder keeps the existing client secret and registration token on update.
      return Ok({
        clientId: stored.clientId,
        clientSecret: stored.clientSecret,
        registrationAccessToken: stored.registrationAccessToken,
        registrationClientUri: stored.registrationClientUri,
      });
    } catch (error) {
      return Err(`Coder OAuth client update failed: ${getErrorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Token exchange + refresh
  // -------------------------------------------------------------------------

  private async exchangeAndPersist(input: {
    deploymentUrl: string;
    endpoints: CoderOauthEndpoints;
    client: CoderOauthClient;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    isFlowAlive: () => boolean;
  }): Promise<Result<CoderOauthAuth, string>> {
    const tokenResult = await this.requestTokens(input.endpoints.tokenEndpoint, {
      kind: "exchange",
      deploymentUrl: input.deploymentUrl,
      client: input.client,
      code: input.code,
      redirectUri: input.redirectUri,
      codeVerifier: input.codeVerifier,
    });
    if (!tokenResult.success) {
      return Err(tokenResult.error);
    }

    // The flow may have been cancelled (or timed out) while the exchange
    // round-trip was in flight. Persisting anyway would leave the account
    // connected after the user clicked Cancel — drop and revoke the tokens.
    if (!input.isFlowAlive()) {
      await this.revokeTokens(input.deploymentUrl, tokenResult.auth);
      return Err("Login was cancelled");
    }

    const persistResult = await this.persistAuth(tokenResult.auth);
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    log.debug("[Coder OAuth] Desktop exchange completed");

    return Ok(tokenResult.auth);
  }

  /** Undo a persisted login whose flow was cancelled mid-persist. */
  private async rollbackPersistedAuth(auth: CoderOauthAuth): Promise<void> {
    log.debug("[Coder OAuth] Flow cancelled during persist; rolling back credentials");
    this.cachedAuth = null;
    const clearResult = await this.providerService.setConfigValue(
      "coder",
      ["coderOauth"],
      undefined
    );
    if (!clearResult.success) {
      log.warn(`[Coder OAuth] Failed to roll back cancelled login: ${clearResult.error}`);
    }
    await this.revokeTokens(auth.deploymentUrl, auth);
  }

  private async refreshTokens(current: CoderOauthAuth): Promise<Result<CoderOauthAuth, string>> {
    // Refresh against the issuer the tokens came from (getValidAuth already
    // guarantees it matches the configured deployment URL). Endpoints derive
    // from the access URL; skip a discovery round-trip on the hot request path.
    const tokenEndpoint = `${current.deploymentUrl}/oauth2/tokens`;
    const result = await this.requestTokens(tokenEndpoint, {
      kind: "refresh",
      deploymentUrl: current.deploymentUrl,
      client: current,
      refreshToken: current.refresh,
    });

    if (!result.success) {
      // When the refresh token is invalid/revoked (rotation means a reused token
      // is dead), clear persisted auth so requests surface "reconnect" errors.
      if (result.invalidGrant) {
        // The refresh mutex is process-local: a concurrent desktop/CLI process
        // sharing providers.jsonc may have consumed this refresh token and
        // persisted the rotated one. Re-read disk and only clear when the
        // rejected token is still the stored one — otherwise adopt the
        // winner's credential instead of erasing it.
        this.cachedAuth = null;
        const stored = this.readStoredAuth();
        if (stored && stored.refresh !== current.refresh) {
          log.debug("[Coder OAuth] Refresh lost a cross-process rotation race; adopting winner");
          if (!isCoderOauthAuthExpired(stored)) {
            return Ok(stored);
          }
          // Recursion is bounded: it only recurses when the on-disk token
          // changed again since the last attempt.
          return this.refreshTokens(stored);
        }

        log.debug("[Coder OAuth] Refresh token rejected; clearing stored auth");
        this.cachedAuth = null;
        const clearResult = await this.providerService.setConfigValue(
          "coder",
          ["coderOauth"],
          undefined
        );
        if (!clearResult.success) {
          log.warn(
            `[Coder OAuth] Failed to clear stored auth after refresh failure: ${clearResult.error}`
          );
        }
        return Err("Coder OAuth session expired. Use 'Login with Coder' in Settings to reconnect.");
      }

      return Err(result.error);
    }

    // Coder rotates the refresh token on every use: persist the new tokens
    // BEFORE handing them to the caller so a crash cannot strand us with a
    // consumed (now invalid) refresh token on disk.
    const persistResult = await this.persistAuth(result.auth);
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    return Ok(result.auth);
  }

  private async requestTokens(
    tokenEndpoint: string,
    input:
      | {
          kind: "exchange";
          deploymentUrl: string;
          client: CoderOauthClient;
          code: string;
          redirectUri: string;
          codeVerifier: string;
        }
      | { kind: "refresh"; deploymentUrl: string; client: CoderOauthClient; refreshToken: string }
  ): Promise<CoderTokenRequestResult> {
    const label = input.kind === "exchange" ? "exchange" : "refresh";

    try {
      const body =
        input.kind === "exchange"
          ? buildCoderTokenExchangeBody({
              clientId: input.client.clientId,
              clientSecret: input.client.clientSecret,
              code: input.code,
              redirectUri: input.redirectUri,
              codeVerifier: input.codeVerifier,
            })
          : buildCoderRefreshBody({
              clientId: input.client.clientId,
              clientSecret: input.client.clientSecret,
              refreshToken: input.refreshToken,
            });

      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const prefix = `Coder OAuth ${label} failed (${response.status})`;
        return {
          success: false,
          error: errorText ? `${prefix}: ${errorText}` : prefix,
          invalidGrant: isInvalidGrantError(errorText),
        };
      }

      const json = (await response.json()) as unknown;
      if (!isPlainObject(json)) {
        return {
          success: false,
          error: `Coder OAuth ${label} returned an invalid JSON payload`,
          invalidGrant: false,
        };
      }

      const accessToken = typeof json.access_token === "string" ? json.access_token : null;
      const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token : null;
      const expiresIn = parseOptionalNumber(json.expires_in);

      if (!accessToken || !refreshToken || expiresIn === null) {
        return {
          success: false,
          error: `Coder OAuth ${label} response missing access_token/refresh_token/expires_in`,
          invalidGrant: false,
        };
      }

      return {
        success: true,
        auth: {
          type: "oauth",
          deploymentUrl: input.deploymentUrl,
          access: accessToken,
          refresh: refreshToken,
          expires: Date.now() + Math.max(0, Math.floor(expiresIn * 1000)),
          clientId: input.client.clientId,
          clientSecret: input.client.clientSecret,
          registrationAccessToken: input.client.registrationAccessToken,
          registrationClientUri: input.client.registrationClientUri,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Coder OAuth ${label} failed: ${getErrorMessage(error)}`,
        invalidGrant: false,
      };
    }
  }

  /** Best-effort RFC 7009 revocation; failures are logged, never surfaced. */
  private async revokeTokens(
    deploymentUrl: string,
    auth: Pick<CoderOauthAuth, "refresh" | "clientId" | "clientSecret">
  ): Promise<void> {
    try {
      const body = new URLSearchParams();
      body.set("token", auth.refresh);
      body.set("client_id", auth.clientId);
      body.set("client_secret", auth.clientSecret);
      await fetch(`${deploymentUrl}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (error) {
      log.debug(`[Coder OAuth] Best-effort token revocation failed: ${getErrorMessage(error)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Model list refresh (AI Bridge passthrough catalogs)
  // -------------------------------------------------------------------------

  private async refreshBridgeModels(auth: CoderOauthAuth): Promise<void> {
    const modelIds: string[] = [];

    for (const origin of CODER_AIBRIDGE_ORIGINS) {
      try {
        const response = await fetch(`${coderAibridgeBaseUrl(auth.deploymentUrl, origin)}/models`, {
          headers: {
            Authorization: `Bearer ${auth.access}`,
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          log.debug(`[Coder OAuth] ${origin} model list unavailable (${response.status})`);
          continue;
        }

        const json = (await response.json()) as unknown;
        const entries = isPlainObject(json) && Array.isArray(json.data) ? json.data : [];
        for (const entry of entries) {
          if (isPlainObject(entry) && typeof entry.id === "string" && entry.id) {
            modelIds.push(`${origin}/${entry.id}`);
          }
        }
      } catch (error) {
        log.debug(`[Coder OAuth] Failed to fetch ${origin} models: ${getErrorMessage(error)}`);
      }
    }

    // Discovery races logins/disconnects: the flow resolves before this runs,
    // so a newer login (or a disconnect) may have replaced or cleared the
    // stored credential while catalogs were fetched. Only the login whose
    // tokens are still current may commit the catalog.
    this.cachedAuth = null;
    const current = this.readStoredAuth();
    if (
      !current ||
      current.access !== auth.access ||
      current.deploymentUrl !== auth.deploymentUrl
    ) {
      log.debug("[Coder OAuth] Skipping stale model catalog write (login superseded)");
      return;
    }

    // Always overwrite the persisted catalog — including with an empty list —
    // so a re-login against a different deployment (whose catalogs may be
    // empty or unentitled) never keeps offering the previous deployment's models.
    const setResult = this.providerService.setModels("coder", modelIds);
    if (!setResult.success) {
      log.debug(`[Coder OAuth] Failed to persist bridge models: ${setResult.error}`);
    }
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private readStoredAuth(): CoderOauthAuth | null {
    if (this.cachedAuth) {
      return this.cachedAuth;
    }
    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const coderConfig = providersConfig.coder as Record<string, unknown> | undefined;
    const auth = parseCoderOauthAuth(coderConfig?.coderOauth);
    this.cachedAuth = auth;
    return auth;
  }

  private async persistAuth(auth: CoderOauthAuth): Promise<Result<void, string>> {
    const result = await this.providerService.setConfigValue("coder", ["coderOauth"], auth);
    // Invalidate cache so the next readStoredAuth() picks up the persisted value from disk.
    // We clear rather than set because setConfigValue may have side-effects (e.g. file-write
    // failures) and we want the next read to be authoritative.
    this.cachedAuth = null;
    return result;
  }
}
