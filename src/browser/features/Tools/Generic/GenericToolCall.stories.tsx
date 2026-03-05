import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createGenericTool,
  createUserMessage,
} from "@/browser/stories/mockFactory";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";

const meta = { ...appMeta, title: "App/Chat/Tools/Generic" };
export default meta;

/** Generic tool call with JSON-highlighted arguments and results */
export const GenericTool: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Fetch a large dataset", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage("msg-2", "I'll fetch that data for you.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 55000,
              toolCalls: [
                createGenericTool(
                  "call-1",
                  "fetch_data",
                  {
                    endpoint: "/api/users",
                    params: { limit: 100, offset: 0 },
                  },
                  {
                    success: true,
                    // Generate 100+ line result to test line number alignment
                    data: Array.from({ length: 50 }, (_, i) => ({
                      id: i + 1,
                      name: `User ${i + 1}`,
                      email: `user${i + 1}@example.com`,
                      active: i % 3 !== 0,
                    })),
                    total: 500,
                    page: 1,
                  }
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story: "Generic tool call with JSON syntax highlighting and 100+ lines.",
      },
    },
  },
};
