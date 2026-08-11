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
