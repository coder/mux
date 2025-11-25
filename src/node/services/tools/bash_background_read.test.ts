import { describe, it, expect } from "bun:test";
import { createBashBackgroundReadTool } from "./bash_background_read";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { BashExecutionService } from "@/node/services/bashExecutionService";
import { LocalBackgroundExecutor } from "@/node/services/localBackgroundExecutor";
import type { BashBackgroundReadArgs, BashBackgroundReadResult } from "@/common/types/tools";
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

describe("bash_background_read tool", () => {
  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-bg-read");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashBackgroundReadTool(config);
    const args: BashBackgroundReadArgs = {
      process_id: "bg-test",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashBackgroundReadResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error for non-existent process", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-read");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashBackgroundReadTool(config);
    const args: BashBackgroundReadArgs = {
      process_id: "bg-nonexistent",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashBackgroundReadResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return process status and output", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-read");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process
    const spawnResult = await manager.spawn("test-workspace", "echo hello; sleep 1", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for output
    await new Promise((resolve) => setTimeout(resolve, 100));

    const tool = createBashBackgroundReadTool(config);
    const args: BashBackgroundReadArgs = {
      process_id: spawnResult.processId,
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashBackgroundReadResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.process_id).toBe(spawnResult.processId);
      expect(result.status).toBe("running");
      expect(result.stdout).toContain("hello");
      expect(result.uptime_ms).toBeGreaterThan(0);
    }

    tempDir[Symbol.dispose]();
  });

  it("should handle tail filtering", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-read");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process with multiple lines
    const spawnResult = await manager.spawn(
      "test-workspace",
      "echo line1; echo line2; echo line3",
      {
        cwd: process.cwd(),
      }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const tool = createBashBackgroundReadTool(config);
    const args: BashBackgroundReadArgs = {
      process_id: spawnResult.processId,
      stdout_tail: 2,
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashBackgroundReadResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stdout.length).toBeLessThanOrEqual(2);
    }

    tempDir[Symbol.dispose]();
  });

  it("should handle regex filtering", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-read");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const spawnResult = await manager.spawn("test-workspace", "echo ERROR: test; echo INFO: test", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const tool = createBashBackgroundReadTool(config);
    const args: BashBackgroundReadArgs = {
      process_id: spawnResult.processId,
      stdout_regex: "ERROR",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashBackgroundReadResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.stdout.every((line) => line.includes("ERROR"))).toBe(true);
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error for invalid regex pattern", async () => {
    const manager = createManagerWithExecutor("test-workspace");
    const tempDir = new TestTempDir("test-bash-bg-read");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const spawnResult = await manager.spawn("test-workspace", "echo test", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    const tool = createBashBackgroundReadTool(config);
    const args: BashBackgroundReadArgs = {
      process_id: spawnResult.processId,
      stdout_regex: "[invalid(", // Invalid regex pattern
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashBackgroundReadResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid regex pattern");
      expect(result.error).toContain("stdout_regex");
    }

    tempDir[Symbol.dispose]();
  });

  it("should not read processes from other workspaces", async () => {
    const manager = new BackgroundProcessManager();
    manager.registerExecutor(
      "workspace-a",
      new LocalBackgroundExecutor(new BashExecutionService())
    );
    manager.registerExecutor(
      "workspace-b",
      new LocalBackgroundExecutor(new BashExecutionService())
    );

    const tempDir = new TestTempDir("test-bash-bg-read");
    // Config is for workspace-a
    const config = createTestToolConfig(process.cwd(), { workspaceId: "workspace-a" });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn process in workspace-b
    const spawnResult = await manager.spawn("workspace-b", "echo secret", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Try to read from workspace-a (should fail)
    const tool = createBashBackgroundReadTool(config);
    const args: BashBackgroundReadArgs = {
      process_id: spawnResult.processId,
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as BashBackgroundReadResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    tempDir[Symbol.dispose]();
  });
});
