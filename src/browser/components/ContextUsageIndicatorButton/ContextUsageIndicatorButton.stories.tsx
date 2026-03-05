import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createFileReadTool,
  createUserMessage,
} from "@/browser/stories/mockFactory";
import { within, userEvent, waitFor } from "@storybook/test";

const meta = {
  ...appMeta,
  title: "App/Chat/Components/ContextUsageIndicator",
};

export default meta;

/**
 * Context meter with high usage and idle compaction enabled.
 * Shows the context usage indicator badge in the chat input area with the
 * hourglass badge indicating idle compaction is configured.
 */
export const ContextMeterWithIdleCompaction: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-context-meter",
          workspaceName: "feature/auth",
          projectName: "my-app",
          idleCompactionHours: 4,
          messages: [
            createUserMessage("msg-1", "Help me refactor the authentication module", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you refactor the authentication module. Let me first review the current implementation.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                // High context usage to show the meter prominently (65% of 200k = 130k tokens)
                contextUsage: { inputTokens: 130000, outputTokens: 2000 },
                toolCalls: [
                  createFileReadTool(
                    "call-1",
                    "src/auth/index.ts",
                    'export { login, logout, verifyToken } from "./handlers";'
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Wait for the context meter to appear (it shows token usage)
    await waitFor(() => {
      // Look for the context meter button which shows token counts
      canvas.getByRole("button", { name: /context/i });
    });
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the Context Meter with high usage (~65%) and idle compaction enabled (4h). " +
          "The meter displays an hourglass badge indicating idle compaction is configured.",
      },
    },
  },
};

/**
 * Context meter hover summary tooltip.
 *
 * Captures the non-interactive one-line tooltip shown on hover so the quick
 * compaction stats remain visible even after controls moved to click-to-open.
 */
export const ContextMeterHoverSummaryTooltip: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-context-meter-hover",
          workspaceName: "feature/context-meter-hover",
          projectName: "my-app",
          idleCompactionHours: 4,
          messages: [
            createUserMessage("msg-1", "Can you keep an eye on context usage?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 240000,
            }),
            createAssistantMessage(
              "msg-2",
              "Sure — I’ll keep compaction settings tuned as usage grows.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 230000,
                contextUsage: { inputTokens: 128000, outputTokens: 2500 },
              }
            ),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    const contextButton = await waitFor(
      () => canvas.getByRole("button", { name: /context usage/i }),
      { interval: 50, timeout: 10000 }
    );

    await userEvent.hover(contextButton);

    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!(tooltip instanceof HTMLElement)) {
          throw new Error("Compaction hover summary tooltip not visible");
        }

        const text = tooltip.textContent ?? "";
        if (!text.includes("Context ")) {
          throw new Error("Expected context usage summary in tooltip");
        }
        if (!text.includes("Auto ")) {
          throw new Error("Expected auto-compaction summary in tooltip");
        }
        if (!text.includes("Idle 4h")) {
          throw new Error("Expected idle compaction summary in tooltip");
        }
      },
      { interval: 50, timeout: 5000 }
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "Captures the context usage hover summary tooltip with one-line stats for context, auto-compaction threshold, and idle timer.",
      },
    },
  },
};
