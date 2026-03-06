import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createWebSearchTool,
  createFileReadTool,
  createFileEditTool,
} from "@/browser/stories/mockFactory";
import { setupSimpleChatStory, setupStreamingChatStory } from "@/browser/stories/storyHelpers.js";

const meta = { ...appMeta, title: "App/Chat/Messages" };
export default meta;

/** Basic chat conversation with various message types */
export const Conversation: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Add authentication to the user API endpoint", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you add authentication. Let me search for best practices first.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 295000,
                toolCalls: [createWebSearchTool("call-0", "JWT authentication best practices", 5)],
              }
            ),
            createAssistantMessage("msg-3", "Great, let me check the current implementation.", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createFileReadTool(
                  "call-1",
                  "src/api/users.ts",
                  "export function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}"
                ),
              ],
            }),
            createUserMessage("msg-4", "Yes, add JWT token validation", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage("msg-5", "I'll add JWT validation. Here's the update:", {
              historySequence: 5,
              timestamp: STABLE_TIMESTAMP - 270000,
              toolCalls: [
                createFileEditTool(
                  "call-2",
                  "src/api/users.ts",
                  [
                    "--- src/api/users.ts",
                    "+++ src/api/users.ts",
                    "@@ -1,5 +1,15 @@",
                    "+import { verifyToken } from '../auth/jwt';",
                    " export function getUser(req, res) {",
                    "+  const token = req.headers.authorization?.split(' ')[1];",
                    "+  if (!token || !verifyToken(token)) {",
                    "+    return res.status(401).json({ error: 'Unauthorized' });",
                    "+  }",
                    "   const user = db.users.find(req.params.id);",
                    "   res.json(user);",
                    " }",
                  ].join("\n")
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/** Chat with reasoning/thinking blocks */
/** Synthetic auto-resume messages shown with "AUTO" badge and dimmed opacity */
export const SyntheticAutoResumeMessages: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run the full test suite and fix any failures", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll run the tests now. Let me spawn a sub-agent to handle the test execution.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 295000,
              }
            ),
            createUserMessage(
              "msg-3",
              "You have active background sub-agent task(s) (task-abc123). " +
                "You MUST NOT end your turn while any sub-agent tasks are queued/running/awaiting_report. " +
                "Call task_await now to wait for them to finish.",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 290000,
                synthetic: true,
              }
            ),
            createAssistantMessage("msg-4", "I'll wait for the sub-agent to complete its work.", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 285000,
            }),
            createUserMessage(
              "msg-5",
              "Your background sub-agent task(s) have completed. Use task_await to retrieve their reports and integrate the results.",
              {
                historySequence: 5,
                timestamp: STABLE_TIMESTAMP - 280000,
                synthetic: true,
              }
            ),
            createAssistantMessage(
              "msg-6",
              "The sub-agent has finished. All 47 tests passed successfully — no failures found.",
              {
                historySequence: 6,
                timestamp: STABLE_TIMESTAMP - 275000,
              }
            ),
          ],
        })
      }
    />
  ),
};

export const WithReasoning: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-reasoning",
          messages: [
            createUserMessage("msg-1", "What about error handling if the JWT library throws?", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage(
              "msg-2",
              "Good catch! We should add try-catch error handling around the JWT verification.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                reasoning:
                  "The user is asking about error handling for JWT verification. The verifyToken function could throw if the token is malformed or if there's an issue with the secret. I should wrap it in a try-catch block and return a proper error response.",
              }
            ),
            createAssistantMessage(
              "msg-3",
              "Cache is warm, shifting focus to documentation next.",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 80000,
                reasoning: "Cache is warm already; rerunning would be redundant.",
              }
            ),
          ],
        })
      }
    />
  ),
};

/** Streaming/working state with pending tool call */
export const Streaming: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupStreamingChatStory({
          messages: [
            createUserMessage("msg-1", "Refactor the database connection to use pooling", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 3000,
            }),
          ],
          streamingMessageId: "msg-2",
          historySequence: 2,
          streamText: "I'll help you refactor the database connection to use connection pooling.",
          pendingTool: {
            toolCallId: "call-1",
            toolName: "file_read",
            args: { path: "src/db/connection.ts" },
          },
          gitStatus: { dirty: 1 },
        })
      }
    />
  ),
};
