import { EventEmitter } from "events";
import { Readable } from "stream";
import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { CoderService, compareVersions } from "./coderService";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

// Mock execAsync

// Mock spawn for streaming createWorkspace()
void vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "child_process";

const mockSpawn = spawn as ReturnType<typeof vi.fn>;
void vi.mock("@/node/utils/disposableExec", () => ({
  execAsync: vi.fn(),
}));

// Import the mock after vi.mock
import { execAsync } from "@/node/utils/disposableExec";

const mockExecAsync = execAsync as ReturnType<typeof vi.fn>;

describe("CoderService", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    service.clearCache();
  });

  describe("getCoderInfo", () => {
    it("returns available: true with valid version", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }) }),
        [Symbol.dispose]: noop,
      });

      const info = await service.getCoderInfo();

      expect(info).toEqual({ available: true, version: "2.28.2" });
    });

    it("returns available: true for exact minimum version", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: JSON.stringify({ version: "2.25.0" }) }),
        [Symbol.dispose]: noop,
      });

      const info = await service.getCoderInfo();

      expect(info).toEqual({ available: true, version: "2.25.0" });
    });

    it("returns available: false for version below minimum", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: JSON.stringify({ version: "2.24.9" }) }),
        [Symbol.dispose]: noop,
      });

      const info = await service.getCoderInfo();

      expect(info).toEqual({ available: false });
    });

    it("handles version with dev suffix", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2-devel+903c045b9" }) }),
        [Symbol.dispose]: noop,
      });

      const info = await service.getCoderInfo();

      expect(info).toEqual({ available: true, version: "2.28.2-devel+903c045b9" });
    });

    it("returns available: false when CLI not installed", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.reject(new Error("command not found: coder")),
        [Symbol.dispose]: noop,
      });

      const info = await service.getCoderInfo();

      expect(info).toEqual({ available: false });
    });

    it("caches the result", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }) }),
        [Symbol.dispose]: noop,
      });

      await service.getCoderInfo();
      await service.getCoderInfo();

      expect(mockExecAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe("listTemplates", () => {
    it("returns templates with display names", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({
          stdout: JSON.stringify([
            { name: "template-1", display_name: "Template One", organization_name: "org1" },
            { name: "template-2", display_name: "Template Two" },
          ]),
        }),
        [Symbol.dispose]: noop,
      });

      const templates = await service.listTemplates();

      expect(templates).toEqual([
        { name: "template-1", displayName: "Template One", organizationName: "org1" },
        { name: "template-2", displayName: "Template Two", organizationName: "default" },
      ]);
    });

    it("uses name as displayName when display_name not present", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({
          stdout: JSON.stringify([{ name: "my-template" }]),
        }),
        [Symbol.dispose]: noop,
      });

      const templates = await service.listTemplates();

      expect(templates).toEqual([
        { name: "my-template", displayName: "my-template", organizationName: "default" },
      ]);
    });

    it("returns empty array on error", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.reject(new Error("not logged in")),
        [Symbol.dispose]: noop,
      });

      const templates = await service.listTemplates();

      expect(templates).toEqual([]);
    });

    it("returns empty array for empty output", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: "" }),
        [Symbol.dispose]: noop,
      });

      const templates = await service.listTemplates();

      expect(templates).toEqual([]);
    });
  });

  describe("listPresets", () => {
    it("returns presets for a template", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({
          stdout: JSON.stringify([
            { id: "preset-1", name: "Small", description: "Small instance", is_default: true },
            { id: "preset-2", name: "Large", description: "Large instance" },
          ]),
        }),
        [Symbol.dispose]: noop,
      });

      const presets = await service.listPresets("my-template");

      expect(presets).toEqual([
        { id: "preset-1", name: "Small", description: "Small instance", isDefault: true },
        { id: "preset-2", name: "Large", description: "Large instance", isDefault: false },
      ]);
    });

    it("returns empty array when template has no presets", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: "" }),
        [Symbol.dispose]: noop,
      });

      const presets = await service.listPresets("no-presets-template");

      expect(presets).toEqual([]);
    });

    it("returns empty array on error", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.reject(new Error("template not found")),
        [Symbol.dispose]: noop,
      });

      const presets = await service.listPresets("nonexistent");

      expect(presets).toEqual([]);
    });
  });

  describe("listWorkspaces", () => {
    it("returns only running workspaces by default", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({
          stdout: JSON.stringify([
            { name: "ws-1", template_name: "t1", latest_build: { status: "running" } },
            { name: "ws-2", template_name: "t2", latest_build: { status: "stopped" } },
            { name: "ws-3", template_name: "t3", latest_build: { status: "running" } },
          ]),
        }),
        [Symbol.dispose]: noop,
      });

      const workspaces = await service.listWorkspaces();

      expect(workspaces).toEqual([
        { name: "ws-1", templateName: "t1", status: "running" },
        { name: "ws-3", templateName: "t3", status: "running" },
      ]);
    });

    it("returns all workspaces when filterRunning is false", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({
          stdout: JSON.stringify([
            { name: "ws-1", template_name: "t1", latest_build: { status: "running" } },
            { name: "ws-2", template_name: "t2", latest_build: { status: "stopped" } },
          ]),
        }),
        [Symbol.dispose]: noop,
      });

      const workspaces = await service.listWorkspaces(false);

      expect(workspaces).toEqual([
        { name: "ws-1", templateName: "t1", status: "running" },
        { name: "ws-2", templateName: "t2", status: "stopped" },
      ]);
    });

    it("returns empty array on error", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.reject(new Error("not logged in")),
        [Symbol.dispose]: noop,
      });

      const workspaces = await service.listWorkspaces();

      expect(workspaces).toEqual([]);
    });
  });

  describe("createWorkspace", () => {
    it("streams stdout/stderr lines and passes expected args", async () => {
      const stdout = Readable.from([Buffer.from("out-1\nout-2\n")]);
      const stderr = Readable.from([Buffer.from("err-1\n")]);
      const events = new EventEmitter();

      mockSpawn.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      // Emit close after handlers are attached.
      setTimeout(() => events.emit("close", 0), 0);

      const lines: string[] = [];
      for await (const line of service.createWorkspace("my-workspace", "my-template")) {
        lines.push(line);
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        "coder",
        ["create", "my-workspace", "-t", "my-template", "--yes"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      expect(lines.sort()).toEqual(["err-1", "out-1", "out-2"]);
    });

    it("includes --preset when provided", async () => {
      const stdout = Readable.from([]);
      const stderr = Readable.from([]);
      const events = new EventEmitter();

      mockSpawn.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      setTimeout(() => events.emit("close", 0), 0);

      for await (const _line of service.createWorkspace("ws", "tmpl", "preset")) {
        // drain
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        "coder",
        ["create", "ws", "-t", "tmpl", "--yes", "--preset", "preset"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    it("throws when exit code is non-zero", async () => {
      const stdout = Readable.from([]);
      const stderr = Readable.from([]);
      const events = new EventEmitter();

      mockSpawn.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      setTimeout(() => events.emit("close", 42), 0);

      let thrown: unknown;
      try {
        for await (const _line of service.createWorkspace("ws", "tmpl")) {
          // drain
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("exit code 42");
    });

    it("aborts by killing the child process", async () => {
      const stdout = new Readable({
        read() {
          // Keep stream open until aborted.
          return;
        },
      });
      const stderr = new Readable({
        read() {
          // Keep stream open until aborted.
          return;
        },
      });
      const events = new EventEmitter();

      const kill = vi.fn(() => {
        stdout.destroy();
        stderr.destroy();
        events.emit("close", null);
      });

      mockSpawn.mockReturnValue({
        stdout,
        stderr,
        kill,
        on: events.on.bind(events),
      } as never);

      const abortController = new AbortController();
      const iterator = service.createWorkspace("ws", "tmpl", undefined, abortController.signal);

      const pending = iterator.next();
      abortController.abort();

      let thrown: unknown;
      try {
        await pending;
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("aborted");
      expect(kill).toHaveBeenCalled();
    });
  });

  describe("deleteWorkspace", () => {
    it("calls coder delete with --yes flag", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: "", stderr: "" }),
        [Symbol.dispose]: noop,
      });

      await service.deleteWorkspace("my-workspace");

      expect(mockExecAsync).toHaveBeenCalledWith("coder delete 'my-workspace' --yes");
    });
  });

  describe("ensureSSHConfig", () => {
    it("calls coder config-ssh with --yes flag", async () => {
      mockExecAsync.mockReturnValue({
        result: Promise.resolve({ stdout: "", stderr: "" }),
        [Symbol.dispose]: noop,
      });

      await service.ensureSSHConfig();

      expect(mockExecAsync).toHaveBeenCalledWith("coder config-ssh --yes");
    });
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("2.28.6", "2.28.6")).toBe(0);
  });

  it("returns 0 for equal versions with different formats", () => {
    expect(compareVersions("v2.28.6", "2.28.6")).toBe(0);
    expect(compareVersions("v2.28.6+hash", "2.28.6")).toBe(0);
  });

  it("returns negative when first version is older", () => {
    expect(compareVersions("2.25.0", "2.28.6")).toBeLessThan(0);
    expect(compareVersions("2.28.5", "2.28.6")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns positive when first version is newer", () => {
    expect(compareVersions("2.28.6", "2.25.0")).toBeGreaterThan(0);
    expect(compareVersions("2.28.6", "2.28.5")).toBeGreaterThan(0);
    expect(compareVersions("3.0.0", "2.28.6")).toBeGreaterThan(0);
  });

  it("handles versions with v prefix", () => {
    expect(compareVersions("v2.28.6", "2.25.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.25.0", "v2.28.6")).toBeLessThan(0);
  });

  it("handles dev versions correctly", () => {
    // v2.28.2-devel+903c045b9 should be compared as 2.28.2
    expect(compareVersions("v2.28.2-devel+903c045b9", "2.25.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.28.2-devel+903c045b9", "2.28.2")).toBe(0);
  });

  it("handles missing patch version", () => {
    expect(compareVersions("2.28", "2.28.0")).toBe(0);
    expect(compareVersions("2.28", "2.28.1")).toBeLessThan(0);
  });
});
