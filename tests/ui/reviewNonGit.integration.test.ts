import "./dom";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  createTestEnvironment,
  cleanupTestEnvironment,
  preloadTestModules,
  setupProviders,
} from "../ipc/setup";
import { createTempGitRepo, cleanupTempGitRepo, generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";

import { installDom } from "./dom";
import { renderReviewPanel } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Review tab non-git workspace", () => {
  test("shows not-a-git-repository message and hides untracked banner", async () => {
    await preloadTestModules();
    const env = await createTestEnvironment();
    env.services.aiService.enableMockMode();

    // AppLoader blocks workspace creation UI when there are no configured providers.
    // Use a dummy key (no AI calls are made in this test).
    await setupProviders(env, {
      anthropic: { apiKey: "test-key-for-ui-tests" },
    });

    const repoPath = await createTempGitRepo();

    let workspaceId: string | undefined;

    try {
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);
      const branchName = generateBranchName("non-git");

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      if (!createResult.success) {
        throw new Error(`Failed to create workspace: ${createResult.error}`);
      }

      workspaceId = createResult.metadata.id;
      const metadata = createResult.metadata;

      // Simulate a workspace that isn't a git repo.
      const rmResult = await env.orpc.workspace.executeBash({
        workspaceId,
        script: "rm -rf .git",
      });
      expect(rmResult.success).toBe(true);
      if (!rmResult.success) return;
      expect(rmResult.data.success).toBe(true);

      const cleanupDom = installDom();
      const view = renderReviewPanel({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await view.selectTab("review");

        await view.findByText(/^Not a git repository$/i, {}, { timeout: 60_000 });
        expect(view.queryByText(/untracked\s+file/i)).toBeNull();
        expect(view.queryByText(/Track All Files/i)).toBeNull();
      } finally {
        await cleanupView(view, cleanupDom);
      }
    } finally {
      if (workspaceId) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort.
        }
      }

      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 120_000);
});
