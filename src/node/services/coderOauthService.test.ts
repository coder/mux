import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as crypto from "crypto";

import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import type { Config, ProvidersConfig } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import type { ProviderModelEntry } from "@/common/config/schemas/providerModelEntry";
import type { CoderOauthAuth } from "@/node/utils/coderOauthAuth";
import { CoderOauthService } from "./coderOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEPLOYMENT_URL = "http://coder.test";

/** Build a valid CoderOauthAuth that expires far in the future. */
function validAuth(overrides?: Partial<CoderOauthAuth>): CoderOauthAuth {
  return {
    type: "oauth",
    deploymentUrl: DEPLOYMENT_URL,
    access: "at_test",
    refresh: "rt_test",
    expires: Date.now() + 3_600_000, // 1h from now
    clientId: "client_test",
    clientSecret: "secret_test",
    registrationAccessToken: "reg_token_test",
    registrationClientUri: `${DEPLOYMENT_URL}/oauth2/clients/client_test`,
    ...overrides,
  };
}

/** Build a CoderOauthAuth that is already expired. */
function expiredAuth(overrides?: Partial<CoderOauthAuth>): CoderOauthAuth {
  return validAuth({ expires: Date.now() - 60_000, ...overrides });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function discoveryResponse(): Response {
  return jsonResponse({
    issuer: DEPLOYMENT_URL,
    authorization_endpoint: `${DEPLOYMENT_URL}/oauth2/authorize`,
    token_endpoint: `${DEPLOYMENT_URL}/oauth2/tokens`,
    registration_endpoint: `${DEPLOYMENT_URL}/oauth2/register`,
    revocation_endpoint: `${DEPLOYMENT_URL}/oauth2/revoke`,
    code_challenge_methods_supported: ["S256"],
  });
}

function sha256Base64Url(value: string): string {
  return crypto.createHash("sha256").update(value).digest().toString("base64url");
}

/** Stringify a fetch input without tripping no-base-to-string on Request objects. */
function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** Extract a string/URLSearchParams request body for assertions. */
function fetchBodyText(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error(`Unexpected request body type: ${typeof body}`);
}

/** Poll until `predicate` holds; model discovery runs after the flow resolves. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

interface MockDeps {
  providersConfig: ProvidersConfig;
  setConfigValueCalls: Array<{ provider: string; keyPath: string[]; value: unknown }>;
  setModelsCalls: Array<{ provider: string; models: ProviderModelEntry[] }>;
  focusCalls: number;
}

function createMockDeps(): MockDeps {
  return {
    providersConfig: {},
    setConfigValueCalls: [],
    setModelsCalls: [],
    focusCalls: 0,
  };
}

function createMockConfig(deps: MockDeps): Pick<Config, "loadProvidersConfig"> {
  return {
    loadProvidersConfig: () => deps.providersConfig,
  };
}

function createMockProviderService(
  deps: MockDeps
): Pick<ProviderService, "setConfigValue" | "setModels"> {
  return {
    setConfigValue: (
      provider: string,
      keyPath: string[],
      value: unknown
    ): Promise<Result<void, string>> => {
      deps.setConfigValueCalls.push({ provider, keyPath, value });
      // Also update the in-memory config so readStoredAuth()/getDeploymentUrl() see the write
      if (provider === "coder" && keyPath.length === 1) {
        deps.providersConfig.coder ??= {};
        if (value === undefined) {
          delete (deps.providersConfig.coder as Record<string, unknown>)[keyPath[0]];
        } else {
          (deps.providersConfig.coder as Record<string, unknown>)[keyPath[0]] = value;
        }
      }
      return Promise.resolve(Ok(undefined));
    },
    setModels: (provider: string, models: ProviderModelEntry[]): Result<void, string> => {
      deps.setModelsCalls.push({ provider, models });
      return Ok(undefined);
    },
  };
}

function createMockWindowService(deps: MockDeps): Pick<WindowService, "focusMainWindow"> {
  return {
    focusMainWindow: () => {
      deps.focusCalls++;
    },
  };
}

function createService(deps: MockDeps): CoderOauthService {
  return new CoderOauthService(
    createMockConfig(deps) as Config,
    createMockProviderService(deps) as ProviderService,
    createMockWindowService(deps) as WindowService
  );
}

// Helper to mock globalThis.fetch without needing the `preconnect` property.
function mockFetch(fn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: (_url: string | URL) => {
      // no-op in tests
    },
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CoderOauthService", () => {
  let deps: MockDeps;
  let service: CoderOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = createMockDeps();
    service = createService(deps);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await service.dispose();
  });

  // -------------------------------------------------------------------------
  // getValidAuth
  // -------------------------------------------------------------------------

  describe("getValidAuth", () => {
    it("returns error when no auth is stored", async () => {
      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not configured");
      }
    });

    it("returns stored auth when token is not expired", async () => {
      const auth = validAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: auth } };

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe(auth.access);
      }
    });

    it("refreshes an expired token and persists the rotated refresh token before resolving", async () => {
      const expired = expiredAuth({ refresh: "rt_old" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      let refreshBody: URLSearchParams | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        expect(url).toBe(`${DEPLOYMENT_URL}/oauth2/tokens`);
        refreshBody = new URLSearchParams(fetchBodyText(init));
        return Promise.resolve(
          jsonResponse({
            access_token: "at_new",
            refresh_token: "rt_rotated",
            expires_in: 3600,
            token_type: "Bearer",
          })
        );
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe("at_new");
        expect(result.data.refresh).toBe("rt_rotated");
        // Client credentials carry over across refreshes.
        expect(result.data.clientId).toBe("client_test");
        expect(result.data.clientSecret).toBe("secret_test");
      }

      // Refresh request used the stored client + old refresh token.
      expect(refreshBody).not.toBeNull();
      expect(refreshBody!.get("grant_type")).toBe("refresh_token");
      expect(refreshBody!.get("client_id")).toBe("client_test");
      expect(refreshBody!.get("client_secret")).toBe("secret_test");
      expect(refreshBody!.get("refresh_token")).toBe("rt_old");

      // Coder rotates refresh tokens: the rotated token must be persisted by
      // the time getValidAuth resolves (persist-before-use).
      const persisted = deps.setConfigValueCalls.find(
        (c) => c.provider === "coder" && c.keyPath[0] === "coderOauth" && c.value !== undefined
      );
      expect(persisted).toBeDefined();
      expect((persisted!.value as CoderOauthAuth).refresh).toBe("rt_rotated");
    });

    it("only triggers one refresh for concurrent getValidAuth calls with expired tokens", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      let fetchCallCount = 0;
      mockFetch(async () => {
        fetchCallCount++;
        // Simulate a small delay so all callers are waiting
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({
          access_token: "at_new",
          refresh_token: "rt_rotated",
          expires_in: 3600,
        });
      });

      const results = await Promise.all([
        service.getValidAuth(),
        service.getValidAuth(),
        service.getValidAuth(),
      ]);

      expect(fetchCallCount).toBe(1);
      for (const result of results) {
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.access).toBe("at_new");
        }
      }
    });

    it("clears stored auth on invalid_grant refresh response", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      mockFetch(() => Promise.resolve(jsonResponse({ error: "invalid_grant" }, 400)));

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Login with Coder");
      }

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "coder" && c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();

      // Subsequent calls see no stored auth.
      const second = await service.getValidAuth();
      expect(second.success).toBe(false);
      if (!second.success) {
        expect(second.error).toContain("not configured");
      }
    });

    it("keeps stored auth on transient refresh errors", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      mockFetch(() => Promise.resolve(new Response("upstream unavailable", { status: 502 })));

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "coder" && c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(clearCall).toBeUndefined();
    });

    it("fails when deployment URL is missing for refresh", async () => {
      const expired = expiredAuth();
      deps.providersConfig = { coder: { coderOauth: expired } };

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("deployment URL");
      }
    });

    it("adopts a concurrently rotated credential instead of clearing it on invalid_grant", async () => {
      // The refresh mutex is process-local: another process (desktop vs CLI)
      // can consume our refresh token and persist the rotated one. Losing that
      // race must not wipe the winner's valid credential.
      const expired = expiredAuth({ refresh: "rt_loser" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      const winner = validAuth({ access: "at_winner", refresh: "rt_winner" });
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // Simulate the other process having already rotated the tokens on disk.
          deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: winner } };
          return Promise.resolve(jsonResponse({ error: "invalid_grant" }, 400));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe("at_winner");
      }
      // The winner's credential was NOT cleared.
      const cleared = deps.setConfigValueCalls.find(
        (c) => c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(cleared).toBeUndefined();
    });

    it("rejects tokens minted by a different deployment without any network call", async () => {
      // Even non-expired tokens must never be handed out for a different
      // deployment: the bearer token would leak to the new host.
      deps.providersConfig = {
        coder: { deploymentUrl: "http://other.coder.test", coderOauth: validAuth() },
      };

      let fetchCalls = 0;
      mockFetch(() => {
        fetchCalls++;
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.getValidAuth();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("deployment URL changed");
      }
      expect(fetchCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Desktop flow (full loopback round-trip with a fake deployment)
  // -------------------------------------------------------------------------

  describe("startDesktopFlow", () => {
    it("rejects invalid deployment URLs without network calls", async () => {
      let fetchCalled = false;
      mockFetch(() => {
        fetchCalled = true;
        return Promise.resolve(jsonResponse({}));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: "not-a-url" });
      expect(result.success).toBe(false);
      expect(fetchCalled).toBe(false);
    });

    it("surfaces discovery failures with an experiments hint", async () => {
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url.endsWith("/api/v2/buildinfo")) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("--experiments=oauth2");
      }
    });

    it("completes the full flow: DCR, PKCE exchange, persistence, and model fetch", async () => {
      const registerCalls: unknown[] = [];
      let exchangeBody: URLSearchParams | null = null;

      mockFetch((input, init) => {
        const url = fetchUrl(input);

        // Let the loopback callback request through to the real local server.
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }

        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          const body = JSON.parse(fetchBodyText(init)) as Record<string, unknown>;
          registerCalls.push(body);
          return Promise.resolve(
            jsonResponse({
              client_id: "client_new",
              client_secret: "secret_new",
              registration_access_token: "reg_token_new",
              registration_client_uri: `${DEPLOYMENT_URL}/oauth2/clients/client_new`,
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          exchangeBody = new URLSearchParams(fetchBodyText(init));
          return Promise.resolve(
            jsonResponse({
              access_token: "at_login",
              refresh_token: "rt_login",
              expires_in: 86400,
              token_type: "Bearer",
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          return Promise.resolve(
            jsonResponse({ data: [{ id: "claude-sonnet-4-5" }, { id: "claude-opus-4-1" }] })
          );
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          // One upstream unavailable: must be tolerated.
          return Promise.resolve(new Response("aibridge not entitled", { status: 404 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const startResult = await service.startDesktopFlow({
        // Extra path suffix + trailing slash must be normalized away.
        deploymentUrl: `${DEPLOYMENT_URL}/`,
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const { flowId, authorizeUrl } = startResult.data;
      const authorize = new URL(authorizeUrl);
      expect(authorize.origin).toBe(DEPLOYMENT_URL);
      expect(authorize.pathname).toBe("/oauth2/authorize");
      expect(authorize.searchParams.get("response_type")).toBe("code");
      expect(authorize.searchParams.get("client_id")).toBe("client_new");
      expect(authorize.searchParams.get("state")).toBe(flowId);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

      const redirectUri = authorize.searchParams.get("redirect_uri")!;
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      // DCR registered the exact loopback redirect URI (OAuth 2.1 exact matching).
      expect(registerCalls).toHaveLength(1);
      expect((registerCalls[0] as { redirect_uris: string[] }).redirect_uris).toEqual([
        redirectUri,
      ]);

      // Simulate the browser redirect back to the loopback server.
      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", "auth_code_123");
      callbackUrl.searchParams.set("state", flowId);
      const callbackResponse = await originalFetch(callbackUrl);
      expect(callbackResponse.status).toBe(200);

      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // Exchange used PKCE: verifier hashes to the challenge from the authorize URL.
      expect(exchangeBody).not.toBeNull();
      expect(exchangeBody!.get("grant_type")).toBe("authorization_code");
      expect(exchangeBody!.get("code")).toBe("auth_code_123");
      expect(exchangeBody!.get("redirect_uri")).toBe(redirectUri);
      expect(exchangeBody!.get("client_secret")).toBe("secret_new");
      expect(sha256Base64Url(exchangeBody!.get("code_verifier")!)).toBe(
        authorize.searchParams.get("code_challenge")!
      );

      // Normalized deployment URL + full auth blob persisted.
      const urlCall = deps.setConfigValueCalls.find((c) => c.keyPath[0] === "deploymentUrl");
      expect(urlCall?.value).toBe(DEPLOYMENT_URL);
      const authCall = deps.setConfigValueCalls.find(
        (c) => c.keyPath[0] === "coderOauth" && c.value !== undefined
      );
      expect(authCall).toBeDefined();
      const persistedAuth = authCall!.value as CoderOauthAuth;
      expect(persistedAuth.access).toBe("at_login");
      expect(persistedAuth.refresh).toBe("rt_login");
      expect(persistedAuth.clientId).toBe("client_new");
      expect(persistedAuth.clientSecret).toBe("secret_new");
      expect(persistedAuth.registrationAccessToken).toBe("reg_token_new");

      // Model list fetched from the reachable upstream only (openai 404 tolerated).
      // Discovery runs after the flow resolves, so wait for the detached task.
      await waitUntil(() => deps.setModelsCalls.length > 0);
      expect(deps.setModelsCalls).toHaveLength(1);
      expect(deps.setModelsCalls[0].provider).toBe("coder");
      expect(deps.setModelsCalls[0].models).toEqual([
        "anthropic/claude-sonnet-4-5",
        "anthropic/claude-opus-4-1",
      ]);

      expect(deps.focusCalls).toBe(1);
    });

    it("updates the stored client's redirect URI via RFC 7592 instead of re-registering", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      let putRedirectUris: string[] | null = null;
      let registerCalled = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          const headers = new Headers(init.headers);
          expect(headers.get("Authorization")).toBe("Bearer reg_token_test");
          const body = JSON.parse(fetchBodyText(init)) as { redirect_uris: string[] };
          putRedirectUris = body.redirect_uris;
          return Promise.resolve(jsonResponse({ client_id: "client_test" }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registerCalled = true;
          return Promise.resolve(new Response("should not be called", { status: 500 }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const redirectUri = new URL(result.data.authorizeUrl).searchParams.get("redirect_uri")!;
      // TS narrows the closure-assigned variable to its initializer type; widen for the assertion.
      expect(putRedirectUris as string[] | null).toEqual([redirectUri]);
      expect(registerCalled).toBe(false);
      // Reused the stored client id.
      expect(new URL(result.data.authorizeUrl).searchParams.get("client_id")).toBe("client_test");

      await service.cancelDesktopFlow(result.data.flowId);
    });

    it("falls back to fresh registration when the RFC 7592 update fails", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          // Client was deleted server-side.
          return Promise.resolve(jsonResponse({ error: "invalid_token" }, 401));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({
              client_id: "client_replacement",
              client_secret: "secret_replacement",
            })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(new URL(result.data.authorizeUrl).searchParams.get("client_id")).toBe(
        "client_replacement"
      );

      await service.cancelDesktopFlow(result.data.flowId);
    });

    it("registers a fresh client when logging in to a different deployment", async () => {
      // Client registered on the OLD deployment must not be reused (its RFC 7592
      // endpoint points at the old host).
      const oldDeployment = "http://old.coder.test";
      deps.providersConfig = {
        coder: {
          deploymentUrl: oldDeployment,
          coderOauth: validAuth({
            deploymentUrl: oldDeployment,
            registrationClientUri: `${oldDeployment}/oauth2/clients/client_test`,
          }),
        },
      };

      let oldHostCalls = 0;
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url.startsWith(oldDeployment)) {
          oldHostCalls++;
          return Promise.resolve(new Response("should not be called", { status: 500 }));
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(oldHostCalls).toBe(0);
      expect(new URL(result.data.authorizeUrl).searchParams.get("client_id")).toBe("client_fresh");

      await service.cancelDesktopFlow(result.data.flowId);
    });

    it("does not persist tokens when the flow is cancelled during the exchange", async () => {
      let releaseExchange!: () => void;
      const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
      let exchangeStarted!: () => void;
      const exchangeStartedPromise = new Promise<void>((resolve) => (exchangeStarted = resolve));
      let revokeBody: URLSearchParams | null = null;

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // Hold the exchange round-trip open so the test can cancel mid-flight.
          exchangeStarted();
          await exchangeGate;
          return jsonResponse({
            access_token: "at_raced",
            refresh_token: "rt_raced",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });

      // Trigger the callback but do NOT await the response: it only resolves
      // after the (gated) exchange settles.
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_raced");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await exchangeStartedPromise;
      await service.cancelDesktopFlow(flowId);
      releaseExchange();

      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(false);
      await callbackPromise;

      // Give the detached exchange task a beat to run its post-cancel branch.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // No credentials persisted; the raced tokens were revoked best-effort.
      const persisted = deps.setConfigValueCalls.find(
        (c) => c.keyPath[0] === "coderOauth" && c.value !== undefined
      );
      expect(persisted).toBeUndefined();
      expect(revokeBody).not.toBeNull();
      expect(revokeBody!.get("token")).toBe("rt_raced");
    });

    it("rolls back persisted credentials when cancelled during the persist write", async () => {
      // Gate the persist (setConfigValue) write so cancellation can land in the
      // window between the pre-persist liveness check and the flow commit.
      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistStarted!: () => void;
      const persistStartedPromise = new Promise<void>((resolve) => (persistStarted = resolve));
      let revokeBody: URLSearchParams | null = null;

      const gatedProviderService: Pick<ProviderService, "setConfigValue" | "setModels"> = {
        setConfigValue: async (provider, keyPath, value) => {
          if (keyPath[0] === "coderOauth" && value !== undefined) {
            persistStarted();
            await persistGate;
          }
          deps.setConfigValueCalls.push({ provider, keyPath: [...keyPath], value });
          return Ok(undefined);
        },
        setModels: (provider, models) => {
          deps.setModelsCalls.push({ provider, models });
          return Ok(undefined);
        },
      };
      service = new CoderOauthService(
        createMockConfig(deps) as Config,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_persist_race",
            refresh_token: "rt_persist_race",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_persist_race");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await persistStartedPromise;
      await service.cancelDesktopFlow(flowId);
      releasePersist();
      await callbackPromise;

      // Wait for the detached task's rollback branch to run.
      await waitUntil(() =>
        deps.setConfigValueCalls.some((c) => c.keyPath[0] === "coderOauth" && c.value === undefined)
      );
      // The persisted write was undone and the raced tokens revoked.
      expect(revokeBody).not.toBeNull();
      expect(revokeBody!.get("token")).toBe("rt_persist_race");
    });

    it("clears the persisted model catalog when the new deployment has no catalogs", async () => {
      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_no_catalog",
            refresh_token: "rt_no_catalog",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        // Both bridge catalogs unavailable (e.g. AI Bridge not entitled).
        if (url.includes("/api/v2/aibridge/")) {
          return new Response("aibridge not entitled", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_no_catalog");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // A previous deployment's catalog must not survive the re-login: the
      // list is overwritten with the (empty) catalog of the new deployment.
      await waitUntil(() => deps.setModelsCalls.length > 0);
      expect(deps.setModelsCalls[0].provider).toBe("coder");
      expect(deps.setModelsCalls[0].models).toEqual([]);
    });

    it("skips the model catalog write when the login was superseded during discovery", async () => {
      // Gate the catalog fetch so a newer login can land while discovery runs.
      let releaseCatalog!: () => void;
      const catalogGate = new Promise<void>((resolve) => (releaseCatalog = resolve));
      let catalogStarted!: () => void;
      const catalogStartedPromise = new Promise<void>((resolve) => (catalogStarted = resolve));

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url.startsWith("http://127.0.0.1")) {
          return originalFetch(input, init);
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_new", client_secret: "secret_new" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_slow_login",
            refresh_token: "rt_slow_login",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url.includes("/api/v2/aibridge/")) {
          catalogStarted();
          await catalogGate;
          return jsonResponse({ data: [{ id: "stale-model" }] });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_slow");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // While discovery is blocked, a newer login replaces the stored credential.
      await catalogStartedPromise;
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({ access: "at_newer_login", refresh: "rt_newer_login" }),
        },
      };
      releaseCatalog();

      // The stale discovery must not commit its catalog over the newer login's.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(deps.setModelsCalls).toHaveLength(0);
    });
  });

  describe("cancelDesktopFlow", () => {
    it("resolves waitForDesktopFlow with cancellation error", async () => {
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(jsonResponse({ client_id: "c", client_secret: "s" }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitPromise = service.waitForDesktopFlow(startResult.data.flowId, {
        timeoutMs: 5000,
      });
      await service.cancelDesktopFlow(startResult.data.flowId);

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cancelled");
      }
    });
  });

  // -------------------------------------------------------------------------
  // disconnect
  // -------------------------------------------------------------------------

  describe("disconnect", () => {
    it("revokes best-effort, clears stored auth, and clears models", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      let revokeBody: URLSearchParams | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      expect(revokeBody).not.toBeNull();
      expect(revokeBody!.get("token")).toBe("rt_test");

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "coder" && c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();
      expect(deps.setModelsCalls).toEqual([{ provider: "coder", models: [] }]);
    });

    it("does not clear a newer login that completed while revocation was pending", async () => {
      const oldAuth = validAuth({ refresh: "rt_old" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: oldAuth } };

      const newAuth = validAuth({ access: "at_new", refresh: "rt_new" });
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          // Simulate a re-login completing while the (slow) revocation runs.
          deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: newAuth } };
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      // The new login's credential and models were left intact.
      const cleared = deps.setConfigValueCalls.find(
        (c) => c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(cleared).toBeUndefined();
      expect(deps.setModelsCalls).toHaveLength(0);
    });

    it("still clears auth when revocation fails", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch(() => Promise.reject(new Error("network down")));

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      const clearCall = deps.setConfigValueCalls.find(
        (c) => c.provider === "coder" && c.keyPath[0] === "coderOauth" && c.value === undefined
      );
      expect(clearCall).toBeDefined();
    });
  });
});
