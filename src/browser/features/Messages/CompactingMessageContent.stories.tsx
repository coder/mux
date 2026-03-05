import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createCompactionRequestMessage,
} from "@/browser/stories/mockFactory";
import { setupStreamingChatStory } from "@/browser/stories/storyHelpers.js";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY } from "@/common/constants/storage";

const meta = { ...appMeta, title: "App/Chat/Messages/Compaction" };
export default meta;

/** Streaming compaction with shimmer effect - tests GPU-accelerated animation */
export const StreamingCompaction: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupStreamingChatStory({
          workspaceId: "ws-compaction",
          messages: [
            createUserMessage("msg-1", "Help me refactor this codebase", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've analyzed the codebase and made several improvements to the architecture.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 200000,
              }
            ),
            createCompactionRequestMessage("msg-3", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
          ],
          streamingMessageId: "msg-4",
          historySequence: 4,
          streamText:
            "## Conversation Summary\n\nThe user requested help refactoring the codebase. Key changes made:\n\n- Restructured component hierarchy for better separation of concerns\n- Extracted shared utilities into dedicated modules\n- Improved type safety across API boundaries",
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the compaction shimmer effect during streaming. The shimmer uses GPU-accelerated CSS transforms instead of background-position animations to prevent frame drops.",
      },
    },
  },
};

/** Streaming compaction with configure hint - shows when no compaction model is set */
export const StreamingCompactionWithConfigureHint: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        // Ensure no compaction model is set so the "configure" hint appears
        updatePersistedState(AGENT_AI_DEFAULTS_KEY, undefined);

        return setupStreamingChatStory({
          workspaceId: "ws-compaction-hint",
          messages: [
            createUserMessage("msg-1", "Help me with this project", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've been helping with various tasks on this project.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 200000,
              }
            ),
            createCompactionRequestMessage("msg-3", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
          ],
          streamingMessageId: "msg-4",
          historySequence: 4,
          streamText: "## Conversation Summary\n\nSummarizing the conversation...",
        });
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Shows the "configure" hint link in the streaming barrier during compaction when no custom compaction model is set. Clicking it opens Settings → Models.',
      },
    },
  },
};
