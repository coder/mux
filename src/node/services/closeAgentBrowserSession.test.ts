import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgentBrowserBinaryNotFoundError } from "@/node/services/agentBrowserLauncher";
import { closeAgentBrowserSession } from "@/node/services/browserSessionBackend";

const mockResolveAgentBrowserBinary = mock(() => "/fake/agent-browser-binary");
const mockSpawn = mock();
const VENDORED_BROWSER_RECOVERY_HINT =
  "Reinstall Mux, or run bun install in the repo if you're developing locally.";

type SpawnFn = typeof childProcess.spawn;

type MockReadableStream = PassThrough & {
  setEncoding: ReturnType<typeof mock>;
};

type MockChildProcess = ReturnType<SpawnFn> & {
  stdout: MockReadableStream;
  stderr: MockReadableStream;
  kill: ReturnType<typeof mock>;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid: number | undefined;
};

function createMockReadableStream(): MockReadableStream {
  const stream = new PassThrough() as MockReadableStream;
  stream.setEncoding = mock(() => stream);
  return stream;
}

function createMockChildProcess(
  exitCode = 0,
  stdout = "",
  stderr = "",
  options?: { autoClose?: boolean; signal?: NodeJS.Signals | null }
): MockChildProcess {
  const childProcess = new EventEmitter() as MockChildProcess;
  childProcess.stdout = createMockReadableStream();
  childProcess.stderr = createMockReadableStream();
  childProcess.killed = false;
  childProcess.exitCode = null;
  childProcess.signalCode = null;
  childProcess.pid = undefined;
  childProcess.kill = mock(() => {
    childProcess.killed = true;
    childProcess.signalCode = "SIGKILL";
    return true;
  });

  if (options?.autoClose !== false) {
    queueMicrotask(() => {
      if (stdout.length > 0) {
        childProcess.stdout.emit("data", stdout);
      }
      if (stderr.length > 0) {
        childProcess.stderr.emit("data", stderr);
      }
      childProcess.exitCode = exitCode;
      childProcess.signalCode = options?.signal ?? null;
      childProcess.emit("close", exitCode, options?.signal ?? null);
    });
  }

  return childProcess;
}

function createCloseSessionOptions(): {
  spawnFn: SpawnFn;
  resolveAgentBrowserBinaryFn: () => string;
} {
  return {
    spawnFn: mockSpawn as SpawnFn,
    resolveAgentBrowserBinaryFn: mockResolveAgentBrowserBinary,
  };
}

beforeEach(() => {
  mockResolveAgentBrowserBinary.mockReset();
  mockResolveAgentBrowserBinary.mockReturnValue("/fake/agent-browser-binary");
  mockSpawn.mockReset();
});

describe("closeAgentBrowserSession", () => {
  test("returns success when the close command exits cleanly", async () => {
    const mockChildProcess = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession(
      "mux-workspace-123",
      undefined,
      createCloseSessionOptions()
    );

    expect(result).toEqual({ success: true });
    expect(mockResolveAgentBrowserBinary).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "/fake/agent-browser-binary",
      ["--json", "--session", "mux-workspace-123", "close"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
  });

  test("treats an already-closed session as success", async () => {
    const mockChildProcess = createMockChildProcess(
      1,
      "",
      "session not found for mux-workspace-123"
    );
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession(
      "mux-workspace-123",
      undefined,
      createCloseSessionOptions()
    );

    expect(result).toEqual({ success: true });
  });

  test("returns an error when the close command exits non-zero for another reason", async () => {
    const mockChildProcess = createMockChildProcess(1, "", "permission denied");
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession(
      "mux-workspace-123",
      undefined,
      createCloseSessionOptions()
    );

    expect(result).toEqual({ success: false, error: "permission denied" });
  });

  test("returns an error when the close command reports a logical failure in JSON", async () => {
    const mockChildProcess = createMockChildProcess(
      0,
      '{"success":false,"error":"close failed after daemon shutdown timeout"}'
    );
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession(
      "mux-workspace-123",
      undefined,
      createCloseSessionOptions()
    );

    expect(result).toEqual({
      success: false,
      error: "close failed after daemon shutdown timeout",
    });
  });

  test("returns an error when the close command times out", async () => {
    const mockChildProcess = createMockChildProcess(0, "", "", { autoClose: false });
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession(
      "mux-workspace-123",
      5,
      createCloseSessionOptions()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after 5ms");
    expect(mockChildProcess.kill).toHaveBeenCalledTimes(1);
  });

  test("returns an error when binary resolution fails", async () => {
    mockResolveAgentBrowserBinary.mockImplementation(() => {
      throw new AgentBrowserBinaryNotFoundError("/missing/agent-browser", "linux", "x64");
    });

    const result = await closeAgentBrowserSession(
      "mux-workspace-123",
      undefined,
      createCloseSessionOptions()
    );

    expect(result).toEqual({
      success: false,
      error:
        "Vendored agent-browser binary not found for linux-x64. Expected executable at /missing/agent-browser. " +
        VENDORED_BROWSER_RECOVERY_HINT,
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("does not resolve the binary or spawn for an empty session id", async () => {
    let caughtError: unknown = null;

    try {
      await closeAgentBrowserSession("   ", undefined, createCloseSessionOptions());
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe(
      "closeAgentBrowserSession requires a non-empty sessionId"
    );
    expect(mockResolveAgentBrowserBinary).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
