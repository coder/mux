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
import type { PolicyService } from "@/node/services/policyService";
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
    private readonly windowService?: WindowService,
    private readonly policyService?: PolicyService
  ) {}

  /**
   * An enforced policy forcedBaseUrl overrides every user-supplied or stored
   * deployment URL: logins, refreshes, and issuer checks must all target the
   * policy-locked deployment or Coder traffic could bypass it.
   */
  private effectiveDeploymentUrl(candidate: string | null): string | null {
    const forced = this.policyService?.isEnforced()
      ? this.policyService.getForcedBaseUrl("coder")
      : undefined;
    if (!forced) {
      return candidate;
    }
    return normalizeCoderDeploymentUrl(forced);
  }

  async disconnect(): Promise<Result<void, string>> {
    this.cachedAuth = null;
    const auth = this.readStoredAuth();

    // Clear FIRST, revoke after: disconnect must be authoritative over
    // concurrent refreshes, and awaiting (possibly slow) revocation first
    // would let a refresh rotate + persist in the meantime. The predicate
    // matches on the session lineage id — stable across rotations, re-minted
    // by each login — so it clears the disconnected session even if it just
    // rotated, while a genuinely newer login is preserved. Tokens and models
    // are cleared in ONE locked mutation so racing observers see either the
    // connected state or the fully disconnected state, never a mix.
    let removed: CoderOauthAuth | null = null;
    const clearResult = await this.providerService.updateProviderSection("coder", (section) => {
      const stored = parseCoderOauthAuth(section?.coderOauth);
      if (stored && (!auth || stored.sessionId !== auth.sessionId)) {
        return null; // A newer login landed since we captured `auth`; keep it.
      }
      // Capture the freshest rotation of the session so revocation below
      // targets a token that is actually still alive server-side.
      removed = stored;
      const next = { ...(section ?? {}) };
      delete next.coderOauth;
      // Models were fetched from the deployment's AI Bridge at login time; they
      // are meaningless without credentials and are refetched on the next login.
      next.models = [];
      return { value: next };
    });
    this.cachedAuth = null;
    if (!clearResult.success) {
      return Err(clearResult.error);
    }
    if (!clearResult.data.applied) {
      log.debug("[Coder OAuth] Disconnect raced a newer login; keeping the new credentials");
    }

    // Best-effort RFC 7009 revocation so the Coder-side API key is invalidated.
    // Revoke against the issuer stored in the blob (not the currently configured
    // deployment URL) so tokens are revoked on the deployment that minted them
    // even if the user changed the URL since logging in. Runs after the clear:
    // even if revocation fails or hangs, the account is already disconnected.
    const toRevoke = removed ?? auth;
    if (toRevoke) {
      await this.revokeTokens(toRevoke.deploymentUrl, toRevoke);
    }
    return Ok(undefined);
  }

  /**
   * Compare-and-clear the persisted OAuth blob: clears only while the stored
   * refresh token still matches `expected` (refresh tokens rotate on every
   * use, so they uniquely identify a credential generation). When `expected`
   * is null the clear is unconditional. Returns whether the clear applied.
   */
  private async clearStoredAuthIfMatches(
    expected: CoderOauthAuth | null
  ): Promise<Result<{ applied: boolean }, string>> {
    this.cachedAuth = null;
    const result = await this.providerService.updateConfigValue(
      "coder",
      ["coderOauth"],
      (current) => {
        if (expected) {
          const stored = parseCoderOauthAuth(current);
          if (stored && stored.refresh !== expected.refresh) {
            return null; // A different (newer) credential landed; keep it.
          }
        }
        return { value: undefined };
      }
    );
    // Drop the cache again after the write so readers re-read the final state.
    this.cachedAuth = null;
    return result;
  }

  async startDesktopFlow(input: {
    deploymentUrl: string;
  }): Promise<Result<{ flowId: string; authorizeUrl: string }, string>> {
    const requestedUrl = normalizeCoderDeploymentUrl(input.deploymentUrl);
    if (!requestedUrl) {
      return Err("Invalid Coder deployment URL (expected e.g. https://coder.example.com)");
    }

    // Policy override: login must target the policy-locked deployment so the
    // minted tokens are issuer-bound to it (getValidAuth enforces the match).
    const deploymentUrl = this.effectiveDeploymentUrl(requestedUrl);
    if (!deploymentUrl) {
      return Err("Policy-forced Coder base URL is not a valid deployment URL");
    }
    if (deploymentUrl !== requestedUrl) {
      log.debug(
        `[Coder OAuth] Deployment URL overridden by policy: ${requestedUrl} -> ${deploymentUrl}`
      );
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

    // The deployment URL is intentionally NOT persisted here: flow start races
    // other flows/logins, and an abandoned flow's early URL write could strand
    // a completed login with a mismatched issuer. The exchange commits the URL
    // atomically with the auth blob when this flow actually completes.
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
      // completion wins the flow; if Cancel won mid-persist, restore the
      // pre-login section (a previously connected account stays connected).
      if (!this.desktopFlows.has(flowId)) {
        await this.rollbackPersistedAuth(
          exchangeResult.data.auth,
          exchangeResult.data.previousSection
        );
        return;
      }

      loopback.sendSuccessResponse();
      this.windowService?.focusMainWindow();
      await this.desktopFlows.finish(flowId, Ok(undefined));

      // Model discovery runs only after the flow is committed: Cancel is no
      // longer possible, so this network await cannot strand half-cancelled
      // state (persisted auth with a cancelled flow).
      await this.refreshBridgeModels(exchangeResult.data.auth);
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
    const configured = typeof raw === "string" ? normalizeCoderDeploymentUrl(raw) : null;
    return this.effectiveDeploymentUrl(configured);
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
  }): Promise<Result<{ auth: CoderOauthAuth; previousSection: Record<string, unknown> }, string>> {
    const tokenResult = await this.requestTokens(input.endpoints.tokenEndpoint, {
      kind: "exchange",
      deploymentUrl: input.deploymentUrl,
      // Fresh session lineage: rotations preserve this id, a later login mints
      // a new one, letting disconnect tell rotations and re-logins apart.
      sessionId: randomBase64Url(16),
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

    // Persist the new credentials, the deployment URL they belong to, and a
    // cleared model catalog in ONE locked mutation:
    // - URL + auth together: a slower flow finishing after a login to another
    //   deployment must re-assert its own URL alongside its auth or it would
    //   store auth A next to URL B and fail issuer validation. Last completed
    //   login wins with a fully coherent section.
    // - models cleared: the flow resolves (and Settings refreshes) before
    //   discovery runs, so leaving the old deployment's models in place would
    //   offer them against the new deployment until — or indefinitely, if a
    //   catalog request stalls — discovery overwrites them.
    // The previous section is captured under the same lock so a post-persist
    // cancellation can restore it verbatim (not just delete the new blob,
    // which would log out a previously connected account).
    let previousSection: Record<string, unknown> = {};
    const persistResult = await this.providerService.updateProviderSection("coder", (section) => {
      // Cancellation can also win while this mutation waits for the
      // providers-file lock: re-check liveness at write time, inside the
      // lock, so a cancelled flow never replaces the prior login's state.
      if (!input.isFlowAlive()) {
        return null;
      }
      previousSection = { ...(section ?? {}) };
      const next = { ...(section ?? {}) };
      next.deploymentUrl = input.deploymentUrl;
      next.coderOauth = tokenResult.auth;
      next.models = [];
      return { value: next };
    });
    this.cachedAuth = null;
    if (!persistResult.success) {
      return Err(persistResult.error);
    }
    if (!persistResult.data.applied) {
      await this.revokeTokens(input.deploymentUrl, tokenResult.auth);
      return Err("Login was cancelled");
    }

    log.debug("[Coder OAuth] Desktop exchange completed");

    return Ok({ auth: tokenResult.auth, previousSection });
  }

  /**
   * Undo a persisted login whose flow was cancelled between the persist write
   * and the flow commit. Restores the section captured under the persist lock
   * (a previously connected account stays connected with its URL and catalog)
   * — but only while the stored credential is still the cancelled login's;
   * a newer login that landed in between is kept. The cancelled login's
   * tokens are revoked either way.
   */
  private async rollbackPersistedAuth(
    auth: CoderOauthAuth,
    previousSection: Record<string, unknown>
  ): Promise<void> {
    log.debug("[Coder OAuth] Flow cancelled during persist; restoring previous provider state");
    this.cachedAuth = null;
    const restoreResult = await this.providerService.updateProviderSection("coder", (section) => {
      const stored = parseCoderOauthAuth(section?.coderOauth);
      if (stored?.sessionId !== auth.sessionId) {
        return null; // Superseded by a newer login; keep it.
      }
      return { value: previousSection };
    });
    this.cachedAuth = null;
    if (!restoreResult.success) {
      log.warn(`[Coder OAuth] Failed to roll back cancelled login: ${restoreResult.error}`);
    } else if (!restoreResult.data.applied) {
      log.debug("[Coder OAuth] Rollback skipped: a newer login already replaced the credentials");
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
      // Rotations stay in the same login session (see CoderOauthAuth.sessionId).
      sessionId: current.sessionId,
      client: current,
      refreshToken: current.refresh,
    });

    if (!result.success) {
      // When the refresh token is invalid/revoked (rotation means a reused token
      // is dead), clear persisted auth so requests surface "reconnect" errors.
      if (result.invalidGrant) {
        // The refresh mutex is process-local: a concurrent desktop/CLI process
        // sharing providers.jsonc may have consumed this refresh token and
        // persisted the rotated one. Compare-and-clear: the stored blob is
        // deleted only while it still holds the rejected refresh token, so a
        // winner that persists concurrently is never erased (the predicate and
        // the write run in one synchronous block; see updateConfigValue).
        const clearResult = await this.clearStoredAuthIfMatches(current);
        if (!clearResult.success) {
          log.warn(
            `[Coder OAuth] Failed to clear stored auth after refresh failure: ${clearResult.error}`
          );
          return Err(
            "Coder OAuth session expired. Use 'Login with Coder' in Settings to reconnect."
          );
        }

        if (!clearResult.data.applied) {
          // A different credential is on disk: another process won the
          // rotation race. Adopt the winner instead of failing.
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
        }

        log.debug("[Coder OAuth] Refresh token rejected; cleared stored auth");
        return Err("Coder OAuth session expired. Use 'Login with Coder' in Settings to reconnect.");
      }

      return Err(result.error);
    }

    // Coder rotates the refresh token on every use: persist the new tokens
    // BEFORE handing them to the caller so a crash cannot strand us with a
    // consumed (now invalid) refresh token on disk. The write is conditional:
    // it lands only while the credential we consumed is still the stored one.
    // If a re-login (possibly to another deployment) or a disconnect finished
    // while the token endpoint round-trip was in flight, overwriting would
    // clobber the newer state with a blob from the old generation.
    const persistResult = await this.persistRotatedAuth(result.auth, current.refresh);
    if (!persistResult.success) {
      return Err(persistResult.error);
    }

    if (!persistResult.data.applied) {
      // Our rotation lost: revoke the now-orphaned tokens (nothing references
      // them) and defer to whatever credential replaced ours.
      await this.revokeTokens(result.auth.deploymentUrl, result.auth);
      const stored = this.readStoredAuth();
      if (stored) {
        log.debug("[Coder OAuth] Refresh superseded by a newer login; adopting it");
        if (!isCoderOauthAuthExpired(stored)) {
          return Ok(stored);
        }
        // Bounded: recursion only happens when the on-disk credential changed.
        return this.refreshTokens(stored);
      }
      return Err("Coder OAuth was disconnected. Use 'Login with Coder' in Settings to reconnect.");
    }

    return Ok(result.auth);
  }

  private async requestTokens(
    tokenEndpoint: string,
    input:
      | {
          kind: "exchange";
          deploymentUrl: string;
          sessionId: string;
          client: CoderOauthClient;
          code: string;
          redirectUri: string;
          codeVerifier: string;
        }
      | {
          kind: "refresh";
          deploymentUrl: string;
          sessionId: string;
          client: CoderOauthClient;
          refreshToken: string;
        }
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
          sessionId: input.sessionId,
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

    // Belt & suspenders: the factory enforces policy per model at creation
    // time, but don't persist catalog entries a policy already disallows.
    const allowedModelIds = this.policyService?.isEnforced()
      ? modelIds.filter((id) => this.policyService?.isModelAllowed("coder", id) ?? true)
      : modelIds;

    // Discovery races logins/disconnects: the flow resolves before this runs,
    // so a newer login (or a disconnect) may replace or clear the stored
    // credential while catalogs are fetched. The credential check and the
    // catalog write happen in ONE locked mutation, so only the login whose
    // tokens are still current can commit — a stale discovery can never
    // repopulate models over a disconnect or a newer deployment's catalog.
    // The catalog is always overwritten — including with an empty list — so a
    // re-login against a different deployment (whose catalogs may be empty or
    // unentitled) never keeps offering the previous deployment's models.
    const setResult = await this.providerService.updateProviderSection("coder", (section) => {
      const stored = parseCoderOauthAuth(section?.coderOauth);
      if (!stored || stored.access !== auth.access || stored.deploymentUrl !== auth.deploymentUrl) {
        return null;
      }
      return { value: { ...(section ?? {}), models: allowedModelIds } };
    });
    if (!setResult.success) {
      log.debug(`[Coder OAuth] Failed to persist bridge models: ${setResult.error}`);
    } else if (!setResult.data.applied) {
      log.debug("[Coder OAuth] Skipping stale model catalog write (login superseded)");
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

  /**
   * Compare-and-swap credential write (refreshes): persists `auth` only while
   * the stored blob still holds `expectedRefresh` — the token this refresh
   * consumed. Skipped means a newer login/disconnect superseded the refresh.
   */
  private async persistRotatedAuth(
    auth: CoderOauthAuth,
    expectedRefresh: string
  ): Promise<Result<{ applied: boolean }, string>> {
    const result = await this.providerService.updateConfigValue(
      "coder",
      ["coderOauth"],
      (current) => {
        const stored = parseCoderOauthAuth(current);
        if (stored?.refresh !== expectedRefresh) {
          return null;
        }
        return { value: auth };
      }
    );
    this.cachedAuth = null;
    return result;
  }
}
