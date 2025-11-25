import { describe, it, expect } from "bun:test";
import { createBashBackgroundListTool } from "./bash_background_list";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { BashExecutionService } from "@/node/services/bashExecutionService";
import { LocalBackgroundExecutor } from "@/node/services/localBackgroundExecutor";
import type { BashBackgroundListResult } from "@/common/types/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { ToolCallOptions } from "ai";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

// Helper to create manager with executor registered for a workspace
function createManagerWithExecutor(workspaceId: string): BackgroundProcessManager {
  const manager = new BackgroundProcessManager();
  manager.registerExecutor(workspaceId, new LocalBackgroundExecutor(new BashExecutionService()));
  return manager;
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
    const manager = createManagerWithExecutor("test-workspace");
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
    const manager = createManagerWithExecutor("test-workspace");
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
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-list");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process
    const spawnResult = await manager.spawn("test-workspace", "sleep 10", {
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
    }

    // Cleanup
    await manager.terminate(spawnResult.processId);
    tempDir[Symbol.dispose]();
  });

  it("should only list processes for the current workspace", async () => {
    const manager = new BackgroundProcessManager();
    manager.registerExecutor("workspace-a", new LocalBackgroundExecutor(new BashExecutionService()));
    manager.registerExecutor("workspace-b", new LocalBackgroundExecutor(new BashExecutionService()));

    const tempDir = new TestTempDir("test-bash-bg-list");
    const config = createTestToolConfig(process.cwd(), { workspaceId: "workspace-a" });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn processes in different workspaces
    const spawnA = await manager.spawn("workspace-a", "sleep 10", { cwd: process.cwd() });
    const spawnB = await manager.spawn("workspace-b", "sleep 10", { cwd: process.cwd() });

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
    await manager.terminate(spawnA.processId);
    await manager.terminate(spawnB.processId);
    tempDir[Symbol.dispose]();
  });
});
