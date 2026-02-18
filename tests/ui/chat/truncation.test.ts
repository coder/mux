/**
 * UI integration test for chat truncation behavior.
 * Verifies a generic hidden-history indicator is surfaced and assistant meta rows remain intact.
 */

import "../dom";
import { waitFor } from "@testing-library/react";

import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo, generateBranchName } from "../../ipc/helpers";
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

async function seedHistoryWithToolCalls(
  historyService: HistoryService,
  workspaceId: string,
  pairCount: number
): Promise<void> {
  for (let i = 0; i < pairCount; i++) {
    const userMessage = createMuxMessage(`user-${i}`, "user", `user-${i}`);
    const toolMessage = {
      id: `assistant-tool-${i}`,
      role: "assistant" as const,
      parts: [
        { type: "reasoning" as const, text: `thinking-${i}` },
        {
          type: "dynamic-tool" as const,
          toolCallId: `tool-${i}`,
          toolName: "bash",
          state: "output-available" as const,
          input: { script: "echo test" },
          output: { success: true },
        },
      ],
    };
    const assistantMessage = createMuxMessage(`assistant-${i}`, "assistant", `assistant-${i}`);

    const userResult = await historyService.appendToHistory(workspaceId, userMessage);
    if (!userResult.success) {
      throw new Error(`Failed to append user history: ${userResult.error}`);
    }

    const toolResult = await historyService.appendToHistory(workspaceId, toolMessage);
    if (!toolResult.success) {
      throw new Error(`Failed to append tool history: ${toolResult.error}`);
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

  test("shows a generic hidden indicator and preserves assistant meta rows", async () => {
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

      // Must match MAX_DISPLAYED_MESSAGES in StreamingMessageAggregator.ts
      const maxDisplayedMessages = 64;
      const totalDisplayedMessages = pairCount * 4;
      const oldDisplayedMessages = totalDisplayedMessages - maxDisplayedMessages;
      const oldPairs = oldDisplayedMessages / 4;
      const expectedHiddenCount = oldPairs * 3;

      const indicator = await waitFor(() => {
        const node = view?.getByText(/some messages are hidden for performance/i);
        if (!node) {
          throw new Error("Truncation indicator not found");
        }
        return node;
      });

      expect(indicator.textContent).toContain("Some messages are hidden for performance");
      expect(indicator.textContent).toContain(`${expectedHiddenCount} messages hidden`);
      expect(indicator.textContent).toContain(`${oldPairs} tool calls`);
      expect(indicator.textContent).toContain(`${oldPairs} thinking blocks`);
      expect(view.getByRole("button", { name: /load all/i })).toBeTruthy();

      const messageBlocks = Array.from(
        view.container.querySelectorAll('[data-testid="chat-message"]')
      );
      const hiddenIndicatorCount = messageBlocks.filter((node) =>
        node.textContent?.match(/some messages are hidden for performance/i)
      ).length;
      expect(hiddenIndicatorCount).toBe(1);
      const indicatorIndex = messageBlocks.findIndex((node) =>
        node.textContent?.match(/some messages are hidden for performance/i)
      );
      expect(indicatorIndex).toBeGreaterThan(0);
      expect(messageBlocks[indicatorIndex - 1]?.textContent).toContain("user-0");
      // After the indicator, the next kept old message is user-1 (assistant rows are now omitted)
      expect(messageBlocks[indicatorIndex + 1]?.textContent).toContain("user-1");

      // Verify assistant meta rows survive in the recent (non-truncated) section.
      // assistant-0 is now in the old section and gets omitted; pick a visible one instead.
      const firstRecentPairIndex = oldPairs;
      const assistantText = view.getByText(`assistant-${firstRecentPairIndex}`);
      const messageBlock = assistantText.closest("[data-message-block]");
      expect(messageBlock).toBeTruthy();
      expect(messageBlock?.querySelector("[data-message-meta]")).not.toBeNull();
      const gapReminders = view.container.querySelectorAll('[data-testid="hidden-gap-reminder"]');
      expect(gapReminders.length).toBeGreaterThan(0);
      for (const reminder of gapReminders) {
        expect(reminder.textContent).toMatch(/\d+ messages? hidden/);
      }
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
