/**
 * IPC tests for workspace-scoped AI settings persistence.
 *
 * Verifies that model + thinking level can be persisted per workspace and
 * are returned via metadata APIs (list/getInfo).
 */

import { createTestEnvironment, cleanupTestEnvironment } from "./setup";
import type { TestEnvironment } from "./setup";
import {
  createTempGitRepo,
  cleanupTempGitRepo,
  generateBranchName,
  createWorkspace,
} from "./helpers";
import { resolveOrpcClient } from "./helpers";

describe("workspace.updateAISettings", () => {
  test("persists aiSettings and returns them via workspace.getInfo and workspace.list", async () => {
    const env: TestEnvironment = await createTestEnvironment();
    const tempGitRepo = await createTempGitRepo();

    try {
      const branchName = generateBranchName("ai-settings");
      const createResult = await createWorkspace(env, tempGitRepo, branchName);
      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;
      expect(workspaceId).toBeTruthy();

      const client = resolveOrpcClient(env);
      const updateResult = await client.workspace.updateAISettings({
        workspaceId: workspaceId!,
        aiSettings: { model: "openai:gpt-5.2", thinkingLevel: "xhigh" },
      });
      expect(updateResult.success).toBe(true);

      const info = await client.workspace.getInfo({ workspaceId: workspaceId! });
      expect(info?.aiSettings).toEqual({ model: "openai:gpt-5.2", thinkingLevel: "xhigh" });

      const list = await client.workspace.list({ includePostCompaction: false });
      const fromList = list.find((m) => m.id === workspaceId);
      expect(fromList?.aiSettings).toEqual({ model: "openai:gpt-5.2", thinkingLevel: "xhigh" });
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    }
  }, 60000);

  test("compaction requests do not override workspace aiSettings", async () => {
    const env: TestEnvironment = await createTestEnvironment();
    const tempGitRepo = await createTempGitRepo();

    try {
      const branchName = generateBranchName("ai-settings-compact");
      const createResult = await createWorkspace(env, tempGitRepo, branchName);
      if (!createResult.success) {
        throw new Error(`Workspace creation failed: ${createResult.error}`);
      }

      const workspaceId = createResult.metadata.id;
      expect(workspaceId).toBeTruthy();

      const client = resolveOrpcClient(env);

      // Set initial workspace AI settings
      const updateResult = await client.workspace.updateAISettings({
        workspaceId: workspaceId!,
        aiSettings: { model: "anthropic:claude-sonnet-4-20250514", thinkingLevel: "medium" },
      });
      expect(updateResult.success).toBe(true);

      // Send a compaction request with a different model
      // The muxMetadata type: "compaction-request" should prevent AI settings from being persisted
      await client.workspace.sendMessage({
        workspaceId: workspaceId!,
        message: "Summarize the conversation",
        options: {
          model: "openai:gpt-4.1-mini", // Different model for compaction
          thinkingLevel: "off",
          mode: "compact",
          muxMetadata: {
            type: "compaction-request",
            rawCommand: "/compact",
            parsed: {},
          },
        },
      });

      // Verify the original workspace AI settings were NOT overwritten
      const info = await client.workspace.getInfo({ workspaceId: workspaceId! });
      expect(info?.aiSettings).toEqual({
        model: "anthropic:claude-sonnet-4-20250514",
        thinkingLevel: "medium",
      });
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(tempGitRepo);
    }
  }, 60000);
});
