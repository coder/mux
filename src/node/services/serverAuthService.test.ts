import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Config } from "@/node/config";
import { ServerAuthService, SERVER_AUTH_SESSION_MAX_AGE_SECONDS } from "./serverAuthService";

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
  let createdServices: ServerAuthService[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-server-auth-test-"));
    config = new Config(tempDir);
    createdServices = [];

    await config.editConfig((cfg) => {
      cfg.serverAuthGithubOwner = "octocat";
      return cfg;
    });
  });

  afterEach(() => {
    for (const service of createdServices) {
      service.dispose();
    }

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

  function createService(configOverride?: Config): ServerAuthService {
    const service = new ServerAuthService(configOverride ?? config);
    createdServices.push(service);
    return service;
  }

  it("creates and validates a session after successful GitHub device-flow login", async () => {
    const service = createService(config);

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
    const service = createService(config);

    const session = await createSessionViaGithubDeviceFlow(service);

    const removed = await service.revokeSession(session.sessionId);
    expect(removed).toBe(true);

    const validation = await service.validateSessionToken(session.sessionToken);
    expect(validation).toBeNull();
  });

  it("revokeOtherSessions keeps only the current session", async () => {
    const service = createService(config);

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

  it("revokeOtherSessions preserves sessions when current session id is missing", async () => {
    const service = createService(config);

    const sessionA = await createSessionViaGithubDeviceFlow(service);
    const sessionB = await createSessionViaGithubDeviceFlow(service);

    const revokedCount = await service.revokeOtherSessions("missing-session-id");
    expect(revokedCount).toBe(0);

    const sessions = await service.listSessions(null);
    expect(sessions).toHaveLength(2);

    const sessionAValidation = await service.validateSessionToken(sessionA.sessionToken);
    expect(sessionAValidation).toEqual({ sessionId: sessionA.sessionId });

    const sessionBValidation = await service.validateSessionToken(sessionB.sessionToken);
    expect(sessionBValidation).toEqual({ sessionId: sessionB.sessionId });
  });

  it("rejects expired sessions during validation", async () => {
    const service = createService(config);
    const session = await createSessionViaGithubDeviceFlow(service);

    const sessionsPath = path.join(tempDir, "serverAuthSessions.json");
    const persisted = JSON.parse(await fs.promises.readFile(sessionsPath, "utf-8")) as {
      sessions?: Array<{ id?: string; createdAtMs?: number }>;
    };
    const persistedSession = persisted.sessions?.find(
      (candidate) => candidate.id === session.sessionId
    );
    expect(persistedSession).toBeTruthy();
    if (!persistedSession) {
      throw new Error("Expected persisted session after creation");
    }

    persistedSession.createdAtMs =
      Date.now() - (SERVER_AUTH_SESSION_MAX_AGE_SECONDS * 1000 + 1_000);
    await fs.promises.writeFile(sessionsPath, JSON.stringify(persisted, null, 2), "utf-8");

    const validation = await service.validateSessionToken(session.sessionToken);
    expect(validation).toBeNull();

    const sessions = await service.listSessions(null);
    expect(sessions.some((candidate) => candidate.id === session.sessionId)).toBe(false);
  });

  it("treats session metadata persistence failures as non-fatal", async () => {
    const service = createService(config);
    const session = await createSessionViaGithubDeviceFlow(service);

    const saveSpy = spyOn(
      service as unknown as {
        savePersistedSessionsLocked: (data: unknown) => Promise<void>;
      },
      "savePersistedSessionsLocked"
    ).mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    const validation = await service.validateSessionToken(session.sessionToken, {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/125.0.0.0 Safari/537.36",
      ipAddress: "203.0.113.77",
    });

    expect(saveSpy).toHaveBeenCalled();
    expect(validation).toEqual({ sessionId: session.sessionId });
  });

  it("returns an error when GitHub owner login is not configured", async () => {
    const unconfigured = new Config(path.join(tempDir, "unconfigured"));
    const service = createService(unconfigured);

    const result = await service.startGithubDeviceFlow();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not configured");
    }
  });

  it("rejects GitHub users that do not match the configured owner", async () => {
    const service = createService(config);

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

  it("caps outstanding GitHub device-flow starts to limit unauthenticated load", async () => {
    const service = createService(config);

    let deviceCodeRequests = 0;
    mockFetch((input) => {
      const url = String(input);

      if (url.endsWith("/login/device/code")) {
        deviceCodeRequests += 1;
        return jsonResponse({
          verification_uri: "https://github.com/login/device",
          user_code: `CODE-${deviceCodeRequests}`,
          device_code: `device-code-${deviceCodeRequests}`,
          interval: 5,
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const attempts = 40;
    let successCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < attempts; i += 1) {
      const result = await service.startGithubDeviceFlow();
      if (result.success) {
        successCount += 1;
      } else {
        rejectedCount += 1;
        expect(result.error).toContain("Too many concurrent GitHub login attempts");
      }
    }

    expect(successCount).toBeLessThan(attempts);
    expect(rejectedCount).toBeGreaterThan(0);
    expect(deviceCodeRequests).toBe(successCount);
  });

  it("keeps throttling start requests after flows are canceled", async () => {
    const service = createService(config);

    let deviceCodeRequests = 0;
    mockFetch((input) => {
      const url = String(input);

      if (url.endsWith("/login/device/code")) {
        deviceCodeRequests += 1;
        return jsonResponse({
          verification_uri: "https://github.com/login/device",
          user_code: `CANCEL-${deviceCodeRequests}`,
          device_code: `cancel-device-code-${deviceCodeRequests}`,
          interval: 5,
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const attempts = 40;
    let successCount = 0;
    let rejectedCount = 0;

    for (let i = 0; i < attempts; i += 1) {
      const result = await service.startGithubDeviceFlow();
      if (result.success) {
        successCount += 1;
        service.cancelGithubDeviceFlow(result.data.flowId);
      } else {
        rejectedCount += 1;
        expect(result.error).toContain("Too many concurrent GitHub login attempts");
      }
    }

    expect(successCount).toBeLessThan(attempts);
    expect(rejectedCount).toBeGreaterThan(0);
  });

  it("does not persist orphan sessions when a device flow is canceled while polling", async () => {
    const service = createService(config);

    mockFetch(async (input) => {
      const url = String(input);

      if (url.endsWith("/login/device/code")) {
        return jsonResponse({
          verification_uri: "https://github.com/login/device",
          user_code: "ABCD-1234",
          device_code: "device-code-timeout",
          interval: 0,
        });
      }

      if (url.endsWith("/login/oauth/access_token")) {
        return jsonResponse({
          access_token: "gho_test_access_token",
        });
      }

      if (url === "https://api.github.com/user") {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return jsonResponse({
          login: "octocat",
        });
      }

      return new Response("Not found", { status: 404 });
    });

    const startResult = await service.startGithubDeviceFlow();
    expect(startResult.success).toBe(true);
    if (!startResult.success) {
      throw new Error(`startGithubDeviceFlow failed: ${startResult.error}`);
    }

    const waitResult = await service.waitForGithubDeviceFlow(startResult.data.flowId, {
      timeoutMs: 1,
    });
    expect(waitResult.success).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 75));

    const sessions = await service.listSessions(null);
    expect(sessions).toHaveLength(0);
  });
});
