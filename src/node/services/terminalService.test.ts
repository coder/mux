import { describe, it, expect, mock, beforeEach, afterEach, spyOn, vi, type Mock } from "bun:test";
import { TerminalService } from "./terminalService";
import type { PTYService } from "./ptyService";
import type { Config } from "@/node/config";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import type { TerminalCreateParams } from "@/common/types/terminal";
import * as childProcess from "child_process";
import * as fs from "fs/promises";

const getEffectiveSecretsMock = mock(() => [{ key: "TEST_SECRET", value: "secret-value" }]);

// Mock dependencies
const mockConfig = {
  getAllWorkspaceMetadata: mock(() =>
    Promise.resolve([
      {
        id: "ws-1",
        projectPath: "/tmp/project",
        name: "main",
        runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
      },
    ])
  ),
  getEffectiveSecrets: getEffectiveSecretsMock,
  loadConfigOrDefault: mock(() => ({
    projects: new Map(),
    terminalDefaultShell: undefined,
  })),
  srcDir: "/tmp",
} as unknown as Config;

const createSessionMock = mock(
  (
    params: TerminalCreateParams,
    _runtime: unknown,
    _path: string,
    onData: (d: string) => void,
    _onExit: (code: number) => void,
    _runtimeConfig?: unknown,
    _options?: { env?: NodeJS.ProcessEnv }
  ) => {
    // Simulate immediate data emission to test buffering
    onData("initial data");
    return Promise.resolve({
      sessionId: "session-1",
      workspaceId: params.workspaceId,
      cols: 80,
      rows: 24,
    });
  }
);

const resizeMock = mock(() => {
  /* no-op */
});
const sendInputMock = mock(() => {
  /* no-op */
});
const closeSessionMock = mock(() => {
  /* no-op */
});
const getWorkspaceSessionIdsMock = mock(() => []);
const closeWorkspaceSessionsMock = mock(() => {
  /* no-op */
});
const closeAllSessionsMock = mock(() => {
  /* no-op */
});

const mockPTYService = {
  createSession: createSessionMock,
  closeSession: closeSessionMock,
  resize: resizeMock,
  sendInput: sendInputMock,
  getWorkspaceSessionIds: getWorkspaceSessionIdsMock,
  closeWorkspaceSessions: closeWorkspaceSessionsMock,
  closeAllSessions: closeAllSessionsMock,
} as unknown as PTYService;

const openTerminalWindowMock = mock(() => Promise.resolve());
const closeTerminalWindowMock = mock(() => {
  /* no-op */
});

const mockWindowManager = {
  openTerminalWindow: openTerminalWindowMock,
  closeTerminalWindow: closeTerminalWindowMock,
} as unknown as TerminalWindowManager;

describe("TerminalService", () => {
  let service: TerminalService;

  beforeEach(() => {
    // Some tests temporarily replace createSession to capture callbacks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = createSessionMock;

    service = new TerminalService(mockConfig, mockPTYService);
    service.setTerminalWindowManager(mockWindowManager);
    createSessionMock.mockClear();
    closeSessionMock.mockClear();
    getWorkspaceSessionIdsMock.mockClear();
    closeWorkspaceSessionsMock.mockClear();
    closeAllSessionsMock.mockClear();
    getEffectiveSecretsMock.mockClear();
    resizeMock.mockClear();
    sendInputMock.mockClear();
    closeSessionMock.mockClear();
    getWorkspaceSessionIdsMock.mockClear();
    closeWorkspaceSessionsMock.mockClear();
    closeAllSessionsMock.mockClear();
    openTerminalWindowMock.mockClear();
  });

  it("should create a session", async () => {
    const session = await service.create({
      workspaceId: "ws-1",
      cols: 80,
      rows: 24,
    });

    expect(session.sessionId).toBe("session-1");
    expect(session.workspaceId).toBe("ws-1");
    expect(createSessionMock).toHaveBeenCalled();
    expect(getEffectiveSecretsMock).toHaveBeenCalledWith("/tmp/project");

    const call = createSessionMock.mock.calls[0];
    if (!call) {
      throw new Error("Expected createSession to be called");
    }

    const options = call[6] as { env?: NodeJS.ProcessEnv } | undefined;
    if (!options?.env) {
      throw new Error("Expected createSession to receive terminal env");
    }

    expect(options.env.MUX_PROJECT_PATH).toBe("/tmp/project");
    expect(options.env.MUX_RUNTIME).toBe("worktree");
    expect(options.env.MUX_WORKSPACE_NAME).toBe("main");
    expect(options.env.TEST_SECRET).toBe("secret-value");
  });

  it("should handle resizing", () => {
    service.resize({ sessionId: "session-1", cols: 100, rows: 30 });
    expect(resizeMock).toHaveBeenCalledWith({
      sessionId: "session-1",
      cols: 100,
      rows: 30,
    });
  });

  it("should respond to DA1 terminal queries on the backend", async () => {
    let capturedOnData: ((data: string) => void) | undefined;

    // Override mock temporarily for this test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = mock(
      (
        params: TerminalCreateParams,
        _runtime: unknown,
        _path: string,
        onData: (d: string) => void,
        _onExit: (code: number) => void
      ) => {
        capturedOnData = onData;
        return Promise.resolve({
          sessionId: "session-da1",
          workspaceId: params.workspaceId,
          cols: params.cols,
          rows: params.rows,
        });
      }
    );

    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

    if (!capturedOnData) {
      throw new Error("Expected createSession to capture onData callback");
    }

    // DA1 (Primary Device Attributes) query sent by many TUIs during startup.
    capturedOnData("\x1b[0c");

    // xterm/headless processes writes asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(sendInputMock).toHaveBeenCalled();

    const calls = sendInputMock.mock.calls;
    if (calls.length === 0) {
      throw new Error("Expected sendInput to be called with DA1 response");
    }

    const [calledSessionId, response] = calls[calls.length - 1] as unknown as [string, string];
    expect(calledSessionId).toBe("session-da1");
    expect(response.startsWith("\x1b[?")).toBe(true);
    expect(response.endsWith("c")).toBe(true);

    // Restore mock (since we replaced the reference on the object)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = createSessionMock;
  });
  it("should handle input", () => {
    service.sendInput("session-1", "ls\n");
    expect(sendInputMock).toHaveBeenCalledWith("session-1", "ls\n");
  });

  it("should close workspace sessions via terminateTrackedSessions", async () => {
    // Create real sessions so sessionActivity is populated
    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
    closeSessionMock.mockClear();

    service.closeWorkspaceSessions("ws-1");

    expect(closeSessionMock).toHaveBeenCalled();
    // PTY bulk close should NOT be used — we route through per-session termination
    expect(closeWorkspaceSessionsMock).not.toHaveBeenCalled();
    // Activity should be fully cleaned up
    expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
  });

  it("should close all sessions via terminateTrackedSessions", async () => {
    // Create a real session so sessionActivity is populated
    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
    closeSessionMock.mockClear();

    service.closeAllSessions();

    expect(closeSessionMock).toHaveBeenCalled();
    // PTY bulk close should NOT be used
    expect(closeAllSessionsMock).not.toHaveBeenCalled();
    expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
  });

  it("should open terminal window via manager", async () => {
    await service.openWindow("ws-1");
    // openWindow(workspaceId, sessionId?) passes sessionId as undefined when not provided
    expect(openTerminalWindowMock).toHaveBeenCalledWith("ws-1", undefined);
  });

  it("should handle session exit", async () => {
    // We need to capture the onExit callback passed to createSession
    let capturedOnExit: ((code: number) => void) | undefined;

    // Override mock temporarily for this test
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = mock(
      (
        params: TerminalCreateParams,
        _runtime: unknown,
        _path: string,
        _onData: unknown,
        onExit: (code: number) => void
      ) => {
        capturedOnExit = onExit;
        return Promise.resolve({
          sessionId: "session-2",
          workspaceId: params.workspaceId,
          cols: 80,
          rows: 24,
        });
      }
    );

    await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

    let exitCode: number | null = null;
    service.onExit("session-2", (code) => {
      exitCode = code;
    });

    // Simulate exit
    if (capturedOnExit) capturedOnExit(0);

    expect(exitCode as unknown as number).toBe(0);

    // Restore mock (optional if beforeEach resets, but we are replacing the reference on the object)
    // Actually best to restore it.
    // However, since we defined mockPTYService as a const object, we can't easily replace properties safely if they are readonly.
    // But they are not readonly in the mock definition.
    // Let's just restore it to createSessionMock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockPTYService.createSession as any) = createSessionMock;
  });
  describe("terminal activity tracking", () => {
    let capturedOnData: ((data: string) => void) | undefined;
    let capturedOnExit: ((code: number) => void) | undefined;
    const onDataBySession = new Map<string, (data: string) => void>();
    let sessionCounter = 0;

    beforeEach(() => {
      capturedOnData = undefined;
      capturedOnExit = undefined;
      onDataBySession.clear();
      sessionCounter = 0;

      // Override createSession to capture onData/onExit callbacks.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockPTYService.createSession as any) = mock(
        (
          params: TerminalCreateParams,
          _runtime: unknown,
          _path: string,
          onData: (d: string) => void,
          onExit: (code: number) => void
        ) => {
          sessionCounter += 1;
          const sessionId = `session-${params.workspaceId}-${sessionCounter}`;
          capturedOnData = onData;
          capturedOnExit = onExit;
          onDataBySession.set(sessionId, onData);

          return Promise.resolve({
            sessionId,
            workspaceId: params.workspaceId,
            cols: params.cols,
            rows: params.rows,
          });
        }
      );
    });

    async function sendTitle(
      onData: ((data: string) => void) | undefined,
      title: string
    ): Promise<void> {
      if (!onData) {
        throw new Error("Expected createSession to capture onData callback");
      }

      onData(`\x1b]0;${title}\x07`);
      // xterm/headless processes writes asynchronously.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    async function sendPromptMarker(
      onData: ((data: string) => void) | undefined,
      marker: string
    ): Promise<void> {
      if (!onData) {
        throw new Error("Expected createSession to capture onData callback");
      }

      onData(`\x1b]133;${marker}\x07`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    it("classifies idle titles as not running", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      const initial = service.getWorkspaceActivity("ws-1");
      expect(initial.totalSessions).toBe(1);
      expect(initial.activeCount).toBe(0);

      await sendTitle(capturedOnData, "bash");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "zsh");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "/home/user/project");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "~/project");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "user@host:/path");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("classifies command titles as running", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      const initial = service.getWorkspaceActivity("ws-1");
      expect(initial.totalSessions).toBe(1);
      expect(initial.activeCount).toBe(0);

      await sendTitle(capturedOnData, "vim main.ts");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "npm run build");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "htop");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
    });

    it("sendInput with newline marks session as running", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      service.sendInput(session.sessionId, "make build\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "~/project");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("sendInput without newline does not mark running", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "a");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      service.sendInput(session.sessionId, "bc");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("OSC 133 prompt-start (A) marks session as idle", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      // Simulate: user runs command
      service.sendInput(session.sessionId, "sleep infinity\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      // Fish sends OSC 133;D (command done) then 133;A (prompt start)
      await sendPromptMarker(capturedOnData, "D;130");
      // D should be ignored — still running
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendPromptMarker(capturedOnData, "A;special_key=1");
      // A flips to idle
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("OSC 133 command-start (C) marks session as running", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendPromptMarker(capturedOnData, "C");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      // Prompt returns
      await sendPromptMarker(capturedOnData, "A");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("transitions between running and idle", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);

      await sendTitle(capturedOnData, "make build");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);

      await sendTitle(capturedOnData, "bash");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("emits activity change events with dedup", async () => {
      const changes: string[] = [];
      const unsubscribe = service.onActivityChange((workspaceId) => changes.push(workspaceId));

      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      expect(changes).toEqual(["ws-1"]);

      const countAfterCreate = changes.length;
      await sendTitle(capturedOnData, "make test");
      expect(changes.length).toBe(countAfterCreate + 1);

      const countAfterFirstCommand = changes.length;
      await sendTitle(capturedOnData, "npm test");
      expect(changes.length).toBe(countAfterFirstCommand);

      await sendTitle(capturedOnData, "bash");
      expect(changes.length).toBe(countAfterFirstCommand + 1);

      const countAfterIdle = changes.length;
      await sendTitle(capturedOnData, "zsh");
      expect(changes.length).toBe(countAfterIdle);

      unsubscribe();
    });

    it("cleans up activity on session exit", async () => {
      await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      await sendTitle(capturedOnData, "make build");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(service.getWorkspaceActivity("ws-1").totalSessions).toBe(1);

      if (!capturedOnExit) {
        throw new Error("Expected createSession to capture onExit callback");
      }

      capturedOnExit(0);
      expect(service.getWorkspaceActivity("ws-1").totalSessions).toBe(0);
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("returns aggregate across workspace sessions via getAllWorkspaceActivity", async () => {
      const firstSession = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      const secondSession = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      const firstOnData = onDataBySession.get(firstSession.sessionId);
      const secondOnData = onDataBySession.get(secondSession.sessionId);

      await sendTitle(firstOnData, "vim");
      const activity = service.getWorkspaceActivity("ws-1");
      expect(activity.totalSessions).toBe(2);
      expect(activity.activeCount).toBe(1);

      await sendTitle(secondOnData, "npm test");
      const activity2 = service.getWorkspaceActivity("ws-1");
      expect(activity2.activeCount).toBe(2);

      const all = service.getAllWorkspaceActivity();
      expect(all["ws-1"]).toEqual({ activeCount: 2, totalSessions: 2 });
    });

    it("clears activity on bulk workspace close without exit callback", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "make build\n");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(service.getWorkspaceActivity("ws-1").totalSessions).toBe(1);

      service.closeWorkspaceSessions("ws-1");
      expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
    });

    it("clears all activity on global close without exit callbacks", async () => {
      const configRef = mockConfig as unknown as {
        getAllWorkspaceMetadata: typeof mockConfig.getAllWorkspaceMetadata;
      };
      const originalGetAllWorkspaceMetadata = configRef.getAllWorkspaceMetadata;
      configRef.getAllWorkspaceMetadata = mock(() =>
        Promise.resolve([
          {
            id: "ws-1",
            projectPath: "/tmp/project",
            name: "main",
            runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
          },
          {
            id: "ws-2",
            projectPath: "/tmp/project2",
            name: "dev",
            runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
          },
        ])
      ) as unknown as typeof configRef.getAllWorkspaceMetadata;

      try {
        const s1 = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
        const s2 = await service.create({ workspaceId: "ws-2", cols: 80, rows: 24 });
        service.sendInput(s1.sessionId, "cmd1\n");
        service.sendInput(s2.sessionId, "cmd2\n");

        expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
        expect(service.getWorkspaceActivity("ws-2").activeCount).toBe(1);

        service.closeAllSessions();
        expect(service.getWorkspaceActivity("ws-1")).toEqual({ activeCount: 0, totalSessions: 0 });
        expect(service.getWorkspaceActivity("ws-2")).toEqual({ activeCount: 0, totalSessions: 0 });
        expect(Object.keys(service.getAllWorkspaceActivity())).toHaveLength(0);
      } finally {
        configRef.getAllWorkspaceMetadata = originalGetAllWorkspaceMetadata;
      }
    });
  });

  describe("no-OSC idle fallback", () => {
    let capturedOnData: ((data: string) => void) | undefined;
    let sessionCounter = 0;
    let originalSetTimeout: typeof globalThis.setTimeout;
    let originalClearTimeout: typeof globalThis.clearTimeout;
    type TimerHandle = ReturnType<typeof setTimeout> | number;
    const fallbackTimerHandles: TimerHandle[] = [];
    const fallbackCallbacks = new Map<TimerHandle, () => void>();

    function fireFallbackTimer(handle: TimerHandle): void {
      const callback = fallbackCallbacks.get(handle);
      if (!callback) {
        throw new Error("Expected fallback timer callback to be captured");
      }

      originalClearTimeout(handle);
      fallbackCallbacks.delete(handle);
      callback();
    }

    beforeEach(() => {
      capturedOnData = undefined;
      sessionCounter = 0;
      fallbackTimerHandles.length = 0;
      fallbackCallbacks.clear();
      originalSetTimeout = globalThis.setTimeout;
      originalClearTimeout = globalThis.clearTimeout;

      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        const handle = originalSetTimeout(handler, timeout, ...args);

        if (timeout === 10_000 && typeof handler === "function") {
          fallbackTimerHandles.push(handle);
          fallbackCallbacks.set(handle, handler as () => void);
        }

        return handle;
      }) as typeof globalThis.setTimeout);

      vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle: TimerHandle) => {
        fallbackCallbacks.delete(handle);
        return originalClearTimeout(handle);
      }) as typeof globalThis.clearTimeout);

      // Override createSession to capture onData callback.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockPTYService.createSession as any) = mock(
        (
          params: TerminalCreateParams,
          _runtime: unknown,
          _path: string,
          onData: (d: string) => void,
          _onExit: (code: number) => void
        ) => {
          sessionCounter += 1;
          const sessionId = `session-${params.workspaceId}-${sessionCounter}`;
          capturedOnData = onData;

          return Promise.resolve({
            sessionId,
            workspaceId: params.workspaceId,
            cols: params.cols,
            rows: params.rows,
          });
        }
      );
    });

    afterEach(() => {
      for (const handle of fallbackTimerHandles) {
        originalClearTimeout(handle);
      }
      vi.restoreAllMocks();
    });

    it("resets to idle after fallback timeout when no OSC observed", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "make build\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(fallbackTimerHandles).toHaveLength(1);

      fireFallbackTimer(fallbackTimerHandles[0]);
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });

    it("does not use fallback once OSC activity is observed", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });

      if (!capturedOnData) {
        throw new Error("Expected createSession to capture onData callback");
      }

      capturedOnData(`\x1b]0;bash\x07`);
      await new Promise((resolve) => originalSetTimeout(resolve, 10));

      service.sendInput(session.sessionId, "make build\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(fallbackTimerHandles).toHaveLength(0);
    });

    it("refreshes fallback timer on repeated newlines", async () => {
      const session = await service.create({ workspaceId: "ws-1", cols: 80, rows: 24 });
      service.sendInput(session.sessionId, "cmd1\r");
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      expect(fallbackTimerHandles).toHaveLength(1);

      const firstHandle = fallbackTimerHandles[0];
      service.sendInput(session.sessionId, "cmd2\r");
      expect(fallbackTimerHandles).toHaveLength(2);

      const secondHandle = fallbackTimerHandles[1];
      const clearTimeoutCalls = (globalThis.clearTimeout as Mock<typeof globalThis.clearTimeout>)
        .mock.calls;
      const clearedFirstHandle = clearTimeoutCalls.some(([handle]) => handle === firstHandle);
      expect(clearedFirstHandle).toBe(true);

      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(1);
      fireFallbackTimer(secondHandle);
      expect(service.getWorkspaceActivity("ws-1").activeCount).toBe(0);
    });
  });
});

describe("TerminalService.openNative", () => {
  let service: TerminalService;
  // Using simplified mock types since spawnSync has complex overloads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spawnSpy: Mock<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spawnSyncSpy: Mock<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fsStatSpy: Mock<any>;
  let originalPlatform: NodeJS.Platform;

  // Helper to create a mock child process
  const createMockChildProcess = () =>
    ({
      unref: mock(() => undefined),
      on: mock(() => undefined),
      pid: 12345,
    }) as unknown as ReturnType<typeof childProcess.spawn>;

  // Config with local workspace
  const configWithLocalWorkspace = {
    getAllWorkspaceMetadata: mock(() =>
      Promise.resolve([
        {
          id: "ws-local",
          projectPath: "/tmp/project",
          name: "main",
          namedWorkspacePath: "/tmp/project/main",
          runtimeConfig: { type: "local", srcBaseDir: "/tmp" },
        },
      ])
    ),
    loadConfigOrDefault: mock(() => ({
      projects: new Map(),
      terminalDefaultShell: undefined,
    })),
    srcDir: "/tmp",
  } as unknown as Config;

  // Config with SSH workspace
  const configWithSSHWorkspace = {
    getAllWorkspaceMetadata: mock(() =>
      Promise.resolve([
        {
          id: "ws-ssh",
          projectPath: "/home/user/project",
          name: "feature",
          namedWorkspacePath: "/home/user/project/feature",
          runtimeConfig: {
            type: "ssh",
            host: "remote.example.com",
            port: 2222,
            identityFile: "~/.ssh/id_rsa",
          },
        },
      ])
    ),
    loadConfigOrDefault: mock(() => ({
      projects: new Map(),
      terminalDefaultShell: undefined,
    })),
    srcDir: "/tmp",
  } as unknown as Config;

  beforeEach(() => {
    // Store original platform
    originalPlatform = process.platform;

    // Spy on spawn to capture calls without actually spawning processes
    // Using `as unknown as` to bypass complex overload matching
    spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() =>
      createMockChildProcess()) as unknown as typeof childProcess.spawn);

    // Spy on spawnSync for command availability checks
    spawnSyncSpy = spyOn(childProcess, "spawnSync").mockImplementation((() => ({
      status: 0,
      output: [null, "/usr/bin/cmd"],
    })) as unknown as typeof childProcess.spawnSync);

    // Spy on fs.stat to reject (no ghostty installed by default)
    fsStatSpy = spyOn(fs, "stat").mockImplementation((() =>
      Promise.reject(new Error("ENOENT"))) as unknown as typeof fs.stat);
  });

  afterEach(() => {
    // Restore original platform
    Object.defineProperty(process, "platform", { value: originalPlatform });
    // Restore spies
    spawnSpy.mockRestore();
    spawnSyncSpy.mockRestore();
    fsStatSpy.mockRestore();
  });

  /**
   * Helper to set the platform for testing
   */
  function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: platform });
  }

  describe("macOS (darwin)", () => {
    beforeEach(() => {
      setPlatform("darwin");
    });

    it("should open Terminal.app for local workspace when ghostty is not available", async () => {
      // spawnSync returns non-zero for ghostty check (not available)
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which" && args?.[0] === "ghostty") {
          return { status: 1 }; // ghostty not found
        }
        return { status: 0 }; // other commands available
      });

      service = new TerminalService(configWithLocalWorkspace, mockPTYService);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      // Type assertion for spawn call args: [command, args, options]
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("open");
      expect(call[1]).toEqual(["-a", "Terminal", "/tmp/project/main"]);
      expect(call[2]?.detached).toBe(true);
      expect(call[2]?.stdio).toBe("ignore");
    });

    it("should open Ghostty for local workspace when available", async () => {
      // Make ghostty available via fs.stat (common install path)
      fsStatSpy.mockImplementation((path: string) => {
        if (path === "/Applications/Ghostty.app/Contents/MacOS/ghostty") {
          return Promise.resolve({ isFile: () => true, mode: 0o755 });
        }
        return Promise.reject(new Error("ENOENT"));
      });

      service = new TerminalService(configWithLocalWorkspace, mockPTYService);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("open");
      expect(call[1]).toContain("-a");
      expect(call[1]).toContain("Ghostty");
      expect(call[1]).toContain("/tmp/project/main");
    });

    it("should use osascript for SSH workspace with Terminal.app", async () => {
      // No ghostty available
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which" && args?.[0] === "ghostty") {
          return { status: 1 };
        }
        return { status: 0 };
      });

      service = new TerminalService(configWithSSHWorkspace, mockPTYService);

      await service.openNative("ws-ssh");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("osascript");
      expect(call[1]?.[0]).toBe("-e");
      // Verify the AppleScript contains SSH command with proper args
      const script = call[1]?.[1];
      expect(script).toContain('tell application "Terminal"');
      expect(script).toContain("ssh");
      expect(script).toContain("-p 2222"); // port
      expect(script).toContain("-i ~/.ssh/id_rsa"); // identity file
      expect(script).toContain("remote.example.com"); // host
    });
  });

  describe("Windows (win32)", () => {
    beforeEach(() => {
      setPlatform("win32");
    });

    it("should open cmd for local workspace", async () => {
      service = new TerminalService(configWithLocalWorkspace, mockPTYService);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("cmd");
      expect(call[1]).toEqual(["/c", "start", "cmd", "/K", "cd", "/D", "/tmp/project/main"]);
      expect(call[2]?.shell).toBe(true);
    });

    it("should open cmd with SSH for SSH workspace", async () => {
      service = new TerminalService(configWithSSHWorkspace, mockPTYService);

      await service.openNative("ws-ssh");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("cmd");
      expect(call[1]?.[0]).toBe("/c");
      expect(call[1]?.[1]).toBe("start");
      expect(call[1]).toContain("ssh");
      expect(call[1]).toContain("-p");
      expect(call[1]).toContain("2222");
      expect(call[1]).toContain("remote.example.com");
    });
  });

  describe("Linux", () => {
    beforeEach(() => {
      setPlatform("linux");
    });

    it("should try terminal emulators in order of preference", async () => {
      // Make gnome-terminal the first available
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which") {
          const terminal = args?.[0];
          // x-terminal-emulator, ghostty, alacritty, kitty, wezterm not found
          // gnome-terminal found
          if (terminal === "gnome-terminal") {
            return { status: 0 };
          }
          return { status: 1 };
        }
        return { status: 0 };
      });

      service = new TerminalService(configWithLocalWorkspace, mockPTYService);

      await service.openNative("ws-local");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("gnome-terminal");
      expect(call[1]).toContain("--working-directory");
      expect(call[1]).toContain("/tmp/project/main");
    });

    it("should throw error when no terminal emulator is found", async () => {
      // All terminals not found
      spawnSyncSpy.mockImplementation(() => ({ status: 1 }));

      service = new TerminalService(configWithLocalWorkspace, mockPTYService);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.openNative("ws-local")).rejects.toThrow("No terminal emulator found");
    });

    it("should pass SSH args to terminal for SSH workspace", async () => {
      // Make alacritty available
      spawnSyncSpy.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "which" && args?.[0] === "alacritty") {
          return { status: 0 };
        }
        return { status: 1 };
      });

      service = new TerminalService(configWithSSHWorkspace, mockPTYService);

      await service.openNative("ws-ssh");

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      const call = spawnSpy.mock.calls[0] as [string, string[], childProcess.SpawnOptions];
      expect(call[0]).toBe("alacritty");
      expect(call[1]).toContain("-e");
      expect(call[1]).toContain("ssh");
      expect(call[1]).toContain("-p");
      expect(call[1]).toContain("2222");
    });
  });

  describe("error handling", () => {
    beforeEach(() => {
      setPlatform("darwin");
      spawnSyncSpy.mockImplementation(() => ({ status: 0 }));
    });

    it("should throw error for non-existent workspace", async () => {
      service = new TerminalService(configWithLocalWorkspace, mockPTYService);

      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(service.openNative("non-existent")).rejects.toThrow(
        "Workspace not found: non-existent"
      );
    });
  });
});
