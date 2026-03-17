import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import * as browserSessionBackendModule from "@/node/services/browserSessionBackend";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import type {
  BrowserInputEvent,
  BrowserSession,
  BrowserSessionEvent,
} from "@/common/types/browserSession";
import { log } from "@/node/services/log";
import { BrowserSessionService } from "@/node/services/browserSessionService";
import { BrowserSessionStreamPortRegistry } from "@/node/services/browserSessionStreamPortRegistry";

type CloseAgentBrowserSession = typeof browserSessionBackendModule.closeAgentBrowserSession;

let mockCloseAgentBrowserSession: Mock<CloseAgentBrowserSession>;

function getPrivateMap<T>(service: BrowserSessionService, fieldName: string): Map<string, T> {
  const value = (service as unknown as Record<string, unknown>)[fieldName];
  expect(value).toBeInstanceOf(Map);
  return value as Map<string, T>;
}

function attachMockBackend(
  workspaceId: string,
  service: BrowserSessionService,
  overrides?: {
    sendInput?: (input: BrowserInputEvent) => { success: boolean; error?: string };
    navigate?: (url: string) => Promise<{ success: boolean; error?: string }>;
  }
) {
  const backend = {
    stop: mock(() => Promise.resolve()),
    sendInput: mock(
      overrides?.sendInput ??
        (() => {
          return { success: true };
        })
    ),
    navigate: mock(
      overrides?.navigate ??
        (() => {
          return Promise.resolve({ success: true });
        })
    ),
  };
  getPrivateMap<{
    stop: typeof backend.stop;
    sendInput: typeof backend.sendInput;
    navigate: typeof backend.navigate;
  }>(service, "activeBackends").set(workspaceId, backend);
  return backend;
}

function createLiveSession(workspaceId: string): BrowserSession {
  const now = new Date().toISOString();
  return {
    id: `mux-${workspaceId}-abcd1234`,
    workspaceId,
    status: "live",
    currentUrl: "https://example.com",
    title: "Example",
    lastScreenshotBase64: null,
    lastError: null,
    streamState: "connecting",
    lastFrameMetadata: null,
    streamErrorMessage: null,
    startedAt: now,
    updatedAt: now,
  };
}

describe("BrowserSessionService.startSession", () => {
  test("reserves a stream port and passes it to the backend", async () => {
    const workspaceId = "workspace-stream-port";
    const streamPortRegistry = new BrowserSessionStreamPortRegistry();
    const createdOptions: browserSessionBackendModule.BrowserSessionBackendOptions[] = [];

    const service = new BrowserSessionService({
      streamPortRegistry,
      createBackend: (options) => {
        createdOptions.push(options);
        return {
          start: mock(() => {
            options.onSessionUpdate(createLiveSession(workspaceId));
            return Promise.resolve(createLiveSession(workspaceId));
          }),
          stop: mock(() => {
            options.onEnded(workspaceId);
            return Promise.resolve();
          }),
        } as unknown as browserSessionBackendModule.BrowserSessionBackend;
      },
    });

    await service.startSession(workspaceId, { initialUrl: "https://example.com" });

    expect(createdOptions).toHaveLength(1);
    expect(createdOptions[0].streamPort).toBe(streamPortRegistry.getReservedPort(workspaceId));
    expect(createdOptions[0].initialUrl).toBe("https://example.com");
    expect(createdOptions[0]).not.toHaveProperty("ownership");
  });
});

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

  test("releases the reserved stream port when a tracked session stops", async () => {
    const workspaceId = "workspace-release-port";
    const streamPortRegistry = new BrowserSessionStreamPortRegistry();
    const service = new BrowserSessionService({ streamPortRegistry });
    const reservedPort = await streamPortRegistry.reservePort(workspaceId);

    const backend = {
      stop: mock(() => {
        expect(streamPortRegistry.isReservedPort(workspaceId, reservedPort)).toBe(true);
        return Promise.resolve();
      }),
    };

    getPrivateMap<{ stop: typeof backend.stop }>(service, "activeBackends").set(
      workspaceId,
      backend
    );

    await service.stopSession(workspaceId);

    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(streamPortRegistry.getReservedPort(workspaceId)).toBeNull();
  });

  test("closes raw CLI sessions even when no tracked backend exists", async () => {
    const service = new BrowserSessionService();
    const workspaceId = "workspace-cli-only";

    await service.stopSession(workspaceId);

    expect(mockCloseAgentBrowserSession).toHaveBeenCalledTimes(1);
    expect(mockCloseAgentBrowserSession).toHaveBeenCalledWith(getMuxBrowserSessionId(workspaceId));
  });

  test("releases reserved ports for raw CLI sessions too", async () => {
    const workspaceId = "workspace-cli-release";
    const streamPortRegistry = new BrowserSessionStreamPortRegistry();
    const service = new BrowserSessionService({ streamPortRegistry });
    await streamPortRegistry.reservePort(workspaceId);

    await service.stopSession(workspaceId);

    expect(streamPortRegistry.getReservedPort(workspaceId)).toBeNull();
  });

  test("emits the cleared stream fields before notifying listeners that the session ended", async () => {
    const workspaceId = "workspace-ended-update";
    const events: BrowserSessionEvent[] = [];
    let backendOptions: browserSessionBackendModule.BrowserSessionBackendOptions | null = null;

    const service = new BrowserSessionService({
      createBackend: (options) => {
        backendOptions = options;
        return {
          start: mock(() => {
            const session = createLiveSession(workspaceId);
            options.onSessionUpdate(session);
            return Promise.resolve(session);
          }),
          stop: mock(() => {
            options.onSessionUpdate({
              ...createLiveSession(workspaceId),
              status: "ended",
              streamState: null,
              lastFrameMetadata: null,
              streamErrorMessage: null,
            });
            options.onEnded(workspaceId);
            return Promise.resolve();
          }),
        } as unknown as browserSessionBackendModule.BrowserSessionBackend;
      },
    });

    service.on(`update:${workspaceId}`, (event: BrowserSessionEvent) => {
      events.push(event);
    });

    await service.startSession(workspaceId);
    expect(backendOptions).not.toBeNull();

    events.length = 0;
    await service.stopSession(workspaceId);

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("session-updated");
    if (events[0]?.type !== "session-updated") {
      expect.unreachable("expected stopSession to emit a session-updated event before ending");
    }
    expect(events[0].session.status).toBe("ended");
    expect(events[0].session.streamState).toBeNull();
    expect(events[0].session.lastFrameMetadata).toBeNull();
    expect(events[0].session.streamErrorMessage).toBeNull();
    expect(events[1]).toEqual({ type: "session-ended", workspaceId });
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

describe("BrowserSessionService.sendInput", () => {
  const workspaceId = "workspace-send-input";
  const mouseClickInput: BrowserInputEvent = {
    kind: "mouse",
    eventType: "mousePressed",
    x: 64,
    y: 96,
    button: "left",
    clickCount: 1,
  };
  const createMouseWheelInput = (
    overrides: Partial<Extract<BrowserInputEvent, { kind: "mouse" }>> = {}
  ): BrowserInputEvent => ({
    kind: "mouse",
    eventType: "mouseWheel",
    x: 64,
    y: 96,
    deltaX: 0,
    deltaY: 24,
    ...overrides,
  });

  test("returns an error when no backend is active", () => {
    const service = new BrowserSessionService();

    expect(service.sendInput(workspaceId, mouseClickInput)).toEqual({
      success: false,
      error: "No active session for workspace",
    });
  });

  test("forwards input to the backend and returns its result", () => {
    const service = new BrowserSessionService();
    const backend = attachMockBackend(workspaceId, service, {
      sendInput: () => ({ success: false, error: "Stream socket is not connected" }),
    });

    const result = service.sendInput(workspaceId, mouseClickInput);

    expect(backend.sendInput).toHaveBeenCalledTimes(1);
    expect(backend.sendInput).toHaveBeenCalledWith(mouseClickInput);
    expect(result).toEqual({ success: false, error: "Stream socket is not connected" });
    expect(service.getRecentActions(workspaceId)).toEqual([]);
  });

  test("logs a coarse click action when a mouse press succeeds", () => {
    const service = new BrowserSessionService();
    attachMockBackend(workspaceId, service);

    const result = service.sendInput(workspaceId, mouseClickInput);
    const recentActions = service.getRecentActions(workspaceId);

    expect(result).toEqual({ success: true });
    expect(recentActions).toHaveLength(1);
    expect(recentActions[0]).toMatchObject({
      type: "click",
      description: "Clicked at (64, 96)",
      metadata: { source: "user-input" },
    });
  });

  test("logs a coarse tap action when a touch start succeeds", () => {
    const service = new BrowserSessionService();
    attachMockBackend(workspaceId, service);

    const result = service.sendInput(workspaceId, {
      kind: "touch",
      eventType: "touchStart",
      touchPoints: [{ x: 10.2, y: 19.8, id: 1 }],
    });
    const recentActions = service.getRecentActions(workspaceId);

    expect(result).toEqual({ success: true });
    expect(recentActions).toHaveLength(1);
    expect(recentActions[0]).toMatchObject({
      type: "click",
      description: "Tapped at (10, 20)",
      metadata: { source: "user-input" },
    });
  });

  test("coalesces repeated scroll ticks into a single readable action", () => {
    const service = new BrowserSessionService();
    attachMockBackend(workspaceId, service);
    const actionEvents: BrowserSessionEvent[] = [];
    service.on(`update:${workspaceId}`, (event: BrowserSessionEvent) => {
      actionEvents.push(event);
    });

    const firstResult = service.sendInput(workspaceId, createMouseWheelInput({ deltaY: 18 }));
    const secondResult = service.sendInput(workspaceId, createMouseWheelInput({ deltaY: 32 }));
    const recentActions = service.getRecentActions(workspaceId);

    expect(firstResult).toEqual({ success: true });
    expect(secondResult).toEqual({ success: true });
    expect(recentActions).toHaveLength(1);
    expect(recentActions[0]).toMatchObject({
      type: "custom",
      description: "Scrolled down ×2",
      metadata: {
        source: "user-input",
        inputKind: "scroll",
        scrollDirection: "down",
        scrollCount: 2,
      },
    });

    const scrollActionEvents = actionEvents.filter(
      (event): event is Extract<BrowserSessionEvent, { type: "action" }> => event.type === "action"
    );
    expect(scrollActionEvents).toHaveLength(2);
    expect(scrollActionEvents[0]?.action.description).toBe("Scrolled down");
    expect(scrollActionEvents[1]?.action.description).toBe("Scrolled down ×2");
    expect(scrollActionEvents[1]?.action.id).toBe(scrollActionEvents[0]?.action.id);
  });

  test("ignores tiny scroll jitter so it does not crowd out meaningful actions", () => {
    const service = new BrowserSessionService();
    attachMockBackend(workspaceId, service);

    const result = service.sendInput(workspaceId, createMouseWheelInput({ deltaX: 1, deltaY: -1 }));

    expect(result).toEqual({ success: true });
    expect(service.getRecentActions(workspaceId)).toEqual([]);
  });

  test("does not log keyboard inputs", () => {
    const service = new BrowserSessionService();
    attachMockBackend(workspaceId, service);

    const result = service.sendInput(workspaceId, {
      kind: "keyboard",
      eventType: "keyDown",
      key: "a",
      code: "KeyA",
      text: "a",
    });

    expect(result).toEqual({ success: true });
    expect(service.getRecentActions(workspaceId)).toEqual([]);
  });
});

describe("BrowserSessionService.navigate", () => {
  const workspaceId = "workspace-navigate";

  test("returns an error when no backend is active", async () => {
    const service = new BrowserSessionService();

    const result = await service.navigate(workspaceId, "https://example.com");

    expect(result).toEqual({
      success: false,
      error: "No active session for workspace",
    });
  });

  test("delegates navigation to the active backend", async () => {
    const service = new BrowserSessionService();
    const backend = attachMockBackend(workspaceId, service, {
      navigate: (url) => Promise.resolve({ success: false, error: `failed to open ${url}` }),
    });

    const result = await service.navigate(workspaceId, "example.com");

    expect(backend.navigate).toHaveBeenCalledTimes(1);
    expect(backend.navigate).toHaveBeenCalledWith("example.com");
    expect(result).toEqual({ success: false, error: "failed to open example.com" });
  });
});
