import { afterEach, beforeEach, describe, expect, mock, spyOn, test, type Mock } from "bun:test";
import * as browserSessionBackendModule from "@/node/services/browserSessionBackend";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import type {
  BrowserAction,
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
    endReason: null,
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

  test("retries once with a clean relaunch when stale attach metadata leaves the stream restart_required", async () => {
    const workspaceId = "workspace-reattach";
    let reservedPort: number | null = null;
    let knownPort: number | null = 9223;
    const streamPortRegistry = {
      reservePort: mock(() => {
        reservedPort = knownPort ?? 9333;
        return Promise.resolve(reservedPort);
      }),
      releasePort: mock(() => {
        reservedPort = null;
        knownPort = null;
      }),
      isReservedPort: mock((_workspaceId: string, port: number) => reservedPort === port),
      getKnownPort: mock(() => reservedPort ?? knownPort),
    };
    const createdOptions: browserSessionBackendModule.BrowserSessionBackendOptions[] = [];
    const stopMocks: Array<ReturnType<typeof mock>> = [];
    let startCount = 0;

    const service = new BrowserSessionService({
      streamPortRegistry,
      createBackend: (options) => {
        createdOptions.push(options);
        startCount += 1;
        if (startCount === 1) {
          const stop = mock(() => {
            options.onEnded(workspaceId);
            return Promise.resolve();
          });
          stopMocks.push(stop);
          return {
            start: mock(() => {
              const session = {
                ...createLiveSession(workspaceId),
                currentUrl: "https://attached.example.com",
                title: "Attached page",
                streamState: "restart_required" as const,
                streamErrorMessage: "connect ECONNREFUSED 127.0.0.1:9223",
                lastError: "connect ECONNREFUSED 127.0.0.1:9223",
              };
              options.onSessionUpdate(session);
              return Promise.resolve(session);
            }),
            stop,
          } as unknown as browserSessionBackendModule.BrowserSessionBackend;
        }

        return {
          start: mock(() => {
            const session = {
              ...createLiveSession(workspaceId),
              currentUrl: "https://attached.example.com",
              title: "Attached page",
              streamState: "live" as const,
              streamErrorMessage: null,
              lastError: null,
            };
            options.onSessionUpdate(session);
            return Promise.resolve(session);
          }),
          stop: mock(() => {
            options.onEnded(workspaceId);
            return Promise.resolve();
          }),
        } as unknown as browserSessionBackendModule.BrowserSessionBackend;
      },
    });

    const session = await service.startSession(workspaceId, {
      initialUrl: "https://start.example.com",
    });

    expect(createdOptions).toHaveLength(2);
    expect(createdOptions[0]?.streamPort).toBe(9223);
    expect(createdOptions[0]?.initialUrl).toBe("https://start.example.com");
    expect(createdOptions[1]?.streamPort).toBe(9333);
    expect(createdOptions[1]?.initialUrl).toBe("https://attached.example.com");
    expect(stopMocks[0]).toHaveBeenCalledTimes(1);
    expect(session.streamState).toBe("live");
    expect(session.currentUrl).toBe("https://attached.example.com");
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
              endReason: "agent_closed",
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
    expect(events[0].session.endReason).toBe("agent_closed");
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

describe("BrowserSessionService navigate action coalescing", () => {
  const workspaceId = "workspace-navigate-coalescing";

  function createNavigateAction(
    overrides: Partial<BrowserAction> & { metadata?: Record<string, unknown> } = {}
  ): BrowserAction {
    const metadata = {
      previousUrl: null,
      currentUrl: "https://example.com/dashboard",
      previousTitle: null,
      title: "Dashboard",
      ...(overrides.metadata ?? {}),
    };

    return {
      id: "navigate-action-1",
      type: "navigate",
      description: "Dashboard",
      timestamp: "2026-03-16T00:00:00.000Z",
      ...overrides,
      metadata,
    };
  }

  function createClickAction(overrides: Partial<BrowserAction> = {}): BrowserAction {
    return {
      id: "click-action-1",
      type: "click",
      description: "Clicked submit",
      timestamp: "2026-03-16T00:00:00.000Z",
      metadata: {
        source: "user-input",
      },
      ...overrides,
    };
  }

  async function startServiceWithActionCapture(): Promise<{
    service: BrowserSessionService;
    emitAction: (action: BrowserAction) => void;
  }> {
    let backendOptions: browserSessionBackendModule.BrowserSessionBackendOptions | null = null;

    const service = new BrowserSessionService({
      createBackend: (options) => {
        backendOptions = options;
        return {
          start: mock(() => Promise.resolve(createLiveSession(workspaceId))),
          stop: mock(() => Promise.resolve()),
          sendInput: mock(() => ({ success: true })),
          navigate: mock(() => Promise.resolve({ success: true })),
        } as unknown as browserSessionBackendModule.BrowserSessionBackend;
      },
    });

    await service.startSession(workspaceId);
    expect(backendOptions).not.toBeNull();

    return {
      service,
      emitAction: (action) => {
        expect(backendOptions).not.toBeNull();
        backendOptions!.onAction(action);
      },
    };
  }

  test("coalesces same-url navigate actions within 2 seconds and keeps the latest metadata", async () => {
    const { service, emitAction } = await startServiceWithActionCapture();
    const actionEvents: BrowserSessionEvent[] = [];
    service.on(`update:${workspaceId}`, (event: BrowserSessionEvent) => {
      actionEvents.push(event);
    });

    const firstAction = createNavigateAction({
      id: "navigate-action-1",
      description: "Dashboard",
      timestamp: "2026-03-16T00:00:00.000Z",
      metadata: {
        currentUrl: "https://example.com/dashboard",
        title: "Dashboard",
      },
    });
    const secondAction = createNavigateAction({
      id: "navigate-action-2",
      description: "Project dashboard",
      timestamp: "2026-03-16T00:00:01.500Z",
      metadata: {
        previousUrl: "https://example.com/login",
        currentUrl: "https://example.com/dashboard",
        previousTitle: "Log in",
        title: "Project dashboard",
      },
    });

    emitAction(firstAction);
    emitAction(secondAction);

    const recentActions = service.getRecentActions(workspaceId);
    expect(recentActions).toHaveLength(1);
    expect(recentActions[0]).toMatchObject({
      id: firstAction.id,
      type: "navigate",
      description: "Project dashboard",
      timestamp: secondAction.timestamp,
      metadata: {
        previousUrl: "https://example.com/login",
        currentUrl: "https://example.com/dashboard",
        previousTitle: "Log in",
        title: "Project dashboard",
        navigateCount: 2,
      },
    });

    const navigateActionEvents = actionEvents.filter(
      (event): event is Extract<BrowserSessionEvent, { type: "action" }> => event.type === "action"
    );
    expect(navigateActionEvents).toHaveLength(2);
    expect(navigateActionEvents[0]?.action.id).toBe(firstAction.id);
    expect(navigateActionEvents[1]?.action.id).toBe(firstAction.id);
    expect(navigateActionEvents[1]?.action.metadata).toMatchObject({ navigateCount: 2 });
  });

  test("does not coalesce same-url navigate actions when they are more than 2 seconds apart", async () => {
    const { service, emitAction } = await startServiceWithActionCapture();

    emitAction(
      createNavigateAction({
        id: "navigate-action-1",
        timestamp: "2026-03-16T00:00:00.000Z",
      })
    );
    emitAction(
      createNavigateAction({
        id: "navigate-action-2",
        timestamp: "2026-03-16T00:00:02.100Z",
      })
    );

    const recentActions = service.getRecentActions(workspaceId);
    expect(recentActions).toHaveLength(2);
    expect(recentActions[0]?.metadata).not.toHaveProperty("navigateCount");
    expect(recentActions[1]?.metadata).not.toHaveProperty("navigateCount");
  });

  test("does not coalesce navigate actions for different destinations", async () => {
    const { service, emitAction } = await startServiceWithActionCapture();

    emitAction(
      createNavigateAction({
        id: "navigate-action-1",
        timestamp: "2026-03-16T00:00:00.000Z",
        metadata: {
          currentUrl: "https://example.com/dashboard",
          title: "Dashboard",
        },
      })
    );
    emitAction(
      createNavigateAction({
        id: "navigate-action-2",
        timestamp: "2026-03-16T00:00:01.000Z",
        description: "Settings",
        metadata: {
          previousUrl: "https://example.com/dashboard",
          currentUrl: "https://example.com/settings",
          previousTitle: "Dashboard",
          title: "Settings",
        },
      })
    );

    const recentActions = service.getRecentActions(workspaceId);
    expect(recentActions).toHaveLength(2);
    expect(recentActions[0]?.metadata).not.toHaveProperty("navigateCount");
    expect(recentActions[1]?.metadata).not.toHaveProperty("navigateCount");
  });

  test("does not coalesce navigate actions across non-navigate actions", async () => {
    const { service, emitAction } = await startServiceWithActionCapture();

    emitAction(
      createNavigateAction({
        id: "navigate-action-1",
        timestamp: "2026-03-16T00:00:00.000Z",
      })
    );
    emitAction(
      createClickAction({
        id: "click-action-1",
        timestamp: "2026-03-16T00:00:00.500Z",
      })
    );
    emitAction(
      createNavigateAction({
        id: "navigate-action-2",
        timestamp: "2026-03-16T00:00:01.000Z",
      })
    );

    const recentActions = service.getRecentActions(workspaceId);
    expect(recentActions).toHaveLength(3);
    expect(recentActions[0]?.type).toBe("navigate");
    expect(recentActions[1]?.type).toBe("click");
    expect(recentActions[2]?.type).toBe("navigate");
  });

  test("accumulates navigate counts across repeated merges", async () => {
    const { service, emitAction } = await startServiceWithActionCapture();

    emitAction(
      createNavigateAction({
        id: "navigate-action-1",
        timestamp: "2026-03-16T00:00:00.000Z",
      })
    );
    emitAction(
      createNavigateAction({
        id: "navigate-action-2",
        timestamp: "2026-03-16T00:00:00.500Z",
      })
    );
    emitAction(
      createNavigateAction({
        id: "navigate-action-3",
        timestamp: "2026-03-16T00:00:01.000Z",
        description: "Dashboard refreshed",
        metadata: {
          previousUrl: "https://example.com/dashboard",
          currentUrl: "https://example.com/dashboard",
          previousTitle: "Dashboard",
          title: "Dashboard refreshed",
        },
      })
    );

    const recentActions = service.getRecentActions(workspaceId);
    expect(recentActions).toHaveLength(1);
    expect(recentActions[0]).toMatchObject({
      id: "navigate-action-1",
      description: "Dashboard refreshed",
      timestamp: "2026-03-16T00:00:01.000Z",
      metadata: {
        navigateCount: 3,
        title: "Dashboard refreshed",
      },
    });
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
