/**
 * Chat messages & interactions stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createFileReadTool,
  createFileEditTool,
  createTerminalTool,
  createStatusTool,
} from "./mockFactory";
import { setupSimpleChatStory, setupStreamingChatStory } from "./storyHelpers";

export default {
  ...appMeta,
  title: "App/Chat",
};

/** Basic chat conversation with various message types */
export const Conversation: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Add authentication to the user API endpoint", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you add authentication. Let me check the current implementation.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createFileReadTool(
                    "call-1",
                    "src/api/users.ts",
                    "export function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}"
                  ),
                ],
              }
            ),
            createUserMessage("msg-3", "Yes, add JWT token validation", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage("msg-4", "I'll add JWT validation. Here's the update:", {
              historySequence: 4,
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
        });
      }}
    />
  ),
};

/** Chat with reasoning/thinking blocks */
export const WithReasoning: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
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
        });
      }}
    />
  ),
};

/** Chat with terminal output showing test results */
export const WithTerminal: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
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
        });
      }}
    />
  ),
};

/** Chat with agent status indicator */
export const WithAgentStatus: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
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
        });
      }}
    />
  ),
};

/** Voice input button shows user education when OpenAI API key is not set */
export const VoiceInputNoApiKey: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        setupSimpleChatStory({
          messages: [],
          // No OpenAI key configured - voice button should be disabled with tooltip
          providersConfig: {
            anthropic: { apiKeySet: true },
            // openai deliberately missing
          },
        });
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the voice input button in disabled state when OpenAI API key is not configured. Hover over the mic icon in the chat input to see the user education tooltip.",
      },
    },
  },
};

/** Streaming/working state with pending tool call */
export const Streaming: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
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
            toolName: "read_file",
            args: { target_file: "src/db/connection.ts" },
          },
          gitStatus: { dirty: 1 },
        });
      }}
    />
  ),
};
