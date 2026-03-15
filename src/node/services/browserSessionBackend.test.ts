import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { BrowserAction, BrowserSession } from "@/common/types/browserSession";

const MISSING_BROWSER_BINARY_ERROR =
  "agent-browser binary not found. Install it with: bun install -g agent-browser (or ensure bunx, pnpx, or npx is available)";
const LAUNCHER_CANDIDATES = ["agent-browser", "bunx", "pnpx", "npx"];
const TEST_URL = "https://example.com";
const TEST_WORKSPACE_ID = "workspace-1";

type LauncherCommand = (typeof LAUNCHER_CANDIDATES)[number];

interface SpawnResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
}

const findAvailableCommandMock = mock<(commands: string[]) => Promise<LauncherCommand | null>>(() =>
  Promise.resolve("agent-browser")
);
const spawnMock = mock((_command: string, args: string[]) => createMockChildProcess(args));
const execMock = mock(() => undefined);
const execFileSyncMock = mock(() => undefined);

void mock.module("../utils/commandDiscovery", () => ({
  findAvailableCommand: findAvailableCommandMock,
}));

void mock.module("child_process", () => ({
  spawn: spawnMock,
  exec: execMock,
  execFileSync: execFileSyncMock,
}));

import { BrowserSessionBackend } from "./browserSessionBackend";

class MockChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  readonly pid = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function createMockChildProcess(args: string[]): MockChildProcess {
  const childProcess = new MockChildProcess();
  const response = getSpawnResultForArgs(args);

  queueMicrotask(() => {
    if (response.stdout !== undefined) {
      childProcess.stdout.end(response.stdout);
    } else {
      childProcess.stdout.end();
    }

    if (response.stderr !== undefined) {
      childProcess.stderr.end(response.stderr);
    } else {
      childProcess.stderr.end();
    }

    childProcess.exitCode = response.exitCode ?? 0;
    childProcess.signalCode = response.signal ?? null;
    childProcess.emit("close", childProcess.exitCode, childProcess.signalCode);
  });

  return childProcess;
}

function createSpawnErrorChildProcess(error: NodeJS.ErrnoException): MockChildProcess {
  const childProcess = new MockChildProcess();

  queueMicrotask(() => {
    childProcess.emit("error", error);
  });

  return childProcess;
}

function getSpawnResultForArgs(args: string[]): SpawnResult {
  const sessionFlagIndex = args.indexOf("--session");
  if (sessionFlagIndex === -1) {
    throw new Error(`Expected --session flag in spawn args: ${JSON.stringify(args)}`);
  }

  const cliArgs = args.slice(sessionFlagIndex + 2);
  switch (cliArgs[0]) {
    case "open":
      return { stdout: JSON.stringify({ opened: true }) };
    case "get":
      if (cliArgs[1] === "url") {
        return { stdout: JSON.stringify({ url: TEST_URL }) };
      }
      if (cliArgs[1] === "title") {
        return { stdout: JSON.stringify({ title: "Example title" }) };
      }
      throw new Error(`Unhandled get subcommand in spawn args: ${JSON.stringify(args)}`);
    case "screenshot":
      return { stdout: JSON.stringify({ success: false, error: "screenshot unavailable" }) };
    case "close":
      return { stdout: JSON.stringify({ closed: true }) };
    default:
      throw new Error(`Unhandled CLI args in spawn mock: ${JSON.stringify(args)}`);
  }
}

function createBackend() {
  const onSessionUpdate = mock((_session: BrowserSession) => undefined);
  const onAction = mock((_action: BrowserAction) => undefined);
  const onEnded = mock((_workspaceId: string) => undefined);
  const onError = mock((_workspaceId: string, _error: string) => undefined);

  return {
    backend: new BrowserSessionBackend({
      workspaceId: TEST_WORKSPACE_ID,
      ownership: "agent",
      initialUrl: TEST_URL,
      onSessionUpdate,
      onAction,
      onEnded,
      onError,
    }),
    onError,
  };
}

async function startSessionWithLauncher(launcherCommand: LauncherCommand) {
  findAvailableCommandMock.mockResolvedValue(launcherCommand);
  const { backend } = createBackend();
  const session = await backend.start();
  const openCommandSpawnCall = spawnMock.mock.calls[0];
  if (!openCommandSpawnCall) {
    throw new Error("Expected browser launcher spawn call");
  }

  return {
    backend,
    session,
    command: openCommandSpawnCall[0],
    args: openCommandSpawnCall[1],
  };
}

describe("BrowserSessionBackend launcher fallback", () => {
  const backends: BrowserSessionBackend[] = [];

  beforeEach(() => {
    findAvailableCommandMock.mockReset();
    findAvailableCommandMock.mockResolvedValue("agent-browser");
    spawnMock.mockReset();
    spawnMock.mockImplementation((_command: string, args: string[]) =>
      createMockChildProcess(args)
    );
    execMock.mockReset();
    execFileSyncMock.mockReset();
  });

  afterEach(() => {
    for (const backend of backends) {
      backend.dispose();
    }
    backends.length = 0;
  });

  it("spawns agent-browser directly when the binary is available", async () => {
    const result = await startSessionWithLauncher("agent-browser");
    backends.push(result.backend);

    expect(findAvailableCommandMock).toHaveBeenCalledWith(LAUNCHER_CANDIDATES);
    expect(result.command).toBe("agent-browser");
    expect(result.args).toEqual(["--json", "--session", result.session.id, "open", TEST_URL]);
  });

  it("falls back to bunx agent-browser when bunx is the first available launcher", async () => {
    const result = await startSessionWithLauncher("bunx");
    backends.push(result.backend);

    expect(result.command).toBe("bunx");
    expect(result.args).toEqual([
      "agent-browser",
      "--json",
      "--session",
      result.session.id,
      "open",
      TEST_URL,
    ]);
  });

  it("falls back to pnpx agent-browser when pnpx is the first available launcher", async () => {
    const result = await startSessionWithLauncher("pnpx");
    backends.push(result.backend);

    expect(result.command).toBe("pnpx");
    expect(result.args).toEqual([
      "agent-browser",
      "--json",
      "--session",
      result.session.id,
      "open",
      TEST_URL,
    ]);
  });

  it("falls back to npx -y agent-browser when npx is the first available launcher", async () => {
    const result = await startSessionWithLauncher("npx");
    backends.push(result.backend);

    expect(result.command).toBe("npx");
    expect(result.args).toEqual([
      "-y",
      "agent-browser",
      "--json",
      "--session",
      result.session.id,
      "open",
      TEST_URL,
    ]);
  });

  it("falls back to spawning agent-browser directly when launcher discovery returns null", async () => {
    findAvailableCommandMock.mockResolvedValue(null);
    spawnMock.mockImplementationOnce((command: string) => {
      expect(command).toBe("agent-browser");
      const error = new Error("spawn agent-browser ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return createSpawnErrorChildProcess(error);
    });
    const { backend, onError } = createBackend();
    backends.push(backend);

    const session = await backend.start();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "agent-browser",
      ["--json", "--session", session.id, "open", TEST_URL],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    );
    expect(onError).toHaveBeenCalledWith(TEST_WORKSPACE_ID, MISSING_BROWSER_BINARY_ERROR);
    expect(session.status).toBe("error");
    expect(session.lastError).toBe(MISSING_BROWSER_BINARY_ERROR);
  });

  it("adds -y only for the npx launcher prefix", async () => {
    for (const launcherCommand of LAUNCHER_CANDIDATES) {
      spawnMock.mockClear();
      const { backend, args } = await startSessionWithLauncher(launcherCommand);
      backends.push(backend);
      expect(args.includes("-y")).toBe(launcherCommand === "npx");
    }
  });
});
