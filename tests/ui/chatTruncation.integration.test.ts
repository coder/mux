/**
 * UI integration test for chat truncation behavior.
 * Verifies tool/reasoning omissions are surfaced and assistant meta rows remain intact.
 */

import { waitFor } from "@testing-library/react";

import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo, generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "@/node/git";
import { HistoryService } from "@/node/services/historyService";
import { createMuxMessage } from "@/common/types/message";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";

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

async function seedHistoryWithToolCalls(
  historyService: HistoryService,
  workspaceId: string,
  pairCount: number
): Promise<void> {
  for (let i = 0; i < pairCount; i++) {
    const userMessage = createMuxMessage(`user-${i}`, "user", `user-${i}`);
    const assistantMessage = createMuxMessage(
      `assistant-${i}`,
      "assistant",
      `assistant-${i}`,
      undefined,
      [
        { type: "reasoning" as const, text: `thinking-${i}` },
        {
          type: "dynamic-tool" as const,
          toolCallId: `tool-${i}`,
          toolName: "bash",
          state: "output-available" as const,
          input: { script: "echo test" },
          output: { success: true },
        },
      ]
    );

    const userResult = await historyService.appendToHistory(workspaceId, userMessage);
    if (!userResult.success) {
      throw new Error(`Failed to append user history: ${userResult.error}`);
    }

    const assistantResult = await historyService.appendToHistory(workspaceId, assistantMessage);
    if (!assistantResult.success) {
      throw new Error(`Failed to append assistant history: ${assistantResult.error}`);
    }
  }
}

describe("Chat truncation UI", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("shows truncation details and preserves assistant meta rows", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();
    const cleanupDom = installDom();
    let view: ReturnType<typeof renderApp> | undefined;
    let workspaceId: string | undefined;

    try {
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);
      const branchName = generateBranchName("ui-truncation");

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
      const pairCount = 33;
      await seedHistoryWithToolCalls(historyService, workspaceId, pairCount);

      view = renderApp({ apiClient: env.orpc, metadata: createResult.metadata });
      await setupWorkspaceView(view, createResult.metadata, workspaceId);
      await waitForWorkspaceChatToRender(view.container);

      const maxDisplayedMessages = 128;
      const totalDisplayedMessages = pairCount * 4;
      const oldDisplayedMessages = totalDisplayedMessages - maxDisplayedMessages;
      const oldPairs = oldDisplayedMessages / 4;
      const expectedHiddenCount = oldPairs * 2;
      const expectedToolCount = oldPairs;
      const expectedThinkingCount = oldPairs;

      const indicator = await waitFor(() => {
        const node = view?.getByText(/older messages hidden for performance/i);
        if (!node) {
          throw new Error("Truncation indicator not found");
        }
        return node;
      });

      expect(indicator.textContent).toContain(`${expectedHiddenCount} older message`);
      expect(indicator.textContent).toContain(`${expectedToolCount} tool call`);
      expect(indicator.textContent).toContain(`${expectedThinkingCount} thinking block`);

      const assistantText = view.getByText("assistant-0");
      const messageBlock = assistantText.closest("[data-message-block]");
      expect(messageBlock).toBeTruthy();
      expect(messageBlock?.querySelector("[data-message-meta]")).not.toBeNull();
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
