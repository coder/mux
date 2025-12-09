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

describe("Background Bash Direct Integration", () => {
  let env: TestEnvironment;
  let tempGitRepo: string;
  let workspaceId: string;
  let workspacePath: string;

  beforeAll(async () => {
    env = await createTestEnvironment();
    tempGitRepo = await createTempGitRepo();

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

  it("should retrieve output after tools are recreated (multi-message flow)", async () => {
    // Simulates production flow where tools are recreated between messages
    const manager = getBackgroundProcessManager(env);
    const initStateManager = getInitStateManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker = `MULTI_MSG_${Date.now()}`;

    // Message 1: Spawn background process
    const tools1 = await getToolsForModel(
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
      {}
    );

    const spawnResult = (await tools1.bash.execute!(
      { script: `echo "${marker}"`, run_in_background: true },
      { toolCallId: "spawn", messages: [] }
    )) as ToolExecuteResult;

    expect(spawnResult.success).toBe(true);
    const processId = spawnResult.backgroundProcessId!;

    await new Promise((resolve) => setTimeout(resolve, 200));

    // Message 2: Read with NEW tool instances (same manager)
    const tools2 = await getToolsForModel(
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
      {}
    );

    const outputResult = (await tools2.bash_output.execute!(
      { process_id: processId },
      { toolCallId: "read", messages: [] }
    )) as ToolExecuteResult;

    expect(outputResult.success).toBe(true);
    expect(outputResult.stdout).toContain(marker);
  });

  it("should read output files via handle (works for SSH runtime)", async () => {
    // Verifies that getOutput uses handle.readOutput() which works for both
    // local and SSH runtimes, not direct local fs access
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker = `HANDLE_READ_${Date.now()}`;

    const spawnResult = await manager.spawn(runtime, workspaceId, `echo "${marker}"`, {
      cwd: workspacePath,
    });
    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    await new Promise((resolve) => setTimeout(resolve, 200));

    const output = await manager.getOutput(spawnResult.processId);
    expect(output.success).toBe(true);
    if (output.success) {
      expect(output.stdout).toContain(marker);
    }
  });

  it("should support incremental reads", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);
    const marker1 = `INCR_1_${Date.now()}`;
    const marker2 = `INCR_2_${Date.now()}`;

    const spawnResult = await manager.spawn(
      runtime,
      workspaceId,
      `echo "${marker1}"; sleep 1; echo "${marker2}"`,
      { cwd: workspacePath }
    );
    expect(spawnResult.success).toBe(true);
    if (!spawnResult.success) return;

    await new Promise((resolve) => setTimeout(resolve, 300));

    // First read gets marker1
    const output1 = await manager.getOutput(spawnResult.processId);
    expect(output1.success).toBe(true);
    if (output1.success) {
      expect(output1.stdout).toContain(marker1);
    }

    // Second read immediately - no new content
    const output2 = await manager.getOutput(spawnResult.processId);
    expect(output2.success).toBe(true);
    if (output2.success) {
      expect(output2.stdout).toBe("");
    }

    // Wait for marker2
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Third read gets marker2 only
    const output3 = await manager.getOutput(spawnResult.processId);
    expect(output3.success).toBe(true);
    if (output3.success) {
      expect(output3.stdout).toContain(marker2);
      expect(output3.stdout).not.toContain(marker1);
    }
  });

  it("should isolate processes by workspace", async () => {
    const manager = getBackgroundProcessManager(env);
    const runtime = new LocalRuntime(workspacePath);

    // Create second workspace
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
      // Spawn in each workspace
      const spawn1 = await manager.spawn(runtime, workspaceId, "echo ws1", {
        cwd: workspacePath,
      });
      const spawn2 = await manager.spawn(runtime, workspaceId2, "echo ws2", {
        cwd: workspacePath,
      });

      expect(spawn1.success).toBe(true);
      expect(spawn2.success).toBe(true);
      if (!spawn1.success || !spawn2.success) return;

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Cleanup workspace 2
      await manager.cleanup(workspaceId2);

      // Process 1 still accessible
      const output1 = await manager.getOutput(spawn1.processId);
      expect(output1.success).toBe(true);

      // Process 2 cleaned up
      const output2 = await manager.getOutput(spawn2.processId);
      expect(output2.success).toBe(false);
    } finally {
      await env.orpc.workspace.remove({ workspaceId: workspaceId2 }).catch(() => {});
    }
  });
});
