import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { BackgroundProcessManager, type BackgroundProcessMeta } from "./backgroundProcessManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { Runtime } from "@/node/runtime/Runtime";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createBashTool } from "@/node/services/tools/bash";
import { createBashOutputTool } from "@/node/services/tools/bash_output";
import { TestTempDir, createTestToolConfig } from "@/node/services/tools/testHelpers";
import type { BashToolResult, BashOutputToolResult } from "@/common/types/tools";

describe("BackgroundProcessManager", () => {
  let manager: BackgroundProcessManager;
  let runtime: Runtime;
  let bgOutputDir: string;
  // Use unique workspace IDs per test run to avoid collisions
  const testRunId = Date.now().toString(36);
  const testWorkspaceId = `test-ws1-${testRunId}`;
  const testWorkspaceId2 = `test-ws2-${testRunId}`;

  beforeEach(async () => {
    // Create isolated temp directory for each test to avoid cross-test pollution
    bgOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), "bg-proc-test-"));
    manager = new BackgroundProcessManager(bgOutputDir);
    runtime = new LocalRuntime(process.cwd());
  });

  afterEach(async () => {
    // Cleanup: terminate all processes
    await manager.cleanup(testWorkspaceId);
    await manager.cleanup(testWorkspaceId2);
    // Remove temp sessions directory (legacy)
    await fs.rm(bgOutputDir, { recursive: true, force: true }).catch(() => undefined);
    // Remove actual output directories from /tmp/mux-bashes (where executor writes)
    await fs
      .rm(`/tmp/mux-bashes/${testWorkspaceId}`, { recursive: true, force: true })
      .catch(() => undefined);
    await fs
      .rm(`/tmp/mux-bashes/${testWorkspaceId2}`, { recursive: true, force: true })
      .catch(() => undefined);
  });

  describe("spawn", () => {
    it("should spawn a background process and return process ID and outputDir", async () => {
      const displayName = `test-${Date.now()}`;
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello", {
        cwd: process.cwd(),
        displayName,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Process ID is now the display name directly
        expect(result.processId).toBe(displayName);
        // outputDir is now under runtime.tempDir()/mux-bashes/<workspaceId>/<processId>
        expect(result.outputDir).toContain("mux-bashes");
        expect(result.outputDir).toContain(testWorkspaceId);
        expect(result.outputDir).toContain(result.processId);
      }
    });

    it("should return error on spawn failure", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test", {
        cwd: "/nonexistent/path/that/does/not/exist",
        displayName: "test",
      });

      expect(result.success).toBe(false);
    });

    it("should write stdout and stderr to unified output file", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello; echo world >&2", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Wait a moment for output to be written
        await new Promise((resolve) => setTimeout(resolve, 100));

        const outputPath = path.join(result.outputDir, "output.log");
        const output = await fs.readFile(outputPath, "utf-8");

        // Both stdout and stderr go to the same file
        expect(output).toContain("hello");
        expect(output).toContain("world");
      }
    });

    it("should write meta.json with process info", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo test", {
        cwd: process.cwd(),
        displayName: "test",
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
        displayName: "test",
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
      // Use unique display names since they're now used as process IDs
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-list-1",
      });
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-list-2",
      });

      const processes = await manager.list();
      expect(processes.length).toBeGreaterThanOrEqual(2);
    });

    it("should filter by workspace ID", async () => {
      // Use unique display names since they're now used as process IDs
      await manager.spawn(runtime, testWorkspaceId, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-filter-ws1",
      });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 1", {
        cwd: process.cwd(),
        displayName: "test-filter-ws2",
      });

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
        displayName: "test",
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
        displayName: "test",
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
        displayName: "test",
      });
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test",
      });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test",
      });

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
      // Spawn processes in multiple workspaces (unique display names since they're process IDs)
      await manager.spawn(runtime, testWorkspaceId, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test-termall-ws1",
      });
      await manager.spawn(runtime, testWorkspaceId2, "sleep 10", {
        cwd: process.cwd(),
        displayName: "test-termall-ws2",
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
        displayName: "test",
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
        displayName: "test",
      });

      if (result.success) {
        await new Promise((resolve) => setTimeout(resolve, 200));

        const proc = await manager.getProcess(result.processId);
        expect(proc?.status).toBe("exited");

        // Verify output file still contains output
        const outputPath = path.join(result.outputDir, "output.log");
        const output = await fs.readFile(outputPath, "utf-8");
        expect(output).toContain("test");
      }
    });

    it("should preserve killed status after terminate", async () => {
      // Spawn a long-running process
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 60", {
        cwd: process.cwd(),
        displayName: "test",
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
        displayName: "test",
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
        displayName: "test",
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

  describe("getOutput", () => {
    it("should return stdout from a running process", async () => {
      // Spawn a process that writes output over time
      // Use longer sleep and explicit flush to ensure output is written to file
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'line 1'; sleep 0.3; echo 'line 2'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for first line to be written and flushed (increased for CI reliability)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Get output - should have at least the first line
      const output1 = await manager.getOutput(result.processId);
      expect(output1.success).toBe(true);
      if (!output1.success) return;

      expect(output1.output).toContain("line 1");

      // Wait for second line (sleep 0.3s + buffer for CI)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get output again - should have incremental output (line 2)
      const output2 = await manager.getOutput(result.processId);
      expect(output2.success).toBe(true);
      if (!output2.success) return;

      // Second call should only return new content (line 2)
      expect(output2.output).toContain("line 2");
      // And should NOT contain line 1 again (incremental reads)
      expect(output2.output).not.toContain("line 1");
    });

    it("should return stderr from a running process", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'error message' >&2", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      await new Promise((resolve) => setTimeout(resolve, 100));

      const output = await manager.getOutput(result.processId);
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("error message");
    });

    it("should include elapsed_ms in response", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "sleep 0.2; echo done", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait with timeout to ensure blocking
      const output = await manager.getOutput(result.processId, undefined, undefined, 1);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // elapsed_ms should be present and reflect the wait time
      expect(typeof output.elapsed_ms).toBe("number");
      expect(output.elapsed_ms).toBeGreaterThanOrEqual(0);
    });

    it("should return error for non-existent process", async () => {
      const output = await manager.getOutput("bash_nonexistent");
      expect(output.success).toBe(false);
      if (output.success) return;
      expect(output.error).toContain("not found");
    });

    it("should return correct status for running vs exited process", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo done; exit 0", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Immediately should be running
      const output1 = await manager.getOutput(result.processId);
      expect(output1.success).toBe(true);
      if (!output1.success) return;
      // Status could be running or already exited depending on timing

      // Wait for exit
      await new Promise((resolve) => setTimeout(resolve, 200));

      const output2 = await manager.getOutput(result.processId);
      expect(output2.success).toBe(true);
      if (!output2.success) return;
      expect(output2.status).toBe("exited");
      expect(output2.exitCode).toBe(0);
    });

    it("should filter output with regex when provided", async () => {
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'INFO: message'; echo 'DEBUG: noise'; echo 'INFO: another'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Filter for INFO lines only
      const output = await manager.getOutput(result.processId, "INFO");
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("INFO: message");
      expect(output.output).toContain("INFO: another");
      expect(output.output).not.toContain("DEBUG");
    });

    it("should exclude matching lines when filter_exclude is true", async () => {
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'INFO: message'; echo 'DEBUG: noise'; echo 'INFO: another'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Exclude DEBUG lines (invert filter)
      const output = await manager.getOutput(result.processId, "DEBUG", true);
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("INFO: message");
      expect(output.output).toContain("INFO: another");
      expect(output.output).not.toContain("DEBUG");
    });

    it("should return error when filter_exclude is true but no filter provided", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo hello", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // filter_exclude without filter should error
      const output = await manager.getOutput(result.processId, undefined, true);
      expect(output.success).toBe(false);
      if (output.success) return;
      expect(output.error).toContain("filter_exclude requires filter");
    });

    it("should keep waiting when only excluded lines arrive", async () => {
      const signalPath = path.join(bgOutputDir, `signal-${Date.now()}`);

      // Spawn a process that spams excluded output until we create a signal file.
      // This avoids flakiness from the spawn itself taking long enough that "DONE"
      // is already present by the time we call getOutput.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        `while [ ! -f "${signalPath}" ]; do echo 'PROGRESS'; sleep 0.1; done; echo 'DONE'`,
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 5 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      const outputPromise = manager.getOutput(result.processId, "PROGRESS", true, 2);

      // Ensure getOutput is waiting before we allow the process to produce
      // meaningful output.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(signalPath, "go");

      const output = await outputPromise;
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Should only see DONE, not PROGRESS lines
      expect(output.output).toContain("DONE");
      expect(output.output).not.toContain("PROGRESS");
      expect(output.elapsed_ms).toBeGreaterThanOrEqual(250);
    });

    it("should return when process exits even if only excluded lines", async () => {
      // Script outputs ONLY excluded lines then exits
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'PROGRESS'; echo 'PROGRESS'; exit 0",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should return (not hang) even though all output is excluded
      const output = await manager.getOutput(result.processId, "PROGRESS", true, 2);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Output should be empty (all lines excluded), but we should have status
      expect(output.output.trim()).toBe("");
      expect(output.status).toBe("exited");
    });

    it("should timeout and return even if only excluded lines arrived", async () => {
      // Script outputs progress indefinitely
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "while true; do echo 'PROGRESS'; sleep 0.1; done",
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 10 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Short timeout - should return with empty output, not hang
      const output = await manager.getOutput(result.processId, "PROGRESS", true, 0.3);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Should have returned due to timeout, output empty (all excluded)
      expect(output.output.trim()).toBe("");
      expect(output.status).toBe("running");
      expect(output.elapsed_ms).toBeGreaterThanOrEqual(250);
      expect(output.elapsed_ms).toBeLessThan(1000); // Didn't hang
    });

    it("should serialize concurrent getOutput calls to prevent duplicate output", async () => {
      // This test verifies the fix for the race condition where parallel bash_output
      // calls could both read from the same offset before either updates the position.
      // Without serialization, both calls would return the same output.
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'line1'; echo 'line2'; echo 'line3'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for all output to be written
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Call getOutput twice in parallel - without serialization, both would
      // read from offset 0 and return duplicate "line1\nline2\nline3"
      const [output1, output2] = await Promise.all([
        manager.getOutput(result.processId),
        manager.getOutput(result.processId),
      ]);

      expect(output1.success).toBe(true);
      expect(output2.success).toBe(true);
      if (!output1.success || !output2.success) return;

      // Combine outputs - should contain all lines exactly once
      const combinedOutput = output1.output + output2.output;
      const line1Count = (combinedOutput.match(/line1/g) ?? []).length;
      const line2Count = (combinedOutput.match(/line2/g) ?? []).length;
      const line3Count = (combinedOutput.match(/line3/g) ?? []).length;

      // Each line should appear exactly once across both outputs (no duplicates)
      expect(line1Count).toBe(1);
      expect(line2Count).toBe(1);
      expect(line3Count).toBe(1);

      // One call should get the content, the other should get empty (already read)
      const hasContent = output1.output.trim().length > 0 || output2.output.trim().length > 0;
      expect(hasContent).toBe(true);
    });
  });

  describe("integration: spawn and getOutput", () => {
    it("should retrieve output after spawn using same manager instance", async () => {
      // This test verifies the core workflow: spawn -> getOutput
      // Both must use the SAME manager instance

      // Spawn process that produces output
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'hello from bg'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for output using the SAME manager (avoid sleep-based flakiness)
      const output = await manager.getOutput(result.processId, undefined, undefined, 2);
      expect(output.success).toBe(true);
      if (!output.success) return;

      expect(output.output).toContain("hello from bg");
    });

    it("should read from offset 0 on first call even if file already has content", async () => {
      // Spawn a process that writes output immediately
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'initial output'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait longer to ensure output is definitely written
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify the file has content
      const outputPath = path.join(result.outputDir, "output.log");
      const fileContent = await fs.readFile(outputPath, "utf-8");
      expect(fileContent).toContain("initial output");

      // Now call getOutput - first call should read from offset 0
      const output = await manager.getOutput(result.processId);
      expect(output.success).toBe(true);
      if (!output.success) return;

      // Should have the output even though some time has passed
      expect(output.output).toContain("initial output");
    });

    it("DEBUG: verifies outputDir from spawn matches getProcess", async () => {
      // Verify that outputDir returned from spawn is the same as what getProcess returns
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'verify test'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      const proc = await manager.getProcess(result.processId);
      expect(proc).not.toBeNull();

      // CRITICAL: outputDir from spawn MUST match outputDir from getProcess
      expect(proc!.outputDir).toBe(result.outputDir);

      // Wait for output to be written
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify file exists at the expected path
      const outputPath = path.join(result.outputDir, "output.log");
      const content = await fs.readFile(outputPath, "utf-8");
      expect(content).toContain("verify test");

      // Now getOutput should return the content
      const output = await manager.getOutput(result.processId);
      expect(output.success).toBe(true);
      if (output.success) {
        expect(output.output).toContain("verify test");
      }
    });

    it("should work when spawned via bash tool and read via bash_output tool", async () => {
      // This simulates the exact flow in the real system:
      // 1. bash tool with run_in_background=true spawns process
      // 2. bash_output tool reads output

      const tempDir = new TestTempDir("test-bg-integration");

      // Create shared config with the SAME manager instance
      const config = createTestToolConfig(tempDir.path, {
        workspaceId: testWorkspaceId,
        sessionsDir: tempDir.path,
      });
      config.backgroundProcessManager = manager;
      config.runtime = runtime;

      // Create bash tool and spawn background process
      const bashTool = createBashTool(config);
      const spawnResult = (await bashTool.execute!(
        { script: "echo 'hello from integration test'", run_in_background: true },
        { toolCallId: "test", messages: [] }
      )) as BashToolResult;

      expect(spawnResult).toBeDefined();
      expect(spawnResult.success).toBe(true);
      expect("backgroundProcessId" in spawnResult).toBe(true);

      // Type narrowing for background process result
      if (!("backgroundProcessId" in spawnResult)) {
        throw new Error("Expected background process result");
      }
      const processId: string = spawnResult.backgroundProcessId;

      // Wait for output
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Create bash_output tool and read output
      const outputTool = createBashOutputTool(config);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const rawOutputResult = await outputTool.execute!(
        { process_id: processId },
        { toolCallId: "test2", messages: [] }
      );

      const outputResult = rawOutputResult as BashOutputToolResult;

      expect(outputResult).toBeDefined();

      // This is the key assertion - should succeed AND have content
      expect(outputResult.success).toBe(true);
      if (outputResult.success) {
        expect(outputResult.output).toContain("hello from integration test");
      } else {
        throw new Error(`bash_output failed: ${outputResult.error}`);
      }

      tempDir[Symbol.dispose]();
    });

    it("should fail to get output if using different manager instance", async () => {
      // This test documents what happens if manager instances differ
      // (which would be a bug in the real system)

      // Spawn with first manager
      const result = await manager.spawn(runtime, testWorkspaceId, "echo 'test'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Create a DIFFERENT manager instance
      const otherManager = new BackgroundProcessManager(bgOutputDir);

      // Trying to get output from different manager should fail
      // because the process isn't in its internal map
      const output = await otherManager.getOutput(result.processId);
      expect(output.success).toBe(false);
      if (!output.success) {
        expect(output.error).toContain("Process not found");
      }
    });
  });

  describe("exit_code file", () => {
    it("should write exit_code file when process exits", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "exit 42", {
        cwd: process.cwd(),
        displayName: "test",
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

  describe("line-buffered filtering", () => {
    it("should only filter complete lines, not fragments", async () => {
      // Process that outputs lines that should be filtered and one that shouldn't
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        // Output lines: some with 'progress', one without
        "echo 'progress 1'; echo 'progress 2'; echo 'FINAL RESULT'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to complete
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Filter out lines containing 'progress', should only get 'FINAL RESULT'
      const output = await manager.getOutput(result.processId, "progress", true, 0.5);
      expect(output.success).toBe(true);
      if (!output.success) return;
      expect(output.output).toContain("FINAL RESULT");
      expect(output.output).not.toContain("progress");
    });

    it("should buffer incomplete lines across calls", async () => {
      // Process that outputs progress lines
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "echo 'progress: 50%'; sleep 0.1; echo 'progress: 100%'; echo 'DONE'",
        { cwd: process.cwd(), displayName: "test" }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to complete
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Filter out progress lines, should only get 'DONE'
      const output = await manager.getOutput(result.processId, "progress", true, 0.5);
      expect(output.success).toBe(true);
      if (!output.success) return;
      expect(output.output).toContain("DONE");
      expect(output.output).not.toContain("progress");
    });

    it("should include incomplete line on process exit", async () => {
      // Process that exits without final newline
      const result = await manager.spawn(runtime, testWorkspaceId, "printf 'no newline at end'", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 300));

      const output = await manager.getOutput(result.processId, undefined, undefined, 0.5);
      expect(output.success).toBe(true);
      if (!output.success) return;
      expect(output.output).toContain("no newline at end");
      expect(output.status).not.toBe("running");
    });
  });

  describe("polling detection", () => {
    it("should return note after 3+ calls without filter_exclude on running process", async () => {
      // Long-running process
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "while true; do echo 'tick'; sleep 0.5; done",
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 30 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // First two calls should not have a note
      const output1 = await manager.getOutput(result.processId, undefined, undefined, 0.1);
      expect(output1.success).toBe(true);
      if (!output1.success) return;
      expect(output1.note).toBeUndefined();

      const output2 = await manager.getOutput(result.processId, undefined, undefined, 0.1);
      expect(output2.success).toBe(true);
      if (!output2.success) return;
      expect(output2.note).toBeUndefined();

      // Third call should have the suggestion note
      const output3 = await manager.getOutput(result.processId, undefined, undefined, 0.1);
      expect(output3.success).toBe(true);
      if (!output3.success) return;
      expect(output3.note).toContain("filter_exclude");
      expect(output3.note).toContain("3+ times");
    });

    it("should return better pattern note when filter_exclude is used but still polling", async () => {
      const result = await manager.spawn(
        runtime,
        testWorkspaceId,
        "while true; do echo 'tick'; sleep 0.5; done",
        { cwd: process.cwd(), displayName: "test", timeoutSecs: 30 }
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Make 3+ calls with filter_exclude - should get "better pattern" note
      let lastNote: string | undefined;
      for (let i = 0; i < 4; i++) {
        const output = await manager.getOutput(result.processId, "nomatch", true, 0.1);
        expect(output.success).toBe(true);
        if (!output.success) return;
        lastNote = output.note;
      }
      // Should get the "better pattern" note since we're using filter_exclude but still polling
      expect(lastNote).toContain("filter_exclude but still polling");
      expect(lastNote).toContain("broader pattern");
    });

    it("should NOT return note when process has exited", async () => {
      const result = await manager.spawn(runtime, testWorkspaceId, "echo done; exit 0", {
        cwd: process.cwd(),
        displayName: "test",
      });

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Wait for process to exit
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Make 3+ calls on exited process
      for (let i = 0; i < 4; i++) {
        const output = await manager.getOutput(result.processId, undefined, undefined, 0.1);
        expect(output.success).toBe(true);
        if (!output.success) return;
        // Should not get note since process is not running
        expect(output.note).toBeUndefined();
      }
    });
  });
});
