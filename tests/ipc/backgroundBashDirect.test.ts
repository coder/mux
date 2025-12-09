/**
 * Direct integration tests for background bash process manager.
 *
 * These tests bypass the LLM and call tools directly to verify the service
 * wiring is correct. This catches bugs that unit tests miss because unit
 * tests create fresh manager instances, while production shares a single
 * instance through ServiceContainer.
 *
 * Key difference from unit tests:
 * - Unit tests: Create fresh BackgroundProcessManager per test
 * - These tests: Use ServiceContainer's shared BackgroundProcessManager
 *
 * Key difference from backgroundBash.test.ts:
 * - backgroundBash.test.ts: Goes through LLM (slow, flaky, indirect)
 * - These tests: Direct tool execution (fast, deterministic, precise)
 */

import * as fs from "fs/promises";
import * as path from "path";
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  type TestEnvironment,
} from "./setup";
import { createTempGitRepo, cleanupTempGitRepo, generateBranchName } from "./helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import { getToolsForModel } from "../../src/common/utils/tools/tools";
import { LocalRuntime } from "../../src/node/runtime/LocalRuntime";
import { BackgroundProcessManager } from "../../src/node/services/backgroundProcessManager";
import type { InitStateManager } from "../../src/node/services/initStateManager";

// Access private fields from ServiceContainer for direct testing
// This is intentional for testing - we need to verify the shared instance behavior
interface ServiceContainerPrivates {
  backgroundProcessManager: BackgroundProcessManager;
  initStateManager: InitStateManager;
}

function getBackgroundProcessManager(env: TestEnvironment): BackgroundProcessManager {
  return (env.services as unknown as ServiceContainerPrivates).backgroundProcessManager;
}

function getInitStateManager(env: TestEnvironment): InitStateManager {
  return (env.services as unknown as ServiceContainerPrivates).initStateManager;
}

interface ToolExecuteResult {
  success: boolean;
  backgroundProcessId?: string;
  stdout?: string;
  stderr?: string;
  status?: string;
  error?: string;
  exitCode?: number;
  output?: string;
}

/**
 * Test that simulates what happens when processes exist on disk but not in memory.
 * This can happen after app restart, or if processes were spawned by a different
 * manager instance.
 */
describe("Background Bash Disk State", () => {
  it("should fail gracefully when process exists on disk but not in memory", async () => {
    const env = await createTestEnvironment();
    const tempGitRepo = await createTempGitRepo();

    try {
      // Create workspace
      const branchName = generateBranchName("disk-state-test");
      const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
      const result = await env.orpc.workspace.create({
        projectPath: tempGitRepo,
        branchName,
        trunkBranch,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;

      const wsId = result.metadata.id;
      const manager = getBackgroundProcessManager(env);
      const runtime = new LocalRuntime(tempGitRepo);

      // Spawn a process normally
      const spawnResult = await manager.spawn(runtime, wsId, "echo 'disk test'", {
        cwd: tempGitRepo,
      });
      expect(spawnResult.success).toBe(true);
      if (!spawnResult.success) return;

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify output works normally
      const output1 = await manager.getOutput(spawnResult.processId);
      expect(output1.success).toBe(true);
      if (output1.success) {
        expect(output1.stdout).toContain("disk test");
      }

      // Now simulate app restart by creating a NEW manager instance
      // This is what happens when desktop app restarts
      const newManager = new (manager.constructor as typeof BackgroundProcessManager)(
        manager.getBgOutputDir()
      );

      // The process files still exist on disk
      const stdoutPath = path.join(spawnResult.outputDir, "stdout.log");
      const fileContent = await fs.readFile(stdoutPath, "utf-8");
      expect(fileContent).toContain("disk test");

      // But the new manager doesn't know about it
      const proc = await newManager.getProcess(spawnResult.processId);
      expect(proc).toBeNull(); // Process not in memory

      // getOutput should fail
      const output2 = await newManager.getOutput(spawnResult.processId);
      expect(output2.success).toBe(false);
      if (!output2.success) {
        expect(output2.error).toContain("not found");
      }

      await env.orpc.workspace.remove({ workspaceId: wsId });
    } finally {
      await cleanupTempGitRepo(tempGitRepo);
      await cleanupTestEnvironment(env);
    }
  });
});

describe("Background Bash Direct Integration", () => {
  let env: TestEnvironment;
  let tempGitRepo: string;
  let workspaceId: string;
  let workspacePath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    tempGitRepo = await createTempGitRepo();

    // Create a workspace to get a valid workspaceId
    const branchName = generateBranchName("bg-direct-test");
    const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
    const result = await env.orpc.workspace.create({
      projectPath: tempGitRepo,
      branchName,
      trunkBranch,
    });

    if (!result.success) {
      throw new Error(`Failed to create workspace: ${result.error}`);
    }
    workspaceId = result.metadata.id;
    workspacePath = result.metadata.namedWorkspacePath ?? tempGitRepo;
  });

  afterAll(async () => {
    if (workspaceId) {
      await env.orpc.workspace.remove({ workspaceId }).catch(() => {});
    }
    await cleanupTempGitRepo(tempGitRepo);
    await cleanupTestEnvironment(env);
  });

  /**
   * This test mimics the production flow:
   * 1. AIService.streamMessage() calls getToolsForModel() to create tools
   * 2. LLM calls bash tool -> spawns background process
   * 3. AIService.streamMessage() is called again (new message)
   * 4. getToolsForModel() is called again to create NEW tool instances
   * 5. LLM calls bash_output tool -> should get output from process spawned in step 2
   *
   * The key insight: tools are recreated between messages, but they should
   * share the same backgroundProcessManager from ServiceContainer.
   */
  it("should retrieve output after tools are recreated (simulates multi-message flow)", async () => {
    const manager = getBackgroundProcessManager(env);
    const initStateManager = getInitStateManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker = `DIRECT_TEST_${Date.now()}`;

    // ===== Message 1: Spawn background process =====
    // This simulates the first sendMessage call
    const toolsMessage1 = await getToolsForModel(
      "anthropic:claude-sonnet-4-20250514",
      {
        cwd: workspacePath,
        runtime,
        secrets: {},
        muxEnv: {},
        runtimeTempDir: "/tmp",
        backgroundProcessManager: manager,
        workspaceId,
      },
      workspaceId,
      initStateManager,
      {} // toolInstructions
    );

    const bashTool = toolsMessage1.bash;
    expect(bashTool).toBeDefined();
    expect(bashTool.execute).toBeDefined();

    const spawnResult = (await bashTool.execute!(
      { script: `echo "${marker}"`, run_in_background: true },
      { toolCallId: "test-spawn", messages: [] }
    )) as ToolExecuteResult;

    expect(spawnResult.success).toBe(true);
    expect(spawnResult.backgroundProcessId).toBeDefined();
    const processId = spawnResult.backgroundProcessId!;

    // Wait for process to complete
    await new Promise((resolve) => setTimeout(resolve, 300));

    // ===== Message 2: Get output with NEW tool instances =====
    // This simulates a second sendMessage call - tools are recreated!
    const toolsMessage2 = await getToolsForModel(
      "anthropic:claude-sonnet-4-20250514",
      {
        cwd: workspacePath,
        runtime,
        secrets: {},
        muxEnv: {},
        runtimeTempDir: "/tmp",
        backgroundProcessManager: manager, // Same manager instance
        workspaceId,
      },
      workspaceId,
      initStateManager,
      {} // toolInstructions
    );

    const bashOutputTool = toolsMessage2.bash_output;
    expect(bashOutputTool).toBeDefined();
    expect(bashOutputTool.execute).toBeDefined();

    const outputResult = (await bashOutputTool.execute!(
      { process_id: processId },
      { toolCallId: "test-output", messages: [] }
    )) as ToolExecuteResult;

    // THE KEY ASSERTION: This is what fails in the real bug
    expect(outputResult.success).toBe(true);
    expect(outputResult.stdout).toContain(marker);
  });

  /**
   * Test that output files are actually written to disk and readable.
   * This catches issues where the file exists but getOutput() can't read it.
   */
  it("should have readable output files after process completes", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker = `FILE_TEST_${Date.now()}`;

    // Spawn via the manager directly
    const spawnResult = await manager.spawn(runtime, workspaceId, `echo "${marker}"`, {
      cwd: workspacePath,
    });

    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    // Wait for process to complete
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Verify file exists and has content
    const stdoutPath = path.join(spawnResult.outputDir, "stdout.log");
    const fileContent = await fs.readFile(stdoutPath, "utf-8");
    expect(fileContent).toContain(marker);

    // Now verify getOutput returns the same content
    const output = await manager.getOutput(spawnResult.processId);
    expect(output.success).toBe(true);
    if (output.success) {
      expect(output.stdout).toContain(marker);
    }
  });

  /**
   * Test incremental reads work correctly across tool recreations.
   * First read should get content, second read (with no new content) should be empty.
   */
  it("should support incremental reads with read position tracking", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker1 = `INCR_1_${Date.now()}`;
    const marker2 = `INCR_2_${Date.now()}`;

    // Spawn a process that outputs marker1
    const spawnResult = await manager.spawn(
      runtime,
      workspaceId,
      `echo "${marker1}"; sleep 1; echo "${marker2}"`,
      { cwd: workspacePath }
    );

    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    // Wait for first output
    await new Promise((resolve) => setTimeout(resolve, 300));

    // First read should get marker1
    const output1 = await manager.getOutput(spawnResult.processId);
    expect(output1.success).toBe(true);
    if (output1.success) {
      expect(output1.stdout).toContain(marker1);
    }

    // Read again immediately - should get empty (no new content yet)
    const output2 = await manager.getOutput(spawnResult.processId);
    expect(output2.success).toBe(true);
    if (output2.success) {
      // Should be empty because we already read marker1 and marker2 hasn't appeared yet
      expect(output2.stdout).toBe("");
    }

    // Wait for second output
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Third read should get marker2
    const output3 = await manager.getOutput(spawnResult.processId);
    expect(output3.success).toBe(true);
    if (output3.success) {
      expect(output3.stdout).toContain(marker2);
      // Should NOT contain marker1 (already read)
      expect(output3.stdout).not.toContain(marker1);
    }
  });

  /**
   * Test reading output IMMEDIATELY after spawn (no wait).
   * This catches race conditions where the file might not exist yet.
   */
  it("should handle reading immediately after spawn (race condition test)", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker = `RACE_TEST_${Date.now()}`;

    // Spawn background process
    const spawnResult = await manager.spawn(runtime, workspaceId, `echo "${marker}"`, {
      cwd: workspacePath,
    });

    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    // Read IMMEDIATELY - no wait at all
    const output1 = await manager.getOutput(spawnResult.processId);
    expect(output1.success).toBe(true);

    // The file might be empty if process hasn't written yet, but it should be readable
    // This tests that the infrastructure handles the race gracefully

    // Now wait and try again
    await new Promise((resolve) => setTimeout(resolve, 300));

    const output2 = await manager.getOutput(spawnResult.processId);
    expect(output2.success).toBe(true);
    if (output2.success) {
      // Combined output from both reads should contain marker
      // (either output1 got it, or output2 got it, or we need to sum them)
      const combinedOutput = ((output1 as { stdout?: string }).stdout ?? "") + (output2.stdout ?? "");
      expect(combinedOutput).toContain(marker);
    }
  });

  /**
   * Test that outputDir in the process object matches where files actually get written.
   * This catches bugs where spawn() returns one path but stores another in the Map.
   */
  it("should have consistent outputDir between spawn result and stored process", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    const spawnResult = await manager.spawn(runtime, workspaceId, "echo test", {
      cwd: workspacePath,
    });

    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    // Get the process from the manager's internal state
    const proc = await manager.getProcess(spawnResult.processId);
    expect(proc).toBeDefined();

    // THE KEY ASSERTION: outputDir should match
    expect(proc!.outputDir).toBe(spawnResult.outputDir);

    // Also verify files exist at both paths (should be the same)
    const spawnStdoutPath = path.join(spawnResult.outputDir, "stdout.log");
    const procStdoutPath = path.join(proc!.outputDir, "stdout.log");

    await new Promise((resolve) => setTimeout(resolve, 200));

    const spawnFile = await fs.readFile(spawnStdoutPath, "utf-8");
    const procFile = await fs.readFile(procStdoutPath, "utf-8");

    expect(spawnFile).toContain("test");
    expect(procFile).toContain("test");
    expect(spawnFile).toBe(procFile);
  });

  /**
   * Test that workspace cleanup doesn't break other workspaces' processes.
   * This catches potential state pollution between workspaces.
   */
  it("should isolate processes by workspace", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    // Create a second workspace
    const branchName2 = generateBranchName("bg-direct-test-2");
    const trunkBranch = await detectDefaultTrunkBranch(tempGitRepo);
    const result2 = await env.orpc.workspace.create({
      projectPath: tempGitRepo,
      branchName: branchName2,
      trunkBranch,
    });
    expect(result2.success).toBe(true);
    if (!result2.success) return;
    const workspaceId2 = result2.metadata.id;

    try {
      // Spawn in workspace 1
      const spawn1 = await manager.spawn(runtime, workspaceId, "echo ws1", {
        cwd: workspacePath,
      });
      expect(spawn1.success).toBe(true);

      // Spawn in workspace 2
      const spawn2 = await manager.spawn(runtime, workspaceId2, "echo ws2", {
        cwd: workspacePath,
      });
      expect(spawn2.success).toBe(true);

      if (!spawn1.success || !spawn2.success) return;

      // Wait for both to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Cleanup workspace 2
      await manager.cleanup(workspaceId2);

      // Process from workspace 1 should still be accessible
      const output1 = await manager.getOutput(spawn1.processId);
      expect(output1.success).toBe(true);
      if (output1.success) {
        expect(output1.stdout).toContain("ws1");
      }

      // Process from workspace 2 should NOT be accessible (cleaned up)
      const output2 = await manager.getOutput(spawn2.processId);
      expect(output2.success).toBe(false);
    } finally {
      await env.orpc.workspace.remove({ workspaceId: workspaceId2 }).catch(() => {});
    }
  });
});
