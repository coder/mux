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
});
