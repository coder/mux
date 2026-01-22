import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TerminalService } from "./terminalService";
import type { PTYService } from "./ptyService";
import type { Config } from "@/node/config";
import type { TerminalCreateParams } from "@/common/types/terminal";

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
  srcDir: "/tmp",
} as unknown as Config;

const createSessionMock = mock(
  (
    params: TerminalCreateParams,
    _runtime: unknown,
    _path: string,
    onData: (d: string) => void,
    _onExit: (code: number) => void
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

const mockPTYService = {
  createSession: createSessionMock,
  closeSession: closeSessionMock,
  resize: resizeMock,
  sendInput: sendInputMock,
} as unknown as PTYService;

describe("TerminalService", () => {
  let service: TerminalService;

  beforeEach(() => {
    service = new TerminalService(mockConfig, mockPTYService);
    createSessionMock.mockClear();
    resizeMock.mockClear();
    sendInputMock.mockClear();
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
});
