import { describe, it, expect } from "bun:test";
import { createBashOutputTool } from "./bash_output";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import type { BashOutputToolResult } from "@/common/types/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import type { ToolCallOptions } from "ai";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

// Create test runtime
function createTestRuntime(): Runtime {
  return new LocalRuntime(process.cwd());
}

describe("bash_output tool", () => {
  it("should return error when manager not available", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1" },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Background process manager not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error when workspaceId not available", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;
    delete config.workspaceId;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1" },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Workspace ID not available");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return error for non-existent process", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const config = createTestToolConfig(process.cwd());
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: "bash_1" },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    tempDir[Symbol.dispose]();
  });

  it("should return incremental output from process", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that outputs incrementally
    const spawnResult = await manager.spawn(
      runtime,
      "test-workspace",
      "echo 'line1'; sleep 0.5; echo 'line2'",
      { cwd: process.cwd() }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);

    // Wait a bit for first output
    await new Promise((r) => setTimeout(r, 200));

    // First call - should get some output
    const result1 = (await tool.execute!(
      { process_id: spawnResult.processId },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result1.success).toBe(true);
    if (result1.success) {
      expect(result1.stdout).toContain("line1");
    }

    // Wait for more output
    await new Promise((r) => setTimeout(r, 600));

    // Second call - should ONLY get new output (incremental)
    const result2 = (await tool.execute!(
      { process_id: spawnResult.processId },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result2.success).toBe(true);
    if (result2.success) {
      // Should contain line2 but NOT line1 (already read)
      expect(result2.stdout).toContain("line2");
      expect(result2.stdout).not.toContain("line1");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should filter output with regex", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that outputs multiple lines
    const spawnResult = await manager.spawn(
      runtime,
      "test-workspace",
      "echo 'ERROR: something failed'; echo 'INFO: everything ok'; echo 'ERROR: another error'",
      { cwd: process.cwd() }
    );

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for output
    await new Promise((r) => setTimeout(r, 200));

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, filter: "ERROR" },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      // Should only contain ERROR lines
      expect(result.stdout).toContain("ERROR");
      expect(result.stdout).not.toContain("INFO");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should return error for invalid regex filter", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    const spawnResult = await manager.spawn(runtime, "test-workspace", "echo 'test'", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for output
    await new Promise((r) => setTimeout(r, 100));

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId, filter: "[invalid(" },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid filter regex");
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });

  it("should not return output from other workspace's processes", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();

    const config = createTestToolConfig(process.cwd(), {
      workspaceId: "workspace-a",
      sessionsDir: tempDir.path,
    });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn process in different workspace
    const spawnResult = await manager.spawn(runtime, "workspace-b", "echo 'test'", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Process not found");
    }

    // Cleanup
    await manager.cleanup("workspace-b");
    tempDir[Symbol.dispose]();
  });

  it("should include process status and exit code", async () => {
    const tempDir = new TestTempDir("test-bash-output");
    const manager = new BackgroundProcessManager(tempDir.path);

    const runtime = createTestRuntime();
    const config = createTestToolConfig(process.cwd(), { sessionsDir: tempDir.path });
    config.runtimeTempDir = tempDir.path;
    config.backgroundProcessManager = manager;

    // Spawn a process that exits quickly
    const spawnResult = await manager.spawn(runtime, "test-workspace", "echo 'done'", {
      cwd: process.cwd(),
    });

    if (!spawnResult.success) {
      throw new Error("Failed to spawn process");
    }

    // Wait for process to exit
    await new Promise((r) => setTimeout(r, 200));

    const tool = createBashOutputTool(config);
    const result = (await tool.execute!(
      { process_id: spawnResult.processId },
      mockToolCallOptions
    )) as BashOutputToolResult;

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.status).toBe("exited");
      expect(result.exitCode).toBe(0);
    }

    // Cleanup
    await manager.cleanup("test-workspace");
    tempDir[Symbol.dispose]();
  });
});
