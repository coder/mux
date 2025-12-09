import { describe, it, expect } from "bun:test";
import { createBashBackgroundListTool } from "./bash_background_list";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import type { BashBackgroundListResult } from "@/common/types/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { ToolCallOptions } from "ai";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

// Create test runtime with isolated sessions directory
function createTestRuntime(sessionsDir: string): Runtime {
  return new LocalRuntime(process.cwd(), sessionsDir);
}

describe("bash_background_list tool", () => {
  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-bg-list");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error when workspaceId not available", async () => {
    const manager = new BackgroundProcessManager();
    const tempDir = new TestTempDir("test-bash-bg-list");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;
    delete config.workspaceId; // Explicitly remove workspaceId

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Workspace ID not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return empty list when no processes", async () => {
    const manager = new BackgroundProcessManager();
    const tempDir = new TestTempDir("test-bash-bg-list");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes).toEqual([]);
    }

    tempDir[Symbol.dispose]();
  });

  it("should list spawned processes with correct fields", async () => {
    const manager = new BackgroundProcessManager();
    const tempDir = new TestTempDir("test-bash-bg-list");
    const runtime = createTestRuntime(tempDir.path);
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 10", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes.length).toBe(1);
      const proc = result.processes[0];
      expect(proc.process_id).toBe(spawnResult.processId);
      expect(proc.status).toBe("running");
      expect(proc.script).toBe("sleep 10");
      expect(proc.uptime_ms).toBeGreaterThanOrEqual(0);
      expect(proc.exitCode).toBeUndefined();
      expect(proc.stdout_path).toContain("stdout.log");
      expect(proc.stderr_path).toContain("stderr.log");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should include display_name in listed processes", async () => {
    const manager = new BackgroundProcessManager();
    const tempDir = new TestTempDir("test-bash-bg-list");
    const runtime = createTestRuntime(tempDir.path);
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process with display_name
    const spawnResult = await manager.spawn(runtime, "test-workspace", "sleep 10", {
      cwd: process.cwd(),
      displayName: "Dev Server",
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes.length).toBe(1);
      expect(result.processes[0].display_name).toBe("Dev Server");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should only list processes for the current workspace", async () => {
    const manager = new BackgroundProcessManager();
    const tempDir = new TestTempDir("test-bash-bg-list");
    const runtime = createTestRuntime(tempDir.path);

    const config = createTestToolConfig(process.cwd(), {
      workspaceId: "workspace-a",
      sessionsDir: tempDir.path,
    });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn processes in different workspaces
    const spawnA = await manager.spawn(runtime, "workspace-a", "sleep 10", {
      cwd: process.cwd(),
    });
    const spawnB = await manager.spawn(runtime, "workspace-b", "sleep 10", {
      cwd: process.cwd(),
    });

    if (!spawnA.success || !spawnB.success) {
      throw new Error("Failed to spawn processes");
    }

    const tool = createBashBackgroundListTool(config);
    const result = (await tool.execute!({}, mockToolCallOptions)) as BashBackgroundListResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.processes.length).toBe(1);
      expect(result.processes[0].process_id).toBe(spawnA.processId);
    }

    // Cleanup
    await manager.cleanup("workspace-a");
    await manager.cleanup("workspace-b");
    tempDir[Symbol.dispose]();
  });
});
