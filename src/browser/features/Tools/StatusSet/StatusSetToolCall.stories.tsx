import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createStatusTool,
} from "@/browser/stories/mockFactory";

const meta = { ...appMeta, title: "App/Chat/Tools/StatusSet" };
export default meta;

/** Chat with agent status indicator */
export const WithAgentStatus: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-status",
          messages: [
            createUserMessage("msg-1", "Create a PR for the auth changes", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've created PR #1234 with the authentication changes.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                toolCalls: [
                  createStatusTool(
                    "call-1",
                    "🚀",
                    "PR #1234 waiting for CI",
                    "https://github.com/example/repo/pull/1234"
                  ),
                ],
              }
            ),
          ],
        })
      }
    />
  ),
};
