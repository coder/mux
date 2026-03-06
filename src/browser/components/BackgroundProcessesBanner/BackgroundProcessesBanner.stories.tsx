import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createTerminalTool,
  createUserMessage,
} from "@/browser/stories/mockFactory";

const meta = {
  ...appMeta,
  title: "App/Chat/Components/BackgroundProcesses",
};

export default meta;

/** Chat with running background processes banner */
export const BackgroundProcesses: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Start the dev server and run tests in background", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 60000,
            }),
            createAssistantMessage(
              "msg-2",
              "I've started the dev server and test runner in the background. You can continue working while they run.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 50000,
                toolCalls: [
                  createTerminalTool(
                    "call-1",
                    "npm run dev &",
                    "Starting dev server on port 3000..."
                  ),
                  createTerminalTool("call-2", "npm test -- --watch &", "Running test suite..."),
                ],
              }
            ),
          ],
          backgroundProcesses: [
            {
              id: "bash_1",
              pid: 12345,
              script: "npm run dev",
              displayName: "Dev Server",
              startTime: Date.now() - 45000, // 45 seconds ago
              status: "running",
            },
            {
              id: "bash_2",
              pid: 12346,
              script: "npm test -- --watch",
              displayName: "Test Runner",
              startTime: Date.now() - 30000, // 30 seconds ago
              status: "running",
            },
            {
              id: "bash_3",
              pid: 12347,
              script: "tail -f /var/log/app.log",
              startTime: Date.now() - 120000, // 2 minutes ago
              status: "running",
            },
          ],
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the background processes banner when there are running background bash processes. Click the banner to expand and see process details or terminate them.",
      },
    },
  },
};
