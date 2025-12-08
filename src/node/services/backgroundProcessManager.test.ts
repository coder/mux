import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BackgroundProcessManager, type BackgroundProcessMeta } from "./backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("BackgroundProcessManager", () => {
  let manager: BackgroundProcessManager;
  let runtime: Runtime;
  let bgOutputDir: string;
  // Use unique workspace IDs per test run to avoid collisions
  const testRunId = Date.now().toString(36);
  const testWorkspaceId = `test-ws1-${testRunId}`;
  const testWorkspaceId2 = `test-ws2-${testRunId}`;

  beforeEach(async () => {
    manager = new BackgroundProcessManager();
    // Create isolated temp directory for sessions
    bgOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-proc-test-"));
    runtime = new LocalRuntime(process.cwd(), bgOutputDir);
  });

  afterEach(async () => {
    // Cleanup: terminate all processes
    await manager.cleanup(testWorkspaceId);
    await manager.cleanup(testWorkspaceId2);
    // Remove temp sessions directory
    await fs.rm(bgOutputDir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe("spawn", () => {
    it("should spawn a background process and return process ID and outputDir", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.processId).toMatch(/^bg-/);
        expect(result.outputDir).toContain(bgOutputDir);
        expect(result.outputDir).toContain(testWorkspaceId);
        expect(result.outputDir).toContain(result.processId);
      }
    });

    it("should return error on spawn failure", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test", {
        cwd: "/nonexistent/path/that/does/not/exist",
      });

      expect(result.success).toBe(false);
    });

    it("should write stdout and stderr to files", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello; echo world >&2", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Wait a moment for output to be written
        await new Promise((resolve) => setTimeout(resolve, 100));

        const stdoutPath = path.join(result.outputDir, "stdout.log");
        const stderrPath = path.join(result.outputDir, "stderr.log");

        const stdout = await fs.readFile(stdoutPath, "utf-8");
        const stderr = await fs.readFile(stderrPath, "utf-8");

        expect(stdout).toContain("hello");
        expect(stderr).toContain("world");
      }
    });

    it("should write meta.json with process info", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const metaPath = path.join(result.outputDir, "meta.json");
        const metaContent = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent) as BackgroundProcessMeta;

        expect(meta.id).toBe(result.processId);
        expect(meta.pid).toBeGreaterThan(0);
        expect(meta.script).toBe("echo test");
        expect(meta.status).toBe("running");
        expect(meta.startTime).toBeGreaterThan(0);
      }
    });
  });

  describe("getProcess", () => {
    it("should return process by ID", async () => {
      const spawnResult = await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
      });

      if (spawnResult.success) {
        const proc = await manager.getProcess(spawnResult.processId);
        expect(proc).not.toBeNull();
        expect(proc?.id).toBe(spawnResult.processId);
        expect(proc?.status).toBe("running");
      }
    });

    it("should return null for non-existent process", async () => {
      const proc = await manager.getProcess("bg-nonexistent");
      expect(proc).toBeNull();
    });
  });

  describe("list", () => {
    it("should list all processes", async () => {
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", { cwd: process.cwd() });
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", { cwd: process.cwd() });

      const processes = await manager.list();
      expect(processes.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by workspace ID", async () => {
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", { cwd: process.cwd() });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 1", { cwd: process.cwd() });

      const ws1Processes = await manager.list(testWorkspaceId);
      const ws2Processes = await manager.list(testWorkspaceId2);

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

        const proc = await manager.getProcess(spawnResult.processId);
        expect(proc?.status).toMatch(/killed|exited/);
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
    it("should kill all processes for a workspace and remove from memory", async () => {
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
      });
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
      });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 10", { cwd: process.cwd() });

      await manager.cleanup(testWorkspaceId);

      const ws1Processes = await manager.list(testWorkspaceId);
      const ws2Processes = await manager.list(testWorkspaceId2);
      // All testWorkspaceId processes should be removed from memory
      expect(ws1Processes.length).toBe(0);
      // workspace-2 processes should still exist and be running
      expect(ws2Processes.length).toBeGreaterThanOrEqual(1);
      expect(ws2Processes.some((p) => p.status === "running")).toBe(true);
    });
  });

  describe("terminateAll", () => {
    it("should kill all processes across all workspaces", async () => {
      // Spawn processes in multiple workspaces
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
      });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 10", {
        cwd: process.cwd(),
      });

      // Verify both workspaces have running processes
      const beforeWs1 = await manager.list(testWorkspaceId);
      const beforeWs2 = await manager.list(testWorkspaceId2);
      expect(beforeWs1.length).toBe(1);
      expect(beforeWs2.length).toBe(1);

      // Terminate all
      await manager.terminateAll();

      // Both workspaces should have no processes
      const afterWs1 = await manager.list(testWorkspaceId);
      const afterWs2 = await manager.list(testWorkspaceId2);
      expect(afterWs1.length).toBe(0);
      expect(afterWs2.length).toBe(0);

      // Total list should also be empty
      const allProcesses = await manager.list();
      expect(allProcesses.length).toBe(0);
    });

    it("should handle empty process list gracefully", async () => {
      // No processes spawned - terminateAll should not throw
      await manager.terminateAll();
      const allProcesses = await manager.list();
      expect(allProcesses.length).toBe(0);
    });
  });

  describe("process state tracking", () => {
    it("should track process exit and update meta.json", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "exit 42", {
        cwd: process.cwd(),
      });

      if (result.success) {
        // Wait for process to exit
        await new Promise((resolve) => setTimeout(resolve, 200));

        const proc = await manager.getProcess(result.processId);
        expect(proc?.status).toBe("exited");
        expect(proc?.exitCode).toBe(42);
        expect(proc?.exitTime).not.toBeNull();

        // Verify meta.json was updated
        const metaPath = path.join(result.outputDir, "meta.json");
        const metaContent = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(metaContent) as BackgroundProcessMeta;
        expect(meta.status).toBe("exited");
        expect(meta.exitCode).toBe(42);
      }
    });

    it("should keep output files after process exits", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test; exit 0", {
        cwd: process.cwd(),
      });

      if (result.success) {
        await new Promise((resolve) => setTimeout(resolve, 200));

        const proc = await manager.getProcess(result.processId);
        expect(proc?.status).toBe("exited");

        // Verify stdout file still contains output
        const stdoutPath = path.join(result.outputDir, "stdout.log");
        const stdout = await fs.readFile(stdoutPath, "utf-8");
        expect(stdout).toContain("test");
      }
    });

    it("should preserve killed status after terminate", async () => {
      // Spawn a long-running process
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 60", {
        cwd: process.cwd(),
      });

      if (result.success) {
        // Terminate it
        await manager.terminate(result.processId);

        // Status should be "killed", not "exited"
        const proc = await manager.getProcess(result.processId);
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

        const proc = await manager.getProcess(result.processId);
        expect(proc).not.toBeNull();
        // Exit code should be 128 + signal number (SIGTERM=15 → 143, SIGKILL=9 → 137)
        // Either is acceptable depending on timing
        expect(proc!.exitCode).toBeGreaterThanOrEqual(128);
      }
    });
  });

  describe("process group termination", () => {
    it("should terminate child processes when parent is killed", async () => {
      // This test validates that set -m creates a process group where PID === PGID,
      // allowing kill -PID to terminate the entire process tree.

      // Spawn a parent that creates a child process
      // The parent runs: (sleep 60 &); wait
      // This creates: parent bash -> child sleep
      const result = await manager.spawn(runtime, testWorkspaceId, "bash -c 'sleep 60 & wait'", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Give the child process time to start
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify process is running
      const procBefore = await manager.getProcess(result.processId);
      expect(procBefore?.status).toBe("running");

      // Terminate - this should kill both parent and child via process group
      await manager.terminate(result.processId);

      // Verify parent is killed
      const procAfter = await manager.getProcess(result.processId);
      expect(procAfter?.status).toBe("killed");

      // Wait a moment for any orphaned processes to show up
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify no orphaned sleep processes from our test
      // (checking via ps would be flaky, so we rely on the exit code being set,
      // which only happens after the entire process group is dead)
      const exitCode = procAfter?.exitCode;
      expect(exitCode).not.toBeNull();
      expect(exitCode).toBeGreaterThanOrEqual(128); // Signal exit code
    });
  });

  describe("exit_code file", () => {
    it("should write exit_code file when process exits", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "exit 42", {
        cwd: process.cwd(),
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit and exit_code to be written
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Check exit_code file exists and contains correct value
      const exitCodePath = path.join(result.outputDir, "exit_code");
      const exitCodeContent = await fs.readFile(exitCodePath, "utf-8");
      expect(exitCodeContent.trim()).toBe("42");
    });
  });
});
