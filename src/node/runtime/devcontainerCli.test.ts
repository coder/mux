import { describe, expect, it } from "bun:test";
import type { ChildProcess, SpawnOptions } from "child_process";
import { EventEmitter } from "events";
import {
  devcontainerUp,
  formatDevcontainerUpError,
  parseDevcontainerStdoutLine,
  shouldCleanupDevcontainer,
  spawnDevcontainer,
  type DevcontainerSpawnDeps,
} from "./devcontainerCli";
import type { InitLogger } from "./Runtime";

const noopInitLogger: InitLogger = {
  logStep: () => {
    // no-op
  },
  logStdout: () => {
    // no-op
  },
  logStderr: () => {
    // no-op
  },
  logComplete: () => {
    // no-op
  },
};

describe("devcontainerUp", () => {
  it("rejects before spawning when already aborted", async () => {
    const abortController = new AbortController();
    abortController.abort();

    try {
      await devcontainerUp({
        workspaceFolder: "/tmp/does-not-need-to-exist",
        initLogger: noopInitLogger,
        abortSignal: abortController.signal,
      });
      throw new Error("Expected devcontainerUp to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("devcontainer up aborted");
    }
  });
});

describe("parseDevcontainerStdoutLine", () => {
  it("parses JSON log lines with text", () => {
    const line = JSON.stringify({ type: "text", level: 3, text: "Building..." });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Building...",
    });
  });

  it("parses progress lines with name and status", () => {
    const line = JSON.stringify({
      type: "progress",
      name: "Running postCreateCommand...",
      status: "succeeded",
      channel: "postCreate",
    });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Running postCreateCommand...",
    });
  });

  it("parses error channel text below level 2", () => {
    const line = JSON.stringify({ type: "text", level: 1, text: "Oops", channel: "error" });
    expect(parseDevcontainerStdoutLine(line)).toEqual({
      kind: "log",
      text: "Oops",
    });
  });
  it("skips text lines below level 2", () => {
    const line = JSON.stringify({ type: "text", level: 1, text: "debug" });
    expect(parseDevcontainerStdoutLine(line)).toBeNull();
  });

  it("parses result lines", () => {
    const line = JSON.stringify({
      outcome: "success",
      containerId: "abc123",
      remoteUser: "node",
      remoteWorkspaceFolder: "/workspaces/demo",
    });
    const parsed = parseDevcontainerStdoutLine(line);
    expect(parsed?.kind).toBe("result");
    if (parsed?.kind === "result") {
      expect(parsed.result.containerId).toBe("abc123");
    }
  });

  it("falls back to raw lines for non-JSON output", () => {
    expect(parseDevcontainerStdoutLine("not json")).toEqual({
      kind: "raw",
      text: "not json",
    });
  });
});

describe("formatDevcontainerUpError", () => {
  it("prefers message and description", () => {
    expect(
      formatDevcontainerUpError({
        outcome: "error",
        message: "Command failed",
        description: "postCreateCommand failed",
      })
    ).toBe("devcontainer up failed: Command failed - postCreateCommand failed");
  });

  it("falls back to stderr summary", () => {
    expect(formatDevcontainerUpError({ outcome: "error" }, "stderr info")).toBe(
      "devcontainer up failed: stderr info"
    );
  });
});

describe("shouldCleanupDevcontainer", () => {
  it("returns true for error results with containerId", () => {
    expect(shouldCleanupDevcontainer({ outcome: "error", containerId: "abc" })).toBe(true);
  });

  it("returns false for error results without containerId", () => {
    expect(shouldCleanupDevcontainer({ outcome: "error" })).toBe(false);
  });

  it("returns false for success results", () => {
    expect(shouldCleanupDevcontainer({ outcome: "success", containerId: "abc" })).toBe(false);
  });
});

describe("spawnDevcontainer", () => {
  interface SpawnCall {
    command: string;
    args: string[];
    options: SpawnOptions;
  }

  function makeSpawnRecorder() {
    const calls: SpawnCall[] = [];
    const spawnFn = (command: string, args: string[], options: SpawnOptions): ChildProcess => {
      calls.push({ command, args, options });
      return new EventEmitter() as unknown as ChildProcess;
    };
    return { calls, spawnFn };
  }

  function makeDeps(overrides: Partial<DevcontainerSpawnDeps>) {
    const posix = makeSpawnRecorder();
    const win32 = makeSpawnRecorder();
    const lookups: string[] = [];
    const deps: DevcontainerSpawnDeps = {
      platform: "linux",
      lookupCommand: (command) => {
        lookups.push(command);
        return null;
      },
      posixSpawn: posix.spawnFn,
      win32Spawn: win32.spawnFn,
      ...overrides,
    };
    return { deps, posix, win32, lookups };
  }

  it("resolves the .cmd shim via PATH lookup on win32 and passes args/options through", () => {
    const { deps, posix, win32 } = makeDeps({
      platform: "win32",
      lookupCommand: () => [
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\devcontainer",
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\devcontainer.cmd",
        "C:\\Users\\dev\\AppData\\Roaming\\npm\\devcontainer.ps1",
      ],
    });
    const args = ["exec", "--", "bash", "-c", "echo hi && echo 'quoted arg'"];
    const options: SpawnOptions = { detached: true, windowsHide: true };

    spawnDevcontainer(args, options, deps);

    expect(posix.calls).toHaveLength(0);
    expect(win32.calls).toHaveLength(1);
    expect(win32.calls[0].command).toBe("C:\\Users\\dev\\AppData\\Roaming\\npm\\devcontainer.cmd");
    expect(win32.calls[0].args).toBe(args);
    expect(win32.calls[0].options).toBe(options);
    expect(win32.calls[0].options.shell).toBeUndefined();
  });

  it("falls back to the bare command when the win32 lookup fails", () => {
    const { deps, win32 } = makeDeps({ platform: "win32", lookupCommand: () => null });

    spawnDevcontainer(["--version"], {}, deps);

    expect(win32.calls).toHaveLength(1);
    expect(win32.calls[0].command).toBe("devcontainer");
  });

  it("falls back to the first lookup line when no executable extension matches", () => {
    const { deps, win32 } = makeDeps({
      platform: "win32",
      lookupCommand: () => ["  C:\\tools\\devcontainer  ", ""],
    });

    spawnDevcontainer(["--version"], {}, deps);

    expect(win32.calls[0].command).toBe("C:\\tools\\devcontainer");
  });

  it("uses native spawn on posix without running any PATH lookup", () => {
    const { deps, posix, win32, lookups } = makeDeps({ platform: "linux" });
    const args = ["up", "--workspace-folder", "/repo"];
    const options: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"], timeout: 1000 };

    spawnDevcontainer(args, options, deps);

    expect(win32.calls).toHaveLength(0);
    expect(lookups).toHaveLength(0);
    expect(posix.calls).toHaveLength(1);
    expect(posix.calls[0].command).toBe("devcontainer");
    expect(posix.calls[0].args).toBe(args);
    expect(posix.calls[0].options).toBe(options);
  });
});
