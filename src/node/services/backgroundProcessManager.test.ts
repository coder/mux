import { describe, it, expect, beforeEach } from "bun:test";
import { BackgroundProcessManager } from "./backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";

// Create test runtime (uses local machine)
function createTestRuntime(): Runtime {
  return new LocalRuntime(process.cwd());
}

describe("BackgroundProcessManager", () => {
  let manager: BackgroundProcessManager;
  let runtime: Runtime;
  const testWorkspaceId = "workspace-1";
  const testWorkspaceId2 = "workspace-2";

  beforeEach(() => {
    manager = new BackgroundProcessManager();
    runtime = createTestRuntime();
  });

  describe("spawn", () => {
    it("should spawn a background process and return process ID", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.processId).toMatch(/^bg-/);
      }
    });

    it("should return error on spawn failure", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test", {
        cwd: "/nonexistent/path/that/does/not/exist",
      });

      expect(result.success).toBe(false);
    });

    it("should capture stdout and stderr", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello; echo world >&2", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Wait a moment for output to be captured
        await new Promise((resolve) => setTimeout(resolve, 100));

        const process = manager.getProcess(result.processId);
        expect(process).not.toBeNull();
        expect(process?.stdoutBuffer.toArray()).toContain("hello");
        expect(process?.stderrBuffer.toArray()).toContain("world");
      }
    });

    it("should handle ring buffer overflow", async () => {
      // Generate more than 1000 lines
      const script = Array(1100)
        .fill(0)
        .map((_, i) => `echo line${i}`)
        .join("; ");

      const result = await manager.spawn(runtime, testWorkspaceId, script, {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        await new Promise((resolve) => setTimeout(resolve, 500));

        const process = manager.getProcess(result.processId);
        expect(process).not.toBeNull();
        // Buffer should be capped at 1000 lines
        expect(process!.stdoutBuffer.length).toBeLessThanOrEqual(1000);
      }
    });
  });

  describe("getProcess", () => {
    it("should return process by ID", async () => {
      const spawnResult = await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
      });

      if (spawnResult.success) {
        const process = manager.getProcess(spawnResult.processId);
        expect(process).not.toBeNull();
        expect(process?.id).toBe(spawnResult.processId);
        expect(process?.status).toBe("running");
      }
    });

    it("should return null for non-existent process", () => {
      const process = manager.getProcess("bg-nonexistent");
      expect(process).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all processes", async () => {
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", { cwd: process.cwd() });
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", { cwd: process.cwd() });

      const processes = manager.list();
      expect(processes.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by workspace ID", async () => {
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", { cwd: process.cwd() });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 1", { cwd: process.cwd() });

      const ws1Processes = manager.list(testWorkspaceId);
      const ws2Processes = manager.list(testWorkspaceId2);

      expect(ws1Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws2Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws1Processes.every((p) => p.workspaceId === testWorkspaceId)).toBe(true);
      expect(ws2Processes.every((p) => p.workspaceId === testWorkspaceId2)).toBe(true);
    });
  });

  describe("terminate", () => {
    it("should terminate a running process", async () => {
      const spawnResult = await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
      });

      if (spawnResult.success) {
        const terminateResult = await manager.terminate(spawnResult.processId);
        expect(terminateResult.success).toBe(true);

        const process = manager.getProcess(spawnResult.processId);
        expect(process?.status).toMatch(/killed|exited/);
      }
    });

    it("should return error for non-existent process", async () => {
      const result = await manager.terminate("bg-nonexistent");
      expect(result.success).toBe(false);
    });

    it("should be idempotent (double-terminate succeeds)", async () => {
      const spawnResult = await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
      });

      if (spawnResult.success) {
        const result1 = await manager.terminate(spawnResult.processId);
        expect(result1.success).toBe(true);

        const result2 = await manager.terminate(spawnResult.processId);
        expect(result2.success).toBe(true);
      }
    });
  });

  describe("cleanup", () => {
    it("should kill all processes for a workspace", async () => {
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", { cwd: process.cwd() });
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", { cwd: process.cwd() });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 10", { cwd: process.cwd() });

      await manager.cleanup(testWorkspaceId);

      const ws1Processes = manager.list(testWorkspaceId);
      const ws2Processes = manager.list(testWorkspaceId2);
      // All testWorkspaceId processes should be removed from memory
      expect(ws1Processes.length).toBe(0);
      // workspace-2 processes should still exist and be running
      expect(ws2Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws2Processes.some((p) => p.status === "running")).toBe(true);
    });
  });

  describe("process state tracking", () => {
    it("should track process exit", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "exit 42", {
        cwd: process.cwd(),
      });

      if (result.success) {
        // Wait for process to exit
        await new Promise((resolve) => setTimeout(resolve, 200));

        const process = manager.getProcess(result.processId);
        expect(process?.status).toBe("exited");
        expect(process?.exitCode).toBe(42);
        expect(process?.exitTime).not.toBeNull();
      }
    });

    it("should keep buffer after process exits", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test; exit 0", {
        cwd: process.cwd(),
      });

      if (result.success) {
        await new Promise((resolve) => setTimeout(resolve, 200));

        const process = manager.getProcess(result.processId);
        expect(process?.status).toBe("exited");
        expect(process?.stdoutBuffer.toArray()).toContain("test");
      }
    });

    it("should preserve killed status after onExit callback fires", async () => {
      // Spawn a long-running process
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 60", {
        cwd: process.cwd(),
      });

      if (result.success) {
        // Terminate it
        await manager.terminate(result.processId);

        // Wait for onExit callback to fire
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Status should still be "killed", not "exited"
        const proc = manager.getProcess(result.processId);
        expect(proc?.status).toBe("killed");
      }
    });

    it("should report non-zero exit code for signal-terminated processes", async () => {
      // Spawn a long-running process
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 60", {
        cwd: process.cwd(),
      });

      if (result.success) {
        // Terminate it (sends SIGTERM, then SIGKILL after 2s)
        await manager.terminate(result.processId);

        // Wait for exit to be recorded
        await new Promise((resolve) => setTimeout(resolve, 100));

        const proc = manager.getProcess(result.processId);
        expect(proc).not.toBeNull();
        // Exit code should be 128 + signal number (SIGTERM=15 → 143, SIGKILL=9 → 137)
        // Either is acceptable depending on timing
        expect(proc!.exitCode).toBeGreaterThanOrEqual(128);
      }
    });
  });
});
