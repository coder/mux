/**
 * UI integration test for task_apply_git_patch commit list rendering.
 *
 * The Apply Patch tool should show which commits were (or would be) applied,
 * instead of only a summary count.
 */

import "../dom";

import { waitFor } from "@testing-library/react";

import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";
import { detectDefaultTrunkBranch } from "@/node/git";
import { HistoryService } from "@/node/services/historyService";
import { createMuxMessage } from "@/common/types/message";

import { installDom } from "../dom";
import { renderApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";

async function waitForWorkspaceChatToRender(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const messageWindow = container.querySelector('[data-testid="message-window"]');
      if (!messageWindow) {
        throw new Error("Workspace chat view not rendered yet");
      }
    },
    { timeout: 30_000 }
  );
}

async function seedHistory(historyService: HistoryService, workspaceId: string): Promise<void> {
  const userMessage = createMuxMessage("user-1", "user", "Apply the patch from task-fe-001");

  const taskApplyGitPatchToolMessage = createMuxMessage(
    "assistant-task-apply-git-patch",
    "assistant",
    "",
    undefined,
    [
      {
        type: "dynamic-tool" as const,
        toolCallId: "tool-task-apply-git-patch-1",
        toolName: "task_apply_git_patch" as const,
        state: "output-available" as const,
        input: {
          task_id: "task-fe-001",
          three_way: true,
        },
        output: {
          success: true,
          taskId: "task-fe-001",
          appliedCommits: [
            {
              sha: "0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6",
              subject: "feat: add Apply Patch tool UI",
            },
            {
              sha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
              subject: "fix: render applied commit list",
            },
          ],
          headCommitSha: "d7a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
        },
      },
    ]
  );

  for (const msg of [userMessage, taskApplyGitPatchToolMessage]) {
    const result = await historyService.appendToHistory(workspaceId, msg);
    if (!result.success) {
      throw new Error(`Failed to append history: ${result.error}`);
    }
  }
}

describe("task_apply_git_patch commit list", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("renders applied commit subjects and SHAs", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    await trustProject(env, repoPath);
    const cleanupDom = installDom();
    let view: ReturnType<typeof renderApp> | undefined;
    let workspaceId: string | undefined;

    try {
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);
      const branchName = generateBranchName("ui-task-apply-git-patch");

      const createResult = await env.orpc.workspace.create({
        projectPath: repoPath,
        branchName,
        trunkBranch,
      });

      if (!createResult.success) {
        throw new Error(`Failed to create workspace: ${createResult.error}`);
      }

      workspaceId = createResult.metadata.id;

      const historyService = new HistoryService(env.config);
      await seedHistory(historyService, workspaceId);

      view = renderApp({ apiClient: env.orpc, metadata: createResult.metadata });
      await setupWorkspaceView(view, createResult.metadata, workspaceId);
      await waitForWorkspaceChatToRender(view.container);

      const toolHeader = view.getByText("Apply patch");
      toolHeader.click();

      await waitFor(() => {
        expect(view?.queryAllByText("Commits")).toHaveLength(1);

        expect(view?.queryAllByText("feat: add Apply Patch tool UI")).toHaveLength(1);
        expect(view?.queryAllByText("fix: render applied commit list")).toHaveLength(1);

        // Short SHA display (copy button still copies the full SHA).
        expect(view?.queryAllByText("0f1e2d3")).toHaveLength(1);
        expect((view?.queryAllByText("d7a1b2c") ?? []).length).toBeGreaterThanOrEqual(1);
      });
    } finally {
      if (view) {
        await cleanupView(view, cleanupDom);
      } else {
        cleanupDom();
      }

      if (workspaceId) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort cleanup.
        }
      }

      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 60_000);
});
