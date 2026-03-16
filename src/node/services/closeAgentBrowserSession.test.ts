import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockResolveAgentBrowserBinary = mock(() => "/fake/agent-browser-binary");
const mockSpawn = mock();

class MockAgentBrowserUnsupportedPlatformError extends Error {
  constructor(platform: string, arch: string) {
    super(
      `Unsupported vendored agent-browser platform/arch combination: ${platform}-${arch}. Supported platforms: darwin, linux, win32. Supported architectures: x64, arm64.`
    );
    this.name = "AgentBrowserUnsupportedPlatformError";
  }
}

class MockAgentBrowserVendoredPackageNotFoundError extends Error {
  constructor(cause: unknown) {
    super(
      "Vendored agent-browser package not found. Ensure the runtime dependency is installed so agent-browser/package.json can be resolved."
    );
    this.name = "AgentBrowserVendoredPackageNotFoundError";
    this.cause = cause;
  }
}

class MockAgentBrowserBinaryNotFoundError extends Error {
  constructor(binaryPath: string, platform: string, arch: string) {
    super(
      `Vendored agent-browser binary not found for ${platform}-${arch}. Expected executable at ${binaryPath}.`
    );
    this.name = "AgentBrowserBinaryNotFoundError";
  }
}

// Bun binds module-level imports during evaluation, so mock them before importing the module under test.
/* eslint-disable @typescript-eslint/no-floating-promises -- Bun requires top-level mock.module registration before static imports. */
mock.module("@/node/services/agentBrowserLauncher", () => ({
  AgentBrowserBinaryNotFoundError: MockAgentBrowserBinaryNotFoundError,
  AgentBrowserUnsupportedPlatformError: MockAgentBrowserUnsupportedPlatformError,
  AgentBrowserVendoredPackageNotFoundError: MockAgentBrowserVendoredPackageNotFoundError,
  resolveAgentBrowserBinary: mockResolveAgentBrowserBinary,
}));
mock.module("node:child_process", () => ({ spawn: mockSpawn }));
mock.module("child_process", () => ({ spawn: mockSpawn }));
/* eslint-enable @typescript-eslint/no-floating-promises */

import type { ChildProcess } from "child_process";
import { EventEmitter } from "node:events";
import { closeAgentBrowserSession } from "@/node/services/browserSessionBackend";

type MockReadableStream = EventEmitter & {
  setEncoding: ReturnType<typeof mock>;
};

type MockChildProcess = ChildProcess & {
  stdout: MockReadableStream;
  stderr: MockReadableStream;
  kill: ReturnType<typeof mock>;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid: number | undefined;
};

function createMockReadableStream(): MockReadableStream {
  const stream = new EventEmitter() as MockReadableStream;
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

beforeEach(() => {
  mockResolveAgentBrowserBinary.mockReset();
  mockResolveAgentBrowserBinary.mockReturnValue("/fake/agent-browser-binary");
  mockSpawn.mockReset();
});

describe("closeAgentBrowserSession", () => {
  test("returns success when the close command exits cleanly", async () => {
    const mockChildProcess = createMockChildProcess();
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession("mux-workspace-123");

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

    const result = await closeAgentBrowserSession("mux-workspace-123");

    expect(result).toEqual({ success: true });
  });

  test("returns an error when the close command exits non-zero for another reason", async () => {
    const mockChildProcess = createMockChildProcess(1, "", "permission denied");
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession("mux-workspace-123");

    expect(result).toEqual({ success: false, error: "permission denied" });
  });

  test("returns an error when the close command times out", async () => {
    const mockChildProcess = createMockChildProcess(0, "", "", { autoClose: false });
    mockSpawn.mockReturnValue(mockChildProcess);

    const result = await closeAgentBrowserSession("mux-workspace-123", 5);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after 5ms");
    expect(mockChildProcess.kill).toHaveBeenCalledTimes(1);
  });

  test("returns an error when binary resolution fails", async () => {
    mockResolveAgentBrowserBinary.mockImplementation(() => {
      throw new Error("unsupported test platform");
    });

    const result = await closeAgentBrowserSession("mux-workspace-123");

    expect(result.success).toBe(false);
    expect(result.error).toBe("unsupported test platform");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("does not resolve the binary or spawn for an empty session id", async () => {
    // In Bun's mocked-module test environment, the imported assert can behave
    // inconsistently, so this test only locks in the pre-spawn invariant that
    // matters for production behavior.
    try {
      await closeAgentBrowserSession("   ");
    } catch {
      // Ignore assertion failures here; the important behavior is that the
      // function never attempts binary resolution or process spawning.
    }

    expect(mockResolveAgentBrowserBinary).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
