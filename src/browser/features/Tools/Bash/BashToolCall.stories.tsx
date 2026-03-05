import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createTerminalTool,
} from "@/browser/stories/mockFactory";

const meta = { ...appMeta, title: "App/Chat/Tools/Bash" };
export default meta;

/** Chat with terminal output showing test results */
export const WithTerminal: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-terminal",
          messages: [
            createUserMessage("msg-1", "Can you run the tests?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Running the test suite now:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createTerminalTool(
                  "call-1",
                  "npm test",
                  [
                    "PASS src/api/users.test.ts",
                    "  ✓ should return user when authenticated (24ms)",
                    "  ✓ should return 401 when no token (18ms)",
                    "  ✓ should return 401 when invalid token (15ms)",
                    "",
                    "Test Suites: 1 passed, 1 total",
                    "Tests:       3 passed, 3 total",
                  ].join("\n")
                ),
              ],
            }),
            createAssistantMessage("msg-3", "Here's a failing test for comparison:", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 80000,
              toolCalls: [
                createTerminalTool(
                  "call-2",
                  "npm test -- --testNamePattern='edge case'",
                  [
                    "FAIL src/api/users.test.ts",
                    "  ✕ should handle edge case (45ms)",
                    "",
                    "Error: Expected 200 but got 500",
                    "  at Object.<anonymous> (src/api/users.test.ts:42:5)",
                    "",
                    "Test Suites: 1 failed, 1 total",
                    "Tests:       1 failed, 1 total",
                  ].join("\n"),
                  1
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};
