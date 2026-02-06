import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { CopilotOauthService } from "./copilotOauthService";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a mock fetch Response with JSON body. */
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Standard device code response from GitHub. */
function deviceCodeResponse(overrides?: Record<string, unknown>): Response {
  return jsonResponse({
    verification_uri: "https://github.com/login/device",
    user_code: "ABCD-1234",
    device_code: "dc_test_123",
    interval: 0,
    ...overrides,
  });
}

/** Token success response. */
function tokenSuccessResponse(token = "ghp_test_token"): Response {
  return jsonResponse({ access_token: token });
}

/** Polling "not yet" response. */
function authorizationPendingResponse(): Response {
  return jsonResponse({ error: "authorization_pending" });
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
// Mock dependencies
// ---------------------------------------------------------------------------

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

function createService(deps: MockDeps): CopilotOauthService {
  return new CopilotOauthService(
    createMockProviderService(deps) as ProviderService,
    createMockWindowService(deps) as WindowService
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CopilotOauthService", () => {
  let deps: MockDeps;
  let service: CopilotOauthService;
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
  // startDeviceFlow
  // -------------------------------------------------------------------------

  describe("startDeviceFlow", () => {
    it("returns flowId, verificationUri, and userCode on success", async () => {
      mockFetch(async () => deviceCodeResponse());

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.flowId).toBeTruthy();
        expect(result.data.verificationUri).toBe("https://github.com/login/device");
        expect(result.data.userCode).toBe("ABCD-1234");
      }
    });

    it("sends request to github.com device code endpoint", async () => {
      let capturedUrl = "";
      mockFetch(async (input) => {
        capturedUrl = String(input);
        return deviceCodeResponse();
      });

      await service.startDeviceFlow();
      expect(capturedUrl).toBe("https://github.com/login/device/code");
    });

    it("returns Err when fetch response is not ok", async () => {
      mockFetch(async () => new Response("Server Error", { status: 500 }));

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("500");
      }
    });

    it("returns Err when fetch throws a network error", async () => {
      mockFetch(async () => {
        throw new Error("DNS resolution failed");
      });

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("DNS resolution failed");
      }
    });

    it("returns Err when response is missing required fields", async () => {
      mockFetch(async () => jsonResponse({ verification_uri: "https://example.com" }));

      const result = await service.startDeviceFlow();
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Invalid response");
      }
    });

    it("each flow gets a unique flowId", async () => {
      mockFetch(async () => deviceCodeResponse());

      const first = await service.startDeviceFlow();
      const second = await service.startDeviceFlow();
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      if (first.success && second.success) {
        expect(first.data.flowId).not.toBe(second.data.flowId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: poll → success
  // -------------------------------------------------------------------------

  describe("happy path: poll → success", () => {
    it("polls until access_token is returned, then persists it", async () => {
      // startDeviceFlow fetch
      let pollCount = 0;
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        // Polling endpoint
        pollCount++;
        if (pollCount === 1) {
          return authorizationPendingResponse();
        }
        return tokenSuccessResponse("ghp_final_token");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      expect(waitResult.success).toBe(true);

      // Verify token was persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall!.value).toBe("ghp_final_token");
    });

    it("calls focusMainWindow after successful auth", async () => {
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      await service.waitForDeviceFlow(startResult.data.flowId, { timeoutMs: 10_000 });

      expect(deps.focusCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // slow_down response
  // -------------------------------------------------------------------------

  describe("slow_down response", () => {
    it("respects slow_down and eventually succeeds", async () => {
      let pollCount = 0;
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        pollCount++;
        if (pollCount === 1) {
          // slow_down: service should increase interval but continue
          return jsonResponse({ error: "slow_down", interval: 0 });
        }
        return tokenSuccessResponse("ghp_slow_token");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      expect(waitResult.success).toBe(true);

      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall!.value).toBe("ghp_slow_token");
    });
  });

  // -------------------------------------------------------------------------
  // Terminal error
  // -------------------------------------------------------------------------

  describe("terminal error", () => {
    it("resolves with Err on access_denied", async () => {
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return jsonResponse({ error: "access_denied" });
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("access_denied");
      }

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });

    it("resolves with Err on expired_token", async () => {
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return jsonResponse({ error: "expired_token" });
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("expired_token");
      }
    });
  });

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  describe("cancellation", () => {
    it("resolves waitForDeviceFlow with error when cancelled", async () => {
      // Make polling hang indefinitely with authorization_pending
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return authorizationPendingResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;

      // Start waiting (don't await yet)
      const waitPromise = service.waitForDeviceFlow(flowId, { timeoutMs: 30_000 });

      // Give polling loop a tick to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cancel the flow
      service.cancelDeviceFlow(flowId);

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("cancelled");
      }

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });

    it("does not persist token if cancelled mid-request", async () => {
      // Control when the polling fetch resolves
      let resolvePollFetch!: (res: Response) => void;

      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        // Hang the polling request until we resolve it manually
        return new Promise<Response>((resolve) => {
          resolvePollFetch = resolve;
        });
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;
      const waitPromise = service.waitForDeviceFlow(flowId, { timeoutMs: 30_000 });

      // Give polling loop a tick to start the fetch
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Cancel while fetch is in-flight
      service.cancelDeviceFlow(flowId);

      // Now resolve the fetch with a valid token — it should be ignored
      // because flow.cancelled is checked after fetch returns
      resolvePollFetch(tokenSuccessResponse("ghp_should_not_persist"));

      const result = await waitPromise;
      expect(result.success).toBe(false);

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Transient network error recovery
  // -------------------------------------------------------------------------

  describe("transient network error recovery", () => {
    it("retries after a transient fetch error and eventually succeeds", async () => {
      let pollCount = 0;
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        pollCount++;
        if (pollCount === 1) {
          throw new Error("ECONNRESET");
        }
        return tokenSuccessResponse("ghp_recovered");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      expect(waitResult.success).toBe(true);

      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall!.value).toBe("ghp_recovered");
    });
  });

  // -------------------------------------------------------------------------
  // Re-entrancy guard
  // -------------------------------------------------------------------------

  describe("re-entrancy guard", () => {
    it("only starts one polling loop even when waitForDeviceFlow is called twice", async () => {
      let pollCallCount = 0;
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        pollCallCount++;
        return tokenSuccessResponse("ghp_single_poll");
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const flowId = startResult.data.flowId;

      // Call waitForDeviceFlow twice concurrently
      const [result1, result2] = await Promise.all([
        service.waitForDeviceFlow(flowId, { timeoutMs: 10_000 }),
        service.waitForDeviceFlow(flowId, { timeoutMs: 10_000 }),
      ]);

      // Both should succeed
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Only one polling request should have been made (one poll loop)
      expect(pollCallCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Enterprise URL normalization
  // -------------------------------------------------------------------------

  describe("enterprise URL normalization", () => {
    it("uses enterprise domain in device code URL", async () => {
      let capturedUrl = "";
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          capturedUrl = url;
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      await service.startDeviceFlow({ enterpriseUrl: "https://github.myco.com/" });
      expect(capturedUrl).toBe("https://github.myco.com/login/device/code");
    });

    it("extracts hostname from URL with path", async () => {
      let capturedUrl = "";
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          capturedUrl = url;
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      await service.startDeviceFlow({ enterpriseUrl: "github.myco.com/path/" });
      expect(capturedUrl).toBe("https://github.myco.com/login/device/code");
    });

    it("handles URL with no protocol prefix", async () => {
      let capturedUrl = "";
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          capturedUrl = url;
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      await service.startDeviceFlow({ enterpriseUrl: "github.myco.com" });
      expect(capturedUrl).toBe("https://github.myco.com/login/device/code");
    });

    it("safely normalizes URLs with user info", async () => {
      // URL("https://evil.com@attacker.com") → hostname is "attacker.com"
      // This tests that we use URL parsing (which extracts hostname correctly)
      let capturedUrl = "";
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          capturedUrl = url;
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      await service.startDeviceFlow({ enterpriseUrl: "https://evil.com@attacker.com" });
      // URL parser treats "evil.com" as userinfo, "attacker.com" as hostname
      expect(capturedUrl).toBe("https://attacker.com/login/device/code");
    });
  });

  // -------------------------------------------------------------------------
  // Enterprise domain persistence
  // -------------------------------------------------------------------------

  describe("enterprise domain persistence", () => {
    it("persists enterprise domain after successful auth", async () => {
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow({
        enterpriseUrl: "https://github.myco.com/",
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });
      expect(waitResult.success).toBe(true);

      const domainCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "enterpriseDomain"
      );
      expect(domainCall).toBeDefined();
      expect(domainCall!.value).toBe("github.myco.com");
    });

    it("clears enterprise domain after successful auth with github.com", async () => {
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });
      expect(waitResult.success).toBe(true);

      const domainCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "enterpriseDomain"
      );
      expect(domainCall).toBeDefined();
      expect(domainCall!.value).toBe("");
    });

    it("uses enterprise domain for polling URL", async () => {
      let pollingUrl = "";
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        if (url.includes("/login/oauth/access_token")) {
          pollingUrl = url;
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow({
        enterpriseUrl: "https://github.myco.com/",
      });
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      await service.waitForDeviceFlow(startResult.data.flowId, { timeoutMs: 10_000 });

      expect(pollingUrl).toBe("https://github.myco.com/login/oauth/access_token");
    });
  });

  // -------------------------------------------------------------------------
  // Dispose cleanup
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    it("resolves pending waitForDeviceFlow with error", async () => {
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        // Never return a token — keep it pending
        return authorizationPendingResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitPromise = service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 30_000,
      });

      // Give polling loop a tick to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Dispose the service
      await service.dispose();

      const result = await waitPromise;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("shutting down");
      }

      // Token should NOT have been persisted
      const apiKeyCall = deps.setConfigCalls.find(
        (c) => c.provider === "github-copilot" && c.keyPath[0] === "apiKey"
      );
      expect(apiKeyCall).toBeUndefined();
    });

    it("clears all flows from the map", async () => {
      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return authorizationPendingResponse();
      });

      // Start two flows
      const flow1 = await service.startDeviceFlow();
      const flow2 = await service.startDeviceFlow();
      expect(flow1.success).toBe(true);
      expect(flow2.success).toBe(true);

      await service.dispose();

      // After dispose, waitForDeviceFlow should return "not found"
      if (flow1.success) {
        const result = await service.waitForDeviceFlow(flow1.data.flowId);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("not found");
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // setConfig failure
  // -------------------------------------------------------------------------

  describe("setConfig failure", () => {
    it("propagates setConfig error to waitForDeviceFlow result", async () => {
      deps.setConfigResult = Err("disk full");

      mockFetch(async (input) => {
        const url = String(input);
        if (url.includes("/login/device/code")) {
          return deviceCodeResponse();
        }
        return tokenSuccessResponse();
      });

      const startResult = await service.startDeviceFlow();
      expect(startResult.success).toBe(true);
      if (!startResult.success) return;

      const waitResult = await service.waitForDeviceFlow(startResult.data.flowId, {
        timeoutMs: 10_000,
      });

      expect(waitResult.success).toBe(false);
      if (!waitResult.success) {
        expect(waitResult.error).toContain("disk full");
      }
    });
  });

  // -------------------------------------------------------------------------
  // waitForDeviceFlow edge cases
  // -------------------------------------------------------------------------

  describe("waitForDeviceFlow edge cases", () => {
    it("returns Err for unknown flowId", async () => {
      const result = await service.waitForDeviceFlow("nonexistent-flow-id");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("not found");
      }
    });

    it("cancelDeviceFlow is a no-op for unknown flowId", () => {
      // Should not throw
      service.cancelDeviceFlow("nonexistent-flow-id");
    });
  });
});
