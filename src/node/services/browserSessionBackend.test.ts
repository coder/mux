import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { BrowserSession } from "@/common/types/browserSession";
import * as agentBrowserLauncher from "@/node/services/agentBrowserLauncher";
import {
  BrowserSessionBackend,
  closeAgentBrowserSession,
} from "@/node/services/browserSessionBackend";

let resolveAgentBrowserBinarySpy: ReturnType<
  typeof spyOn<typeof agentBrowserLauncher, "resolveAgentBrowserBinary">
>;
let spawnSpy: ReturnType<typeof spyOn<typeof childProcess, "spawn">>;

const noop = (): void => undefined;

type MockChildProcess = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: null;
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof mock>;
};

function createBackend(initialUrl = "https://example.com"): BrowserSessionBackend {
  return new BrowserSessionBackend({
    workspaceId: "workspace-123",
    ownership: "shared",
    initialUrl,
    onSessionUpdate: noop,
    onAction: noop,
    onEnded: noop,
    onError: noop,
  });
}

function createMockChildProcess(): MockChildProcess {
  const childProcess = new EventEmitter() as MockChildProcess;
  childProcess.stdout = new PassThrough();
  childProcess.stderr = new PassThrough();
  childProcess.stdin = null;
  childProcess.pid = undefined;
  childProcess.killed = false;
  childProcess.exitCode = null;
  childProcess.signalCode = null;
  childProcess.kill = mock(() => {
    childProcess.killed = true;
    childProcess.signalCode = "SIGKILL";
    return true;
  });
  return childProcess;
}

function scheduleClose(
  childProcess: MockChildProcess,
  options: { code: number | null; signal?: NodeJS.Signals | null; stdout?: string; stderr?: string }
): void {
  queueMicrotask(() => {
    if (options.stdout) {
      childProcess.stdout.write(options.stdout);
    }
    if (options.stderr) {
      childProcess.stderr.write(options.stderr);
    }
    childProcess.stdout.end();
    childProcess.stderr.end();
    childProcess.exitCode = options.code;
    childProcess.signalCode = options.signal ?? null;
    childProcess.emit("close", options.code, options.signal ?? null);
  });
}

beforeEach(() => {
  resolveAgentBrowserBinarySpy = spyOn(
    agentBrowserLauncher,
    "resolveAgentBrowserBinary"
  ).mockImplementation(() => "/tmp/mock-agent-browser");
  spawnSpy = spyOn(childProcess, "spawn").mockImplementation((() =>
    createMockChildProcess()) as unknown as typeof childProcess.spawn);
});

afterEach(() => {
  mock.restore();
});

describe("BrowserSessionBackend", () => {
  test("reuses the deterministic mux session id", () => {
    const backend = createBackend();

    expect(backend.getSession().id).toMatch(/^mux-workspace-123-[a-f0-9]{8}$/);
  });

  test("attaches to an existing daemon session without reopening the initial URL", async () => {
    const backend = createBackend("https://start.example.com");
    const runCliCommand = mock(() => Promise.resolve({ ok: true as const, data: {} }));
    const refreshMetadata = mock(() => {
      const session = Reflect.get(backend, "session") as BrowserSession;
      Reflect.set(backend, "session", {
        ...session,
        currentUrl: "https://attached.example.com",
        title: "Attached page",
        updatedAt: new Date().toISOString(),
      });
      return Promise.resolve();
    });

    expect(Reflect.set(backend, "hasExistingSession", () => true)).toBe(true);
    expect(Reflect.set(backend, "runCliCommand", runCliCommand)).toBe(true);
    expect(Reflect.set(backend, "refreshMetadata", refreshMetadata)).toBe(true);

    const session = await backend.start();

    expect(runCliCommand).not.toHaveBeenCalled();
    expect(refreshMetadata).toHaveBeenCalledTimes(1);
    expect(session.id).toMatch(/^mux-workspace-123-[a-f0-9]{8}$/);
    expect(session.status).toBe("live");
    expect(session.currentUrl).toBe("https://attached.example.com");
  });

  test("opens the initial URL when no daemon session exists yet", async () => {
    const backend = createBackend("https://start.example.com");
    const runCliCommand = mock((args: string[]) => {
      expect(args).toEqual(["open", "https://start.example.com"]);
      return Promise.resolve({ ok: true as const, data: {} });
    });
    const refreshMetadata = mock(() => {
      const session = Reflect.get(backend, "session") as BrowserSession;
      Reflect.set(backend, "session", {
        ...session,
        currentUrl: "https://start.example.com",
        title: "Start page",
        updatedAt: new Date().toISOString(),
      });
      return Promise.resolve();
    });

    expect(Reflect.set(backend, "hasExistingSession", () => false)).toBe(true);
    expect(Reflect.set(backend, "runCliCommand", runCliCommand)).toBe(true);
    expect(Reflect.set(backend, "refreshMetadata", refreshMetadata)).toBe(true);

    const session = await backend.start();

    expect(runCliCommand).toHaveBeenCalledTimes(1);
    expect(refreshMetadata).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("live");
    expect(session.currentUrl).toBe("https://start.example.com");
  });
});

describe("closeAgentBrowserSession", () => {
  test("returns success when the close command exits cleanly", async () => {
    spawnSpy.mockImplementation((() => {
      const mockChildProcess = createMockChildProcess();
      scheduleClose(mockChildProcess, { code: 0 });
      return mockChildProcess;
    }) as unknown as typeof childProcess.spawn);

    const result = await closeAgentBrowserSession("mux-workspace-123");

    expect(result).toEqual({ success: true });
    expect(resolveAgentBrowserBinarySpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledWith(
      "/tmp/mock-agent-browser",
      ["--json", "--session", "mux-workspace-123", "close"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
  });

  test("treats an already-closed session as success", async () => {
    spawnSpy.mockImplementation((() => {
      const mockChildProcess = createMockChildProcess();
      scheduleClose(mockChildProcess, {
        code: 1,
        stderr: "session not found for mux-workspace-123",
      });
      return mockChildProcess;
    }) as unknown as typeof childProcess.spawn);

    const result = await closeAgentBrowserSession("mux-workspace-123");

    expect(result).toEqual({ success: true });
  });

  test("returns an error when the close command times out", async () => {
    const mockChildProcess = createMockChildProcess();
    spawnSpy.mockImplementation((() => mockChildProcess) as unknown as typeof childProcess.spawn);

    const result = await closeAgentBrowserSession("mux-workspace-123", 5);

    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after 5ms");
    expect(mockChildProcess.kill).toHaveBeenCalledTimes(1);
  });

  test("returns an error when resolving the vendored binary fails", async () => {
    const unsupportedPlatformError = new agentBrowserLauncher.AgentBrowserUnsupportedPlatformError(
      "linux",
      "x64"
    );
    unsupportedPlatformError.message = "unsupported test platform";
    resolveAgentBrowserBinarySpy.mockImplementation(() => {
      throw unsupportedPlatformError;
    });

    const result = await closeAgentBrowserSession("mux-workspace-123");

    expect(result).toEqual({
      success: false,
      error:
        "unsupported test platform Reinstall Mux, or run bun install in the repo if you're developing locally.",
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  test("asserts on an empty session id", async () => {
    let error: Error | undefined;

    try {
      await closeAgentBrowserSession("   ");
    } catch (caughtError) {
      error = caughtError as Error;
    }

    expect(error).toBeDefined();
    expect(error?.message).toContain("closeAgentBrowserSession requires a non-empty sessionId");
    expect(resolveAgentBrowserBinarySpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
