import http from "node:http";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import type { Result } from "@/common/types/result";
import { Ok } from "@/common/types/result";
import {
  MUX_GATEWAY_AUTHORIZE_URL,
  MUX_GATEWAY_EXCHANGE_URL,
} from "@/common/constants/muxGatewayOAuth";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { MuxGatewayOauthService } from "./muxGatewayOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple GET helper that returns { status, body }. */
async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | Uint8Array) => {
          body += Buffer.from(chunk).toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

/** Build a mock JSON response. */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Helper to mock globalThis.fetch without needing the `preconnect` property.
 */
function mockFetch(
  fn: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>
): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: (_url: string | URL) => {
      // no-op in tests
    },
  }) as typeof fetch;
}

interface MockDeps {
  setConfigCalls: Array<{ provider: string; keyPath: string[]; value: string }>;
  setConfigResult: Result<void, string>;
  focusCalls: number;
}

function createMockDeps(): MockDeps {
  return {
    setConfigCalls: [],
    setConfigResult: Ok(undefined),
    focusCalls: 0,
  };
}

function createMockProviderService(deps: MockDeps): Pick<ProviderService, "setConfig"> {
  return {
    setConfig: (provider: string, keyPath: string[], value: string): Result<void, string> => {
      deps.setConfigCalls.push({ provider, keyPath, value });
      return deps.setConfigResult;
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

function createService(deps: MockDeps): MuxGatewayOauthService {
  return new MuxGatewayOauthService(
    createMockProviderService(deps) as ProviderService,
    createMockWindowService(deps) as WindowService
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MuxGatewayOauthService", () => {
  let deps: MockDeps;
  let service: MuxGatewayOauthService;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    deps = createMockDeps();
    service = createService(deps);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await service.dispose();
  });

  describe("startDesktopFlow", () => {
    it("returns flowId, authorizeUrl, and redirectUri", async () => {
      const result = await service.startDesktopFlow();
      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.data.flowId).toBeTruthy();
      expect(result.data.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      const authorizeUrl = new URL(result.data.authorizeUrl);
      expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(MUX_GATEWAY_AUTHORIZE_URL);
      expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizeUrl.searchParams.get("state")).toBe(result.data.flowId);
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(result.data.redirectUri);

      await service.cancelDesktopFlow(result.data.flowId);
    });
  });

  describe("desktop callback flow", () => {
    it("callback with code + successful exchange resolves waitFor success and renders success HTML", async () => {
      let capturedUrl = "";
      let capturedBody = "";

      mockFetch((input, init) => {
        capturedUrl = String(input);
        capturedBody =
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : String(init?.body ?? "");
        return jsonResponse({ access_token: "gateway-token" });
      });

      const startResult = await service.startDesktopFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;
      const callbackUrl = `${startResult.data.redirectUri}?state=${flowId}&code=ok-code`;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackResponsePromise = httpGet(callbackUrl);

      const [waitResult, callbackResponse] = await Promise.all([waitPromise, callbackResponsePromise]);

      expect(waitResult).toEqual(Ok(undefined));
      expect(callbackResponse.status).toBe(200);
      expect(callbackResponse.body).toContain("Login complete");

      expect(capturedUrl).toBe(MUX_GATEWAY_EXCHANGE_URL);
      expect(capturedBody).toContain("code=ok-code");

      expect(deps.setConfigCalls).toEqual([
        {
          provider: "mux-gateway",
          keyPath: ["couponCode"],
          value: "gateway-token",
        },
      ]);
      expect(deps.focusCalls).toBe(1);
    });

    it("callback with code + failed exchange resolves waitFor error and renders failure HTML", async () => {
      let releaseExchange: (() => void) | null = null;
      const exchangeStarted = new Promise<void>((resolveStarted) => {
        const exchangeBlocked = new Promise<void>((resolveBlocked) => {
          releaseExchange = resolveBlocked;
        });

        mockFetch(async () => {
          resolveStarted();
          await exchangeBlocked;
          return new Response("upstream exploded", { status: 500 });
        });
      });

      const startResult = await service.startDesktopFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;
      const callbackUrl = `${startResult.data.redirectUri}?state=${flowId}&code=bad-code`;

      const waitPromise = service.waitForDesktopFlow(flowId, { timeoutMs: 5000 });
      const callbackResponsePromise = httpGet(callbackUrl);

      await exchangeStarted;

      const callbackState = await Promise.race([
        callbackResponsePromise.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
      ]);
      expect(callbackState).toBe("pending");

      releaseExchange?.();

      const [waitResult, callbackResponse] = await Promise.all([waitPromise, callbackResponsePromise]);

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("Mux Gateway exchange failed (500)");
      }

      expect(callbackResponse.status).toBe(400);
      expect(callbackResponse.body).toContain("Login failed");
      expect(callbackResponse.body).toContain("Mux Gateway exchange failed (500): upstream exploded");

      expect(deps.setConfigCalls).toHaveLength(0);
      expect(deps.focusCalls).toBe(0);
    });
  });
});
