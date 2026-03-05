import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createGenericTool,
  createUserMessage,
} from "@/browser/stories/mockFactory";
import { waitForChatMessagesLoaded } from "@/browser/stories/storyPlayHelpers.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import { userEvent, waitFor, within } from "@storybook/test";

const meta = { ...appMeta, title: "App/Chat/Tools/Todo" };
export default meta;

/**
 * Story showing a todo_write tool call with very long todo items.
 * Regression test for todo rows overflowing their container in the chat window.
 */
export const TodoWriteWithLongTodos: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-todo-overflow",
          messages: [
            createUserMessage("msg-1", "Can you track tasks in a todo list?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Sure — here are the tasks:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createGenericTool(
                  "call-todo-1",
                  "todo_write",
                  {
                    todos: [
                      {
                        content:
                          "Create British-themed layout (HTML) matching reference: left nav, hero section, decorative flourishes, and a deliberately overlong description to force truncation in narrow layouts",
                        status: "pending",
                      },
                      {
                        content:
                          "Implement grotesque Great Britain pride styling (Union Jack, red/white/blue palette, overly ornate typography) with enough detail to overflow a single line",
                        status: "in_progress",
                      },
                      {
                        content:
                          "Add small JS for interactions (active nav, mobile drawer, hover effects, focus states, keyboard shortcuts, and more) — again intentionally verbose",
                        status: "pending",
                      },
                      {
                        content:
                          "Run a local server and verify layout + responsiveness across breakpoints; include a comically long note about testing on multiple devices and ensuring no horizontal overflow",
                        status: "pending",
                      },
                    ],
                  },
                  { success: true, count: 4 }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatMessagesLoaded(storyRoot);

    const messageWindow = storyRoot.querySelector('[data-testid="message-window"]');
    if (!(messageWindow instanceof HTMLElement)) {
      throw new Error("Message window not found");
    }

    // Expand the tool call (TodoToolCall is collapsed by default).
    const canvas = within(messageWindow);

    if (!canvas.queryByText(/Create British-themed layout \(HTML\)/)) {
      // Wait for the tool header expand icon to appear.
      await waitFor(
        () => {
          canvas.getAllByText("▶");
        },
        { timeout: 8000 }
      );

      await userEvent.click(canvas.getAllByText("▶")[0]);
    }

    // Verify that todo content rows are using truncation.
    await waitFor(() => {
      const firstTodo = canvas.getByText(/Create British-themed layout \(HTML\)/);
      if (!firstTodo.classList.contains("truncate")) {
        throw new Error("Expected todo row to have Tailwind 'truncate' class");
      }
    });

    // Verify chat pane doesn't gain horizontal overflow.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (messageWindow.scrollWidth > messageWindow.clientWidth) {
      throw new Error("Message window has horizontal overflow");
    }
  },
  parameters: {
    docs: {
      description: {
        story:
          "Regression test for long todo text overflowing its container. " +
          "Todo rows should truncate with ellipsis and the message window should not horizontally scroll.",
      },
    },
  },
};
