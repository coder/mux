import { describe, it, expect, beforeEach } from "bun:test";
import { BackgroundProcessManager } from "./backgroundProcessManager";
import { BashExecutionService } from "./bashExecutionService";

describe("BackgroundProcessManager", () => {
  let manager: BackgroundProcessManager;
  let bashService: BashExecutionService;

  beforeEach(() => {
    bashService = new BashExecutionService();
    manager = new BackgroundProcessManager(bashService);
  });

  describe("spawn", () => {
    it("should spawn a background process and return process ID", async () => {
      const result = await manager.spawn("workspace-1", "echo hello", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.processId).toMatch(/^bg-/);
      }
    });

    it("should return error on spawn failure", async () => {
      const result = await manager.spawn("workspace-1", "echo test", {
        cwd: "/nonexistent/path/that/does/not/exist",
      });

      expect(result.success).toBe(false);
    });

    it("should capture stdout and stderr", async () => {
      const result = await manager.spawn("workspace-1", "echo hello; echo world >&2", {
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

      const result = await manager.spawn("workspace-1", script, {
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
      const spawnResult = await manager.spawn("workspace-1", "sleep 1", {
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
      await manager.spawn("workspace-1", "sleep 1", { cwd: process.cwd() });
      await manager.spawn("workspace-1", "sleep 1", { cwd: process.cwd() });

      const processes = manager.list();
      expect(processes.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by workspace ID", async () => {
      await manager.spawn("workspace-1", "sleep 1", { cwd: process.cwd() });
      await manager.spawn("workspace-2", "sleep 1", { cwd: process.cwd() });

      const ws1Processes = manager.list("workspace-1");
      const ws2Processes = manager.list("workspace-2");

      expect(ws1Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws2Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws1Processes.every((p) => p.workspaceId === "workspace-1")).toBe(true);
      expect(ws2Processes.every((p) => p.workspaceId === "workspace-2")).toBe(true);
    });
  });

  describe("terminate", () => {
    it("should terminate a running process", async () => {
      const spawnResult = await manager.spawn("workspace-1", "sleep 10", {
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
      const spawnResult = await manager.spawn("workspace-1", "sleep 10", {
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
    it("should kill all processes for a workspace and remove them from memory", async () => {
      await manager.spawn("workspace-1", "sleep 10", { cwd: process.cwd() });
      await manager.spawn("workspace-1", "sleep 10", { cwd: process.cwd() });
      await manager.spawn("workspace-2", "sleep 10", { cwd: process.cwd() });

      await manager.cleanup("workspace-1");

      const ws1Processes = manager.list("workspace-1");
      const ws2Processes = manager.list("workspace-2");

      // All workspace-1 processes should be removed from memory
      expect(ws1Processes.length).toBe(0);
      // workspace-2 processes should still exist and be running
      expect(ws2Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws2Processes.some((p) => p.status === "running")).toBe(true);
    });
  });

  describe("process state tracking", () => {
    it("should track process exit", async () => {
      const result = await manager.spawn("workspace-1", "exit 42", {
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
      const result = await manager.spawn("workspace-1", "echo test; exit 0", {
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
      const result = await manager.spawn("workspace-1", "sleep 60", {
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
  });
});
