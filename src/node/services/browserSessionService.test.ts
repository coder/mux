import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import * as browserSessionBackendModule from "@/node/services/browserSessionBackend";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import { log } from "@/node/services/log";
import { BrowserSessionService } from "@/node/services/browserSessionService";

type CloseAgentBrowserSession = typeof browserSessionBackendModule.closeAgentBrowserSession;

let mockCloseAgentBrowserSession: Mock<CloseAgentBrowserSession>;

function getPrivateMap<T>(service: BrowserSessionService, fieldName: string): Map<string, T> {
  const value = (service as unknown as Record<string, unknown>)[fieldName];
  expect(value).toBeInstanceOf(Map);
  return value as Map<string, T>;
}

function attachMockBackend(workspaceId: string, service: BrowserSessionService) {
  const backend = {
    stop: mock(() => Promise.resolve()),
  };
  getPrivateMap<{ stop: typeof backend.stop }>(service, "activeBackends").set(workspaceId, backend);
  return backend;
}

describe("BrowserSessionService.stopSession", () => {
  beforeEach(() => {
    mockCloseAgentBrowserSession = spyOn(
      browserSessionBackendModule,
      "closeAgentBrowserSession"
    ).mockImplementation(() => Promise.resolve({ success: true }));
  });

  afterEach(() => {
    mock.restore();
  });

  test("stops a tracked backend without issuing a redundant standalone close", async () => {
    const service = new BrowserSessionService();
    const workspaceId = "workspace-123";
    const backend = attachMockBackend(workspaceId, service);

    await service.stopSession(workspaceId);

    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(mockCloseAgentBrowserSession).not.toHaveBeenCalled();
  });

  test("closes raw CLI sessions even when no tracked backend exists", async () => {
    const service = new BrowserSessionService();
    const workspaceId = "workspace-cli-only";

    await service.stopSession(workspaceId);

    expect(mockCloseAgentBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseAgentBrowserSession).toHaveBeenCalledWith(getMuxBrowserSessionId(workspaceId));
  });

  test("logs close failures without throwing", async () => {
    const service = new BrowserSessionService();
    const workspaceId = "workspace-close-failure";
    const sessionId = getMuxBrowserSessionId(workspaceId);
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    mockCloseAgentBrowserSession.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "close failed" })
    );

    await service.stopSession(workspaceId);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      `Failed to close browser session ${sessionId}: close failed`
    );
  });

  test("clears recentActions and startPromises during stop", async () => {
    const service = new BrowserSessionService();
    const workspaceId = "workspace-cleanup";
    const recentActions = getPrivateMap<unknown[]>(service, "recentActions");
    const startPromises = getPrivateMap<Promise<unknown>>(service, "startPromises");

    recentActions.set(workspaceId, [{ type: "click" }]);
    startPromises.set(workspaceId, Promise.resolve({}));

    await service.stopSession(workspaceId);

    expect(recentActions.has(workspaceId)).toBe(false);
    expect(startPromises.has(workspaceId)).toBe(false);
  });

  test("is safe to call repeatedly", async () => {
    const service = new BrowserSessionService();
    const workspaceId = "workspace-repeat";

    await service.stopSession(workspaceId);
    await service.stopSession(workspaceId);

    expect(mockCloseAgentBrowserSession).toHaveBeenCalledTimes(2);
    expect(mockCloseAgentBrowserSession).toHaveBeenNthCalledWith(
      1,
      getMuxBrowserSessionId(workspaceId)
    );
    expect(mockCloseAgentBrowserSession).toHaveBeenNthCalledWith(
      2,
      getMuxBrowserSessionId(workspaceId)
    );
  });

  test("asserts on an empty workspace id", async () => {
    const service = new BrowserSessionService();

    try {
      await service.stopSession("   ");
      expect.unreachable("stopSession should reject empty workspace ids");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe("BrowserSessionService.stopSession requires a workspaceId");
      }
    }
    expect(mockCloseAgentBrowserSession).not.toHaveBeenCalled();
  });
});
