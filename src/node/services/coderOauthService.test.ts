import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as crypto from "crypto";

import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import type { Config, ProvidersConfig } from "@/node/config";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import type { ProviderModelEntry } from "@/common/config/schemas/providerModelEntry";
import type { CoderOauthAuth } from "@/node/utils/coderOauthAuth";
import type { PolicyService } from "@/node/services/policyService";
import { CoderOauthService } from "./coderOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEPLOYMENT_URL = "http://coder.test";

/** Build a valid CoderOauthAuth that expires far in the future. */
function validAuth(overrides?: Partial<CoderOauthAuth>): CoderOauthAuth {
  return {
    type: "oauth",
    sessionId: "session_test",
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
  /** Listeners registered via onConfigChanged (fire to simulate external file changes). */
  configChangedListeners: Array<() => void>;
  /** Simulates the cross-process stored-client lease (true = held elsewhere). */
  coderClientLeaseHeld: boolean;
}

function createMockDeps(): MockDeps {
  return {
    providersConfig: {},
    setConfigValueCalls: [],
    setModelsCalls: [],
    focusCalls: 0,
    configChangedListeners: [],
    coderClientLeaseHeld: false,
  };
}

function createMockConfig(
  deps: MockDeps
): Pick<
  Config,
  | "loadProvidersConfig"
  | "tryAcquireCoderOauthClientLease"
  | "withCoderOauthRefreshLock"
  | "withCoderOauthLoginCommitLock"
> {
  return {
    loadProvidersConfig: () => deps.providersConfig,
    // Mirrors Config.tryAcquireCoderOauthClientLease: non-blocking, exclusive,
    // released via the returned function.
    tryAcquireCoderOauthClientLease: () => {
      if (deps.coderClientLeaseHeld) {
        return null;
      }
      deps.coderClientLeaseHeld = true;
      return () => {
        deps.coderClientLeaseHeld = false;
      };
    },
    // Single-process tests do not contend on the cross-process locks; the
    // two-process race tests wire shared serializing locks instead.
    withCoderOauthRefreshLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
    withCoderOauthLoginCommitLock: async <T>(fn: () => Promise<T> | T): Promise<T> => await fn(),
  };
}

/**
 * A shared, serializing implementation of Config's cross-process locks
 * (withCoderOauthRefreshLock / withCoderOauthLoginCommitLock) for tests that
 * simulate two Mux processes contending on the same providers file.
 */
function createSharedCrossProcessLock(): <T>(fn: () => Promise<T> | T) => Promise<T> {
  let busy = false;
  const queue: Array<() => void> = [];
  return async <T>(fn: () => Promise<T> | T): Promise<T> => {
    while (busy) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
      queue.shift()?.();
    }
  };
}

function mockSetConfigValue(
  deps: MockDeps,
  provider: string,
  keyPath: string[],
  value: unknown
): Promise<Result<void, string>> {
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
}

/** Mirrors ProviderService.updateConfigValue's read-predicate-write behavior. */
async function mockUpdateConfigValue(
  deps: MockDeps,
  provider: string,
  keyPath: string[],
  update: (current: unknown) => { value: unknown } | null
): Promise<Result<{ applied: boolean }, string>> {
  let current: unknown = (deps.providersConfig as Record<string, unknown>)[provider];
  for (const key of keyPath) {
    current =
      current !== null && typeof current === "object"
        ? (current as Record<string, unknown>)[key]
        : undefined;
  }
  const decision = update(current);
  if (!decision) {
    return Ok({ applied: false });
  }
  await mockSetConfigValue(deps, provider, keyPath, decision.value);
  return Ok({ applied: true });
}

/**
 * Mirrors ProviderService.updateProviderSection: applies the section update to
 * the in-memory config and records model-list changes in setModelsCalls so
 * tests can assert on catalog writes.
 */
function mockUpdateProviderSection(
  deps: MockDeps,
  provider: string,
  update: (
    section: Record<string, unknown> | undefined
  ) => { value: Record<string, unknown> } | null
): Promise<Result<{ applied: boolean }, string>> {
  const configRecord = deps.providersConfig as Record<string, Record<string, unknown> | undefined>;
  const section = configRecord[provider];
  const decision = update(section ? { ...section } : undefined);
  if (!decision) {
    return Promise.resolve(Ok({ applied: false }));
  }
  if (JSON.stringify(section?.models) !== JSON.stringify(decision.value.models)) {
    deps.setModelsCalls.push({
      provider,
      models: (decision.value.models ?? []) as ProviderModelEntry[],
    });
  }
  configRecord[provider] = decision.value;
  return Promise.resolve(Ok({ applied: true }));
}

function createMockProviderService(
  deps: MockDeps
): Pick<
  ProviderService,
  "setConfigValue" | "setModels" | "updateConfigValue" | "updateProviderSection" | "onConfigChanged"
> {
  return {
    setConfigValue: (provider, keyPath, value) =>
      mockSetConfigValue(deps, provider, keyPath, value),
    updateConfigValue: (provider, keyPath, update) =>
      mockUpdateConfigValue(deps, provider, keyPath, update),
    updateProviderSection: (provider, update) => mockUpdateProviderSection(deps, provider, update),
    setModels: (provider: string, models: ProviderModelEntry[]): Promise<Result<void, string>> => {
      deps.setModelsCalls.push({ provider, models });
      return Promise.resolve(Ok(undefined));
    },
    onConfigChanged: (callback: () => void) => {
      deps.configChangedListeners.push(callback);
      return () => {
        deps.configChangedListeners = deps.configChangedListeners.filter((l) => l !== callback);
      };
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

    it("does not overwrite a newer login with a refresh result from the old generation", async () => {
      const expired = expiredAuth({ refresh: "rt_old" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expired } };

      const newerLogin = validAuth({ access: "at_new_login", refresh: "rt_new_login" });
      let revokeBody: URLSearchParams | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          // A re-login completes while the refresh round-trip is in flight.
          deps.providersConfig = {
            coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: newerLogin },
          };
          return Promise.resolve(
            jsonResponse({
              access_token: "at_stale_rotation",
              refresh_token: "rt_stale_rotation",
              expires_in: 86400,
              token_type: "Bearer",
            })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokeBody = new URLSearchParams(fetchBodyText(init));
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const result = await service.getValidAuth();
      // The newer login wins; the stale rotation is never persisted.
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.access).toBe("at_new_login");
      }
      const staleWrite = deps.setConfigValueCalls.find(
        (c) =>
          c.keyPath[0] === "coderOauth" &&
          (c.value as CoderOauthAuth | undefined)?.access === "at_stale_rotation"
      );
      expect(staleWrite).toBeUndefined();
      // The orphaned rotation was revoked best-effort.
      expect(revokeBody).not.toBeNull();
      expect(revokeBody!.get("token")).toBe("rt_stale_rotation");
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

    it("serializes cross-process refreshes so a losing invalid_grant cannot clear the winner's rotation", async () => {
      // Two Mux processes refresh the same expired credential. Without
      // cross-process serialization the loser's invalid_grant response can
      // arrive while the winner's rotation is still in flight; the loser's
      // compare-and-clear then deletes the (still-old) credential, the
      // winner's persist CAS fails, and both processes discard the only valid
      // token. With the shared refresh lock the loser blocks, re-reads the
      // winner's rotation from disk, and never sends a doomed request.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: expiredAuth() },
      };

      const sharedLock = createSharedCrossProcessLock();
      const makeProcess = (): CoderOauthService =>
        new CoderOauthService(
          {
            ...createMockConfig(deps),
            withCoderOauthRefreshLock: sharedLock,
          } as Config,
          createMockProviderService(deps) as ProviderService,
          createMockWindowService(deps) as WindowService
        );
      const processA = makeProcess();
      const processB = makeProcess();

      let tokenRequests = 0;
      let releaseWinner!: () => void;
      const winnerGate = new Promise<void>((resolve) => (releaseWinner = resolve));

      mockFetch(async (input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const request = ++tokenRequests;
          if (request === 1) {
            // The winner's rotation: stalled so the race window stays open.
            await winnerGate;
            return jsonResponse({
              access_token: "at_rotated",
              refresh_token: "rt_rotated",
              expires_in: 86400,
              token_type: "Bearer",
            });
          }
          // Any second request would be the loser reusing the consumed
          // refresh token — the exact doomed request the lock must prevent.
          return jsonResponse({ error: "invalid_grant" }, 400);
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          return new Response(null, { status: 200 });
        }
        void init;
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const resultAPromise = processA.getValidAuth();
      // A holds the shared lock with its token request in flight; B must
      // queue on the lock rather than issue its own request.
      await waitUntil(() => tokenRequests === 1);
      const resultBPromise = processB.getValidAuth();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(tokenRequests).toBe(1);

      releaseWinner();
      const [resultA, resultB] = await Promise.all([resultAPromise, resultBPromise]);

      // Both processes end up with the winner's rotation; B adopted it from
      // disk without ever sending a request with the consumed token.
      expect(resultA.success).toBe(true);
      if (resultA.success) expect(resultA.data.access).toBe("at_rotated");
      expect(resultB.success).toBe(true);
      if (resultB.success) expect(resultB.data.access).toBe("at_rotated");
      expect(tokenRequests).toBe(1);
      // The rotated credential is still on disk (never cleared).
      const storedAuth = (deps.providersConfig.coder as Record<string, unknown>)
        .coderOauth as CoderOauthAuth;
      expect(storedAuth.refresh).toBe("rt_rotated");

      await processA.dispose();
      await processB.dispose();
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

    it("serves credentials written by another process after a config-change notification", async () => {
      // Another Mux process sharing providers.jsonc re-logs in to the SAME
      // deployment: the deployment URL still matches, so only the config
      // change notification (file watcher) can tell this process its cached
      // token is stale. getValidAuth must serve the new on-disk credential,
      // not the cached one, until expiry.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const first = await service.getValidAuth();
      expect(first.success).toBe(true);
      if (first.success) {
        expect(first.data.access).toBe("at_test");
      }

      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: validAuth({
            sessionId: "session_other_process",
            access: "at_other",
            refresh: "rt_other",
          }),
        },
      };
      for (const listener of deps.configChangedListeners) {
        listener();
      }

      const second = await service.getValidAuth();
      expect(second.success).toBe(true);
      if (second.success) {
        expect(second.data.access).toBe("at_other");
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

      // Normalized deployment URL + full auth blob persisted (atomically, at
      // exchange time — flow start writes nothing).
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      const persistedAuth = coderSection.coderOauth as CoderOauthAuth;
      expect(persistedAuth.access).toBe("at_login");
      expect(persistedAuth.refresh).toBe("rt_login");
      expect(persistedAuth.sessionId).toBeTruthy();
      expect(persistedAuth.clientId).toBe("client_new");
      expect(persistedAuth.clientSecret).toBe("secret_new");
      expect(persistedAuth.registrationAccessToken).toBe("reg_token_new");

      // Model list fetched from the reachable upstream only (openai 404 tolerated).
      // The exchange clears the previous catalog atomically with the new auth,
      // then discovery (after the flow resolves) populates the fresh one.
      await waitUntil(() => deps.setModelsCalls.length >= 2);
      expect(deps.setModelsCalls[0].models).toEqual([]);
      const discoveryCall = deps.setModelsCalls[deps.setModelsCalls.length - 1];
      expect(discoveryCall.provider).toBe("coder");
      expect(discoveryCall.models).toEqual([
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

    it("logs in to the policy-forced deployment instead of the requested URL", async () => {
      const FORCED_URL = "http://locked.coder.test";
      service = new CoderOauthService(
        createMockConfig(deps) as Config,
        createMockProviderService(deps) as ProviderService,
        createMockWindowService(deps) as WindowService,
        {
          isEnforced: () => true,
          getForcedBaseUrl: (provider: string) =>
            provider === "coder" ? `${FORCED_URL}/` : undefined,
        } as PolicyService
      );

      let requestedHostCalls = 0;
      mockFetch((input) => {
        const url = fetchUrl(input);
        if (url.startsWith(DEPLOYMENT_URL)) {
          requestedHostCalls++;
          return Promise.resolve(new Response("should not be called", { status: 500 }));
        }
        if (url === `${FORCED_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${FORCED_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(
            jsonResponse({
              authorization_endpoint: `${FORCED_URL}/oauth2/authorize`,
              token_endpoint: `${FORCED_URL}/oauth2/tokens`,
              registration_endpoint: `${FORCED_URL}/oauth2/register`,
              code_challenge_methods_supported: ["S256"],
            })
          );
        }
        if (url === `${FORCED_URL}/oauth2/register`) {
          return Promise.resolve(jsonResponse({ client_id: "c_locked", client_secret: "s" }));
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      // User asks for DEPLOYMENT_URL; policy must reroute the login.
      const result = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(requestedHostCalls).toBe(0);
      expect(new URL(result.data.authorizeUrl).origin).toBe(FORCED_URL);
      // Nothing persisted at flow start: the (forced) URL is committed
      // atomically with the auth blob only when the flow completes.
      const urlCall = deps.setConfigValueCalls.find((c) => c.keyPath[0] === "deploymentUrl");
      expect(urlCall).toBeUndefined();

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

    it("re-asserts its own deployment URL when finishing after a login to another deployment", async () => {
      // Overlapping flows: a login to deployment B starts (persisting B's URL)
      // while this flow for deployment A is mid-exchange. When A finishes
      // last, it must write its URL together with its auth — otherwise the
      // section would pair A's auth with B's URL and fail issuer validation.
      const OTHER_URL = "http://other.coder.test";

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
          // A login to deployment B completes while A's exchange round-trip is
          // in flight, committing B's URL.
          deps.providersConfig.coder ??= {};
          (deps.providersConfig.coder as Record<string, unknown>).deploymentUrl = OTHER_URL;
          return jsonResponse({
            access_token: "at_slow_a",
            refresh_token: "rt_slow_a",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url.includes("/api/v2/aibridge/")) {
          return new Response("no catalog", { status: 404 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_slow_a");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // The completed login owns a coherent section: URL matches auth issuer.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect((coderSection.coderOauth as CoderOauthAuth).deploymentUrl).toBe(DEPLOYMENT_URL);
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_slow_a");
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

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          // Gate credential writes (login persists route through updateProviderSection).
          persistStarted();
          await persistGate;
          return mockUpdateProviderSection(deps, provider, update);
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

      // Cancellation won while the persist waited: the in-lock liveness check
      // skips the write entirely and the raced tokens are revoked.
      await waitUntil(() => revokeBody !== null);
      expect((deps.providersConfig.coder as Record<string, unknown> | undefined)?.coderOauth).toBe(
        undefined
      );
      expect(revokeBody!.get("token")).toBe("rt_persist_race");
    });

    it("restores the prior login when a re-login is cancelled during its persist", async () => {
      // A connected account re-logs in; Cancel lands while the new login's
      // section mutation waits for the providers-file lock. The prior login
      // (auth + URL + catalog) must survive intact.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: priorAuth,
          models: ["anthropic/prior-model"],
        },
      };

      let releasePersist!: () => void;
      const persistGate = new Promise<void>((resolve) => (releasePersist = resolve));
      let persistStarted!: () => void;
      const persistStartedPromise = new Promise<void>((resolve) => (persistStarted = resolve));
      let revokeBody: URLSearchParams | null = null;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          persistStarted();
          await persistGate;
          return mockUpdateProviderSection(deps, provider, update);
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
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          return jsonResponse({
            access_token: "at_relogin",
            refresh_token: "rt_relogin",
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
      callbackUrl.searchParams.set("code", "auth_code_relogin");
      callbackUrl.searchParams.set("state", flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await persistStartedPromise;
      await service.cancelDesktopFlow(flowId);
      releasePersist();
      await callbackPromise;

      // The cancelled re-login's tokens were revoked...
      await waitUntil(() => revokeBody !== null);
      expect(revokeBody!.get("token")).toBe("rt_relogin");
      // ...and the prior login survives untouched: auth, URL, and catalog.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_prior");
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect(coderSection.models).toEqual(["anthropic/prior-model"]);
    });

    it("keeps the original login when two overlapping logins are both cancelled", async () => {
      // Regression: rollback snapshots must not compose across overlapping
      // flows. Without commit serialization, flow B snapshots flow A's
      // persisted-but-uncommitted login as its "previous section"; cancelling
      // A then B revokes A's tokens yet restores them over the original
      // login. The commit lock keeps B out of the persist->commit window
      // while A is mid-commit, so the original login must survive both
      // cancellations and both raced token sets must be revoked.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: priorAuth,
          models: ["anthropic/prior-model"],
        },
      };

      // Gate the first two section mutations AFTER their write lands so
      // cancellation deterministically hits the persist->commit window;
      // later mutations (rollbacks) pass straight through once released.
      const releases: Array<() => void> = [];
      const gates: Array<Promise<void>> = [
        new Promise<void>((resolve) => releases.push(resolve)),
        new Promise<void>((resolve) => releases.push(resolve)),
      ];
      let firstPersistApplied!: () => void;
      const firstPersistAppliedPromise = new Promise<void>(
        (resolve) => (firstPersistApplied = resolve)
      );
      let sectionCalls = 0;

      const gatedProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: async (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          const call = ++sectionCalls;
          const result = await mockUpdateProviderSection(deps, provider, update);
          if (call === 1) {
            firstPersistApplied();
          }
          if (call <= gates.length) {
            await gates[call - 1];
          }
          return result;
        },
      };
      service = new CoderOauthService(
        createMockConfig(deps) as Config,
        gatedProviderService as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const servedCodes = new Set<string>();
      const revokedTokens: string[] = [];

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
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        // The second overlapping flow registers a fresh client instead of
        // updating the stored one (stored-client reservation).
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const body = new URLSearchParams(fetchBodyText(init));
          const code = body.get("code") ?? "";
          servedCodes.add(code);
          const suffix = code === "code_flow1" ? "flow1" : "flow2";
          return jsonResponse({
            access_token: `at_${suffix}`,
            refresh_token: `rt_${suffix}`,
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const start1 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      const start2 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start1.success && start2.success).toBe(true);
      if (!start1.success || !start2.success) return;

      const callbackFor = (authorizeUrl: string, state: string, code: string): URL => {
        const cb = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", code);
        cb.searchParams.set("state", state);
        return cb;
      };

      // Flow 1 persists its login and blocks mid-commit (gate 1).
      const cb1 = originalFetch(
        callbackFor(start1.data.authorizeUrl, start1.data.flowId, "code_flow1")
      ).catch(() => null);
      await firstPersistAppliedPromise;

      // Flow 2 exchanges its code; its commit then queues behind the lock.
      const cb2 = originalFetch(
        callbackFor(start2.data.authorizeUrl, start2.data.flowId, "code_flow2")
      ).catch(() => null);
      await waitUntil(() => servedCodes.has("code_flow2"));

      // Cancel both flows in order, then let the gated commits proceed.
      await service.cancelDesktopFlow(start1.data.flowId);
      await service.cancelDesktopFlow(start2.data.flowId);
      for (const release of releases) release();
      await Promise.all([cb1, cb2]);

      // Both raced logins' tokens are revoked...
      await waitUntil(
        () => revokedTokens.includes("rt_flow1") && revokedTokens.includes("rt_flow2")
      );
      // ...and the ORIGINAL login survives (not flow1's revoked tokens).
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_prior");
      expect((coderSection.coderOauth as CoderOauthAuth).refresh).toBe("rt_prior");
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect(coderSection.models).toEqual(["anthropic/prior-model"]);
    });

    it("keeps the original login when overlapping logins in two processes are both cancelled", async () => {
      // Cross-process variant of the previous test: the rollback-snapshot
      // composure bug is not confined to one CoderOauthService instance —
      // process B persisting while process A is mid-commit captures A's
      // uncommitted auth as its previousSection just the same. The shared
      // commit lock must keep B's persist out of A's persist->commit window,
      // so the original login survives both cancellations.
      const priorAuth = validAuth({
        sessionId: "session_prior",
        access: "at_prior",
        refresh: "rt_prior",
      });
      deps.providersConfig = {
        coder: {
          deploymentUrl: DEPLOYMENT_URL,
          coderOauth: priorAuth,
          models: ["anthropic/prior-model"],
        },
      };

      const sharedCommitLock = createSharedCrossProcessLock();

      // Per-process provider services: process A's first section write is
      // gated AFTER it lands so A pauses inside its commit critical section;
      // process B's first write is gated the same way (only reached when the
      // shared lock is absent — under the fix B never persists at all).
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => (releaseA = resolve));
      let persistAApplied!: () => void;
      const persistAAppliedPromise = new Promise<void>((resolve) => (persistAApplied = resolve));
      let releaseB!: () => void;
      const gateB = new Promise<void>((resolve) => (releaseB = resolve));
      let sectionCallsA = 0;
      let sectionCallsB = 0;

      const makeProcess = (
        who: "A" | "B"
      ): { service: CoderOauthService; sectionCalls: () => number } => {
        const gatedProviderService = {
          ...createMockProviderService(deps),
          updateProviderSection: async (
            provider: string,
            update: (
              section: Record<string, unknown> | undefined
            ) => { value: Record<string, unknown> } | null
          ) => {
            const call = who === "A" ? ++sectionCallsA : ++sectionCallsB;
            const result = await mockUpdateProviderSection(deps, provider, update);
            if (who === "A" && call === 1) {
              persistAApplied();
              await gateA;
            }
            if (who === "B" && call === 1) {
              await gateB;
            }
            return result;
          },
        };
        const service = new CoderOauthService(
          {
            ...createMockConfig(deps),
            withCoderOauthLoginCommitLock: sharedCommitLock,
          } as Config,
          gatedProviderService as unknown as ProviderService,
          createMockWindowService(deps) as WindowService
        );
        return { service, sectionCalls: () => (who === "A" ? sectionCallsA : sectionCallsB) };
      };
      const processA = makeProcess("A");
      const processB = makeProcess("B");

      const servedCodes = new Set<string>();
      const revokedTokens: string[] = [];

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
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          return jsonResponse({ client_id: "client_test" });
        }
        // Whichever process misses the client lease registers fresh.
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const body = new URLSearchParams(fetchBodyText(init));
          const code = body.get("code") ?? "";
          servedCodes.add(code);
          const suffix = code === "code_flow1" ? "flow1" : "flow2";
          return jsonResponse({
            access_token: `at_${suffix}`,
            refresh_token: `rt_${suffix}`,
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedTokens.push(new URLSearchParams(fetchBodyText(init)).get("token") ?? "");
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const start1 = await processA.service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      const start2 = await processB.service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start1.success && start2.success).toBe(true);
      if (!start1.success || !start2.success) return;

      const callbackFor = (authorizeUrl: string, state: string, code: string): URL => {
        const cb = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", code);
        cb.searchParams.set("state", state);
        return cb;
      };

      // Process A persists its login and blocks mid-commit.
      const cb1 = originalFetch(
        callbackFor(start1.data.authorizeUrl, start1.data.flowId, "code_flow1")
      ).catch(() => null);
      await persistAAppliedPromise;

      // Process B exchanges its code; its commit must queue on the shared
      // lock — it must NOT persist while A is mid-commit.
      const cb2 = originalFetch(
        callbackFor(start2.data.authorizeUrl, start2.data.flowId, "code_flow2")
      ).catch(() => null);
      await waitUntil(() => servedCodes.has("code_flow2"));
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(processB.sectionCalls()).toBe(0);

      // Cancel both flows in order, then release the gates.
      await processA.service.cancelDesktopFlow(start1.data.flowId);
      await processB.service.cancelDesktopFlow(start2.data.flowId);
      releaseA();
      releaseB();
      await Promise.all([cb1, cb2]);

      // Both raced logins' tokens are revoked...
      await waitUntil(
        () => revokedTokens.includes("rt_flow1") && revokedTokens.includes("rt_flow2")
      );
      // ...and the ORIGINAL login survives — B never restored A's revoked
      // auth over it.
      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_prior");
      expect((coderSection.coderOauth as CoderOauthAuth).refresh).toBe("rt_prior");
      expect(coderSection.deploymentUrl).toBe(DEPLOYMENT_URL);
      expect(coderSection.models).toEqual(["anthropic/prior-model"]);

      await processA.service.dispose();
      await processB.service.dispose();
    });

    it("aborts a stalled client registration when the flow ends", async () => {
      // The registration endpoint accepts the connection but never responds.
      // The flow is registered BEFORE that await, so ending the flow
      // (cancel/timeout/shutdown) aborts the in-flight RPC instead of leaving
      // the loopback listener and request pinned until the network gives up.
      let registerStarted!: () => void;
      const registerStartedPromise = new Promise<void>((resolve) => (registerStarted = resolve));
      let registerAborted = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registerStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              registerAborted = true;
              reject(new Error("The operation was aborted"));
            });
          });
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      await registerStartedPromise;

      // Shutdown stands in for any flow-ending event (cancel/timeout): it
      // finishes the registered flow, which must abort the stalled RPC.
      await service.dispose();

      const startResult = await startPromise;
      expect(registerAborted).toBe(true);
      expect(startResult.success).toBe(false);
      if (!startResult.success) {
        expect(startResult.error).toContain("registration failed");
      }
    });

    it("lets Cancel reach a stalled client registration via the caller-supplied flow ID", async () => {
      // The UI generates the flow ID before calling startDesktopFlow, so its
      // Cancel action can target the attempt even though start has not
      // returned yet. Cancelling that ID must abort the in-flight
      // registration RPC (and close the loopback listener), not just abandon
      // the frontend state until the five-minute flow timeout.
      const flowId = "ui-generated-flow-id-123";
      let registerStarted!: () => void;
      const registerStartedPromise = new Promise<void>((resolve) => (registerStarted = resolve));
      let registerAborted = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registerStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              registerAborted = true;
              reject(new Error("The operation was aborted"));
            });
          });
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL, flowId });
      await registerStartedPromise;

      // The user's Cancel action: the flow is registered by now, so this
      // cancels it directly, which aborts the registration RPC.
      await service.cancelDesktopFlow(flowId);

      const startResult = await startPromise;
      expect(registerAborted).toBe(true);
      expect(startResult.success).toBe(false);
    });

    it("honors a Cancel that lands while the deployment probes are still in flight", async () => {
      // Before the flow is registered (buildinfo/discovery probes), Cancel
      // records a pre-cancellation; startDesktopFlow must consume it at its
      // next checkpoint and abort instead of continuing as an orphan attempt.
      const flowId = "ui-generated-flow-id-456";
      let probeStarted!: () => void;
      const probeStartedPromise = new Promise<void>((resolve) => (probeStarted = resolve));
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => (releaseProbe = resolve));
      let registrationAttempted = false;

      mockFetch(async (input) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          probeStarted();
          await probeGate;
          return jsonResponse({ version: "v2.99.0" });
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return discoveryResponse();
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          registrationAttempted = true;
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startPromise = service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL, flowId });
      await probeStartedPromise;
      await service.cancelDesktopFlow(flowId); // Flow not registered yet -> pre-cancel.
      releaseProbe();

      const startResult = await startPromise;
      expect(startResult.success).toBe(false);
      if (!startResult.success) {
        expect(startResult.error).toContain("cancelled");
      }
      // The attempt aborted before touching the registration endpoint.
      expect(registrationAttempted).toBe(false);
    });

    it("aborts a stalled token exchange when the flow is cancelled", async () => {
      // The token endpoint accepts the connection but never responds. The
      // exchange carries the flow's abort signal, so Cancel (or the flow
      // timeout) must kill the in-flight round-trip instead of leaking it as
      // a background request for up to the request timeout.
      let exchangeStarted!: () => void;
      const exchangeStartedPromise = new Promise<void>((resolve) => (exchangeStarted = resolve));
      let exchangeAborted = false;

      mockFetch((input, init) => {
        const url = fetchUrl(input);
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
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          exchangeStarted();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              exchangeAborted = true;
              reject(new Error("The operation was aborted"));
            });
          });
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;

      const callbackUrl = new URL(
        new URL(start.data.authorizeUrl).searchParams.get("redirect_uri")!
      );
      callbackUrl.searchParams.set("code", "code_stalled");
      callbackUrl.searchParams.set("state", start.data.flowId);
      const callbackPromise = originalFetch(callbackUrl).catch(() => null);

      await exchangeStartedPromise;
      await service.cancelDesktopFlow(start.data.flowId);
      await callbackPromise;

      await waitUntil(() => exchangeAborted);
      // Nothing was persisted for the aborted exchange.
      expect(deps.providersConfig.coder?.coderOauth).toBeUndefined();
    });

    it("registers a fresh client when another process holds the stored-client lease", async () => {
      // The stored-client reservation is a cross-process filesystem lease:
      // a concurrent login flow in ANOTHER Mux process sharing providers.jsonc
      // would clobber the stored client's single redirect slot just like an
      // in-process one. When the lease is unavailable, the flow must fall
      // back to a fresh client and leave the stored client untouched.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };
      deps.coderClientLeaseHeld = true; // Held by "another process".

      let putAttempted = false;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          putAttempted = true;
          return Promise.resolve(jsonResponse({ client_id: "client_test" }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start.success).toBe(true);
      if (!start.success) return;

      expect(putAttempted).toBe(false);
      expect(new URL(start.data.authorizeUrl).searchParams.get("client_id")).toBe("client_fresh");

      await service.cancelDesktopFlow(start.data.flowId);
      // The foreign lease is not released by this process's flow teardown.
      expect(deps.coderClientLeaseHeld).toBe(true);
    });

    it("registers a fresh client for a second overlapping flow instead of re-updating the stored one", async () => {
      // The stored dynamic client has a single redirect_uris slot: if two
      // overlapping flows both PUT-updated it, the later update would clobber
      // the earlier flow's ephemeral loopback URI and its authorize URL would
      // be rejected for a redirect mismatch. Only the first active flow may
      // reuse the stored client; overlapping flows get fresh clients. Once
      // the owner finishes, the stored client becomes reusable again.
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      const putRedirects: string[] = [];
      const registerRedirects: string[] = [];

      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/api/v2/buildinfo`) {
          return Promise.resolve(jsonResponse({ version: "v2.99.0" }));
        }
        if (url === `${DEPLOYMENT_URL}/.well-known/oauth-authorization-server`) {
          return Promise.resolve(discoveryResponse());
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/clients/client_test` && init?.method === "PUT") {
          const body = JSON.parse(fetchBodyText(init)) as { redirect_uris?: string[] };
          putRedirects.push(...(body.redirect_uris ?? []));
          return Promise.resolve(jsonResponse({ client_id: "client_test" }));
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/register`) {
          const body = JSON.parse(fetchBodyText(init)) as { redirect_uris?: string[] };
          registerRedirects.push(...(body.redirect_uris ?? []));
          return Promise.resolve(
            jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" })
          );
        }
        return Promise.resolve(new Response(`unexpected url: ${url}`, { status: 500 }));
      });

      const start1 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      const start2 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start1.success && start2.success).toBe(true);
      if (!start1.success || !start2.success) return;

      const clientIdOf = (authorizeUrl: string): string =>
        new URL(authorizeUrl).searchParams.get("client_id")!;
      const redirectOf = (authorizeUrl: string): string =>
        new URL(authorizeUrl).searchParams.get("redirect_uri")!;

      // Flow 1 owns the stored client; flow 2 got a fresh, isolated client.
      expect(clientIdOf(start1.data.authorizeUrl)).toBe("client_test");
      expect(clientIdOf(start2.data.authorizeUrl)).toBe("client_fresh");
      // The stored client's registered redirect is flow 1's — flow 2 never
      // touched it (exactly one PUT), so flow 1's authorize URL stays valid.
      expect(putRedirects).toEqual([redirectOf(start1.data.authorizeUrl)]);
      expect(registerRedirects).toEqual([redirectOf(start2.data.authorizeUrl)]);

      // Once the owning flow finishes, the stored client is reusable again.
      await service.cancelDesktopFlow(start1.data.flowId);
      const start3 = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(start3.success).toBe(true);
      if (!start3.success) return;
      expect(clientIdOf(start3.data.authorizeUrl)).toBe("client_test");
      expect(putRedirects).toHaveLength(2);
    });

    it("commits a new login while a cancelled flow's revocation is still stalled", async () => {
      // Cancellation after token exchange triggers best-effort revocation of
      // the raced tokens. That network call must not run under the login
      // commit lock: a stalled revocation endpoint would otherwise block
      // every later login from committing after browser authorization.
      let releaseExchangeA!: () => void;
      const exchangeGateA = new Promise<void>((resolve) => (releaseExchangeA = resolve));
      let exchangeAStarted!: () => void;
      const exchangeAStartedPromise = new Promise<void>((resolve) => (exchangeAStarted = resolve));
      let revokeAStarted = false;
      let releaseRevokeA!: () => void;
      const revokeGateA = new Promise<void>((resolve) => (releaseRevokeA = resolve));

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
          return jsonResponse({ client_id: "client_fresh", client_secret: "secret_fresh" });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/tokens`) {
          const body = new URLSearchParams(fetchBodyText(init));
          if (body.get("code") === "code_a") {
            exchangeAStarted();
            await exchangeGateA;
            return jsonResponse({
              access_token: "at_a",
              refresh_token: "rt_a",
              expires_in: 86400,
              token_type: "Bearer",
            });
          }
          return jsonResponse({
            access_token: "at_b",
            refresh_token: "rt_b",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          if (new URLSearchParams(fetchBodyText(init)).get("token") === "rt_a") {
            revokeAStarted = true;
            await revokeGateA; // Stalled revocation endpoint.
          }
          return new Response(null, { status: 200 });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const callbackFor = (authorizeUrl: string, state: string, code: string): URL => {
        const cb = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
        cb.searchParams.set("code", code);
        cb.searchParams.set("state", state);
        return cb;
      };

      // Flow A: callback arrives, exchange stalls, Cancel wins, then the
      // exchange resolves — commit sees the dead flow and starts revocation,
      // which hangs on the gated endpoint.
      const startA = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startA.success).toBe(true);
      if (!startA.success) return;
      const cbA = originalFetch(
        callbackFor(startA.data.authorizeUrl, startA.data.flowId, "code_a")
      ).catch(() => null);
      await exchangeAStartedPromise;
      await service.cancelDesktopFlow(startA.data.flowId);
      releaseExchangeA();
      await cbA;
      await waitUntil(() => revokeAStarted);

      // Flow B must be able to commit while A's revocation is still pending.
      const startB = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startB.success).toBe(true);
      if (!startB.success) return;
      await originalFetch(
        callbackFor(startB.data.authorizeUrl, startB.data.flowId, "code_b")
      ).catch(() => null);
      const waitB = await service.waitForDesktopFlow(startB.data.flowId, { timeoutMs: 3000 });
      expect(waitB.success).toBe(true);

      const coderSection = deps.providersConfig.coder as Record<string, unknown>;
      expect((coderSection.coderOauth as CoderOauthAuth).access).toBe("at_b");

      releaseRevokeA();
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

    it("fetches origin catalogs concurrently so a stalled origin cannot starve a healthy one", async () => {
      // The anthropic catalog stalls until the openai catalog has been
      // REQUESTED: with the old sequential loop this deadlocks (openai was
      // only queried after anthropic resolved), so completion here proves the
      // healthy origin is fetched while the other is stalled. Each request
      // must also carry an abort signal (the per-request timeout that unwedges
      // a genuinely dead origin in production).
      let releaseAnthropic!: () => void;
      const anthropicGate = new Promise<void>((resolve) => (releaseAnthropic = resolve));
      const catalogSignals: Array<AbortSignal | null | undefined> = [];

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
            access_token: "at_concurrent",
            refresh_token: "rt_concurrent",
            expires_in: 86400,
            token_type: "Bearer",
          });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/anthropic/v1/models`) {
          catalogSignals.push(init?.signal);
          await anthropicGate; // Stalled until openai is queried.
          return jsonResponse({ data: [{ id: "claude-sonnet-4-5" }] });
        }
        if (url === `${DEPLOYMENT_URL}/api/v2/aibridge/openai/v1/models`) {
          catalogSignals.push(init?.signal);
          releaseAnthropic();
          return jsonResponse({ data: [{ id: "gpt-5" }] });
        }
        return new Response(`unexpected url: ${url}`, { status: 500 });
      });

      const startResult = await service.startDesktopFlow({ deploymentUrl: DEPLOYMENT_URL });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;
      const { flowId, authorizeUrl } = startResult.data;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackUrl = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri")!);
      callbackUrl.searchParams.set("code", "auth_code_concurrent");
      callbackUrl.searchParams.set("state", flowId);
      await originalFetch(callbackUrl);
      const waitResult = await waitPromise;
      expect(waitResult.success).toBe(true);

      // Both catalogs land, in deterministic origin order, despite the stall.
      // (The first models write is the login commit's atomic catalog clear.)
      await waitUntil(() => deps.setModelsCalls.some((call) => call.models.length > 0));
      const catalogWrite = deps.setModelsCalls.find((call) => call.models.length > 0)!;
      expect(catalogWrite.models).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5"]);
      // Every catalog request was time-bounded.
      expect(catalogSignals).toHaveLength(2);
      for (const signal of catalogSignals) {
        expect(signal).toBeInstanceOf(AbortSignal);
      }
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
      // (The exchange-time atomic clear writes [], but the stale-model list
      // fetched by the superseded discovery must never land.)
      await new Promise((resolve) => setTimeout(resolve, 100));
      const staleWrite = deps.setModelsCalls.find((c) =>
        (c.models as unknown as string[]).some((m) => String(m).includes("stale-model"))
      );
      expect(staleWrite).toBeUndefined();
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

      // Tokens and models are cleared in one atomic section write.
      expect((deps.providersConfig.coder as Record<string, unknown>).coderOauth).toBeUndefined();
      expect(deps.setModelsCalls).toEqual([{ provider: "coder", models: [] }]);
    });

    it("does not clear a newer login that completed while revocation was pending", async () => {
      const oldAuth = validAuth({ refresh: "rt_old" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: oldAuth } };

      // A newer LOGIN mints a new session lineage id (rotations of the same
      // login keep it; see the concurrent-rotation test below).
      const newAuth = validAuth({
        sessionId: "session_new",
        access: "at_new",
        refresh: "rt_new",
      });
      let revokedToken: string | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedToken = new URLSearchParams(fetchBodyText(init)).get("token");
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      // Inject the newer login just before the section update runs (i.e. the
      // re-login wins the race to the persisted state).
      const injectingProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: newAuth } };
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockConfig(deps) as Config,
        injectingProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      // The new login's credential and models were left intact.
      expect(
        ((deps.providersConfig.coder as Record<string, unknown>).coderOauth as CoderOauthAuth)
          .access
      ).toBe("at_new");
      expect(deps.setModelsCalls).toHaveLength(0);
      // The disconnected (old) session's token was still revoked best-effort.
      // TS narrows the closure-assigned variable to its initializer type; widen.
      expect(revokedToken as string | null).toBe("rt_old");
    });

    it("clears a concurrent rotation of the same session (disconnect is authoritative)", async () => {
      // A refresh that rotates the tokens while disconnect awaits must NOT be
      // mistaken for a new login: same sessionId => still the session the user
      // asked to disconnect.
      const oldAuth = validAuth({ refresh: "rt_before_rotation" });
      deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: oldAuth } };

      const rotated = validAuth({ access: "at_rotated", refresh: "rt_rotated" });
      let revokedToken: string | null = null;
      mockFetch((input, init) => {
        const url = fetchUrl(input);
        if (url === `${DEPLOYMENT_URL}/oauth2/revoke`) {
          revokedToken = new URLSearchParams(fetchBodyText(init)).get("token");
          return Promise.resolve(new Response(null, { status: 200 }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      });

      const injectingProviderService = {
        ...createMockProviderService(deps),
        updateProviderSection: (
          provider: string,
          update: (
            section: Record<string, unknown> | undefined
          ) => { value: Record<string, unknown> } | null
        ) => {
          // The concurrent refresh persists its rotation first.
          deps.providersConfig = { coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: rotated } };
          return mockUpdateProviderSection(deps, provider, update);
        },
      };
      service = new CoderOauthService(
        createMockConfig(deps) as Config,
        injectingProviderService as unknown as ProviderService,
        createMockWindowService(deps) as WindowService
      );

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      // Despite the rotation, the session was cleared and its FRESHEST token revoked.
      expect((deps.providersConfig.coder as Record<string, unknown>).coderOauth).toBeUndefined();
      expect(revokedToken as string | null).toBe("rt_rotated");
    });

    it("still clears auth when revocation fails", async () => {
      deps.providersConfig = {
        coder: { deploymentUrl: DEPLOYMENT_URL, coderOauth: validAuth() },
      };

      mockFetch(() => Promise.reject(new Error("network down")));

      const result = await service.disconnect();
      expect(result.success).toBe(true);

      expect((deps.providersConfig.coder as Record<string, unknown>).coderOauth).toBeUndefined();
    });
  });
});
