import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { ServerAuthService } from "./serverAuthService";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function mockFetch(
  fn: (input: string | URL, init?: RequestInit) => Response | Promise<Response>
): void {
  globalThis.fetch = Object.assign(fn, {
    preconnect: (_url: string | URL) => {
      // no-op in tests
    },
  }) as typeof fetch;
}

function setMockFetchForSuccessfulGithubLogin(login = "octocat"): void {
  mockFetch((input) => {
    const url = String(input);

    if (url.endsWith("/login/device/code")) {
      return jsonResponse({
        verification_uri: "https://github.com/login/device",
        user_code: "ABCD-1234",
        device_code: "device-code-123",
        interval: 0,
      });
    }

    if (url.endsWith("/login/oauth/access_token")) {
      return jsonResponse({
        access_token: "gho_test_access_token",
      });
    }

    if (url === "https://api.github.com/user") {
      return jsonResponse({
        login,
      });
    }

    return new Response("Not found", { status: 404 });
  });
}

describe("ServerAuthService", () => {
  const originalFetch = globalThis.fetch;

  let tempDir: string;
  let config: Config;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-server-auth-test-"));
    config = new Config(tempDir);

    await config.editConfig((cfg) => {
      cfg.serverAuthGithubOwner = "octocat";
      return cfg;
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function createSessionViaGithubDeviceFlow(
    service: ServerAuthService,
    opts?: { userAgent?: string; ipAddress?: string }
  ): Promise<{ sessionId: string; sessionToken: string }> {
    setMockFetchForSuccessfulGithubLogin();

    const startResult = await service.startGithubDeviceFlow();
    expect(startResult.success).toBe(true);
    if (!startResult.success) {
      throw new Error(`startGithubDeviceFlow failed: ${startResult.error}`);
    }

    const waitResult = await service.waitForGithubDeviceFlow(startResult.data.flowId, {
      userAgent: opts?.userAgent,
      ipAddress: opts?.ipAddress,
    });

    expect(waitResult.success).toBe(true);
    if (!waitResult.success) {
      throw new Error(`waitForGithubDeviceFlow failed: ${waitResult.error}`);
    }

    return waitResult.data;
  }

  it("creates and validates a session after successful GitHub device-flow login", async () => {
    const service = new ServerAuthService(config);

    const session = await createSessionViaGithubDeviceFlow(service, {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      ipAddress: "203.0.113.55",
    });

    const validation = await service.validateSessionToken(session.sessionToken, {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
      ipAddress: "203.0.113.55",
    });

    expect(validation).toEqual({ sessionId: session.sessionId });

    const sessions = await service.listSessions(session.sessionId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(session.sessionId);
    expect(sessions[0]?.isCurrent).toBe(true);
    expect(sessions[0]?.label).toContain("Chrome");
  });

  it("revokes a session and rejects the token afterward", async () => {
    const service = new ServerAuthService(config);

    const session = await createSessionViaGithubDeviceFlow(service);

    const removed = await service.revokeSession(session.sessionId);
    expect(removed).toBe(true);

    const validation = await service.validateSessionToken(session.sessionToken);
    expect(validation).toBeNull();
  });

  it("revokeOtherSessions keeps only the current session", async () => {
    const service = new ServerAuthService(config);

    const sessionA = await createSessionViaGithubDeviceFlow(service);
    const sessionB = await createSessionViaGithubDeviceFlow(service);

    const revokedCount = await service.revokeOtherSessions(sessionB.sessionId);
    expect(revokedCount).toBeGreaterThanOrEqual(1);

    const sessions = await service.listSessions(sessionB.sessionId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(sessionB.sessionId);

    const sessionAValidation = await service.validateSessionToken(sessionA.sessionToken);
    expect(sessionAValidation).toBeNull();

    const sessionBValidation = await service.validateSessionToken(sessionB.sessionToken);
    expect(sessionBValidation).toEqual({ sessionId: sessionB.sessionId });
  });

  it("returns an error when GitHub owner login is not configured", async () => {
    const unconfigured = new Config(path.join(tempDir, "unconfigured"));
    const service = new ServerAuthService(unconfigured);

    const result = await service.startGithubDeviceFlow();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not configured");
    }
  });

  it("rejects GitHub users that do not match the configured owner", async () => {
    const service = new ServerAuthService(config);

    setMockFetchForSuccessfulGithubLogin("somebody-else");

    const startResult = await service.startGithubDeviceFlow();
    expect(startResult.success).toBe(true);
    if (!startResult.success) {
      throw new Error(`startGithubDeviceFlow failed: ${startResult.error}`);
    }

    const waitResult = await service.waitForGithubDeviceFlow(startResult.data.flowId);
    expect(waitResult.success).toBe(false);
    if (!waitResult.success) {
      expect(waitResult.error).toContain("not authorized");
    }
  });
});
