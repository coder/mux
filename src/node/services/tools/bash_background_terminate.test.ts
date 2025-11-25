import { describe, it, expect } from "bun:test";
import { createBashBackgroundTerminateTool } from "./bash_background_terminate";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { BashExecutionService } from "@/node/services/bashExecutionService";
import { LocalBackgroundExecutor } from "@/node/services/localBackgroundExecutor";
import type {
  BashBackgroundTerminateArgs,
  BashBackgroundTerminateResult,
} from "@/common/types/tools";
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

describe("bash_background_terminate tool", () => {
  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-bg-term");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: "bg-test",
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error for non-existent process", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-term");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: "bg-nonexistent",
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(false);
  });

  it("should terminate a running process", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-term");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a long-running process
    const spawnResult = await manager.spawn("test-workspace", "sleep 10", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: spawnResult.processId,
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.message).toContain(spawnResult.processId);
    }

    // Verify process is no longer running
    const bgProcess = manager.getProcess(spawnResult.processId);
    expect(bgProcess?.status).not.toBe("running");

    tempDir[Symbol.dispose]();
  });

  it("should be idempotent (double-terminate succeeds)", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-term");
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

    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: spawnResult.processId,
    };

    // First termination
    const result1 = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;
    expect(result1.success).toBe(true);

    // Second termination
    const result2 = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;
    expect(result2.success).toBe(true);

    tempDir[Symbol.dispose]();
  });

  it("should not terminate processes from other workspaces", async () => {
    const manager = new BackgroundProcessManager();
    manager.registerExecutor("workspace-a", new LocalBackgroundExecutor(new BashExecutionService()));
    manager.registerExecutor("workspace-b", new LocalBackgroundExecutor(new BashExecutionService()));

    const tempDir = new TestTempDir("test-bash-bg-term");
    // Config is for workspace-a
    const config = createTestToolConfig(process.cwd(), { workspaceId: "workspace-a" });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn process in workspace-b
    const spawnResult = await manager.spawn("workspace-b", "sleep 10", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Try to terminate from workspace-a (should fail)
    const tool = createBashBackgroundTerminateTool(config);
    const args: BashBackgroundTerminateArgs = {
      process_id: spawnResult.processId,
    };

    const result = (await tool.execute!(
      args,
      mockToolCallOptions
    )) as BashBackgroundTerminateResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    // Process should still be running
    const proc = manager.getProcess(spawnResult.processId);
    expect(proc?.status).toBe("running");

    // Cleanup
    await manager.terminate(spawnResult.processId);
    tempDir[Symbol.dispose]();
  });
});
