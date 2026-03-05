import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createUserMessage,
} from "@/browser/stories/mockFactory";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import { getModelKey } from "@/common/constants/storage";
import { waitForChatMessagesLoaded } from "@/browser/stories/storyPlayHelpers.js";

const meta = {
  ...appMeta,
  title: "App/Chat/Components/ContextSwitchWarning",
};

export default meta;

/**
 * Context switch warning banner - shows when switching to a model that can't fit current context.
 *
 * Scenario: Workspace has ~150K tokens of context. The user switches from Sonnet (200K+ limit)
 * to GPT-4o (128K limit). Since 150K > 90% of 128K, the warning banner appears.
 */
const contextSwitchWorkspaceId = "ws-context-switch";

export const ContextSwitchWarning: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Start on Sonnet so the explicit switch to GPT-4o triggers the warning.
        updatePersistedState(getModelKey(contextSwitchWorkspaceId), "anthropic:claude-sonnet-4-5");

        return setupSimpleChatStory({
          workspaceId: contextSwitchWorkspaceId,
          messages: [
            createUserMessage("msg-1", "Help me refactor this large codebase", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            // Large context usage - 150K tokens from Sonnet (which handles 200K+)
            // Now switching to GPT-4o (128K limit): 150K > 90% of 128K triggers warning
            createAssistantMessage(
              "msg-2",
              "I've analyzed the codebase. Here's my refactoring plan...",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                model: "anthropic:claude-sonnet-4-5",
                contextUsage: {
                  inputTokens: 150000,
                  outputTokens: 2000,
                },
              }
            ),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatMessagesLoaded(storyRoot);
    setWorkspaceModelWithOrigin(contextSwitchWorkspaceId, "openai:gpt-4o", "user");
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the context switch warning banner. Previous message used Sonnet (150K tokens), " +
          "but workspace is now set to GPT-4o (128K limit). Since 150K exceeds 90% of 128K, " +
          "the warning banner appears offering a one-click compact action.",
      },
    },
  },
};
