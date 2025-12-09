/**
 * Chat messages & interactions stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createCompactionRequestMessage,
  createFileReadTool,
  createFileEditTool,
  createBashTool,
  createTerminalTool,
  createStatusTool,
  createGenericTool,
  createPendingTool,
} from "./mockFactory";
import { setupSimpleChatStory, setupStreamingChatStory } from "./storyHelpers";
import { within, userEvent, waitFor } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/Chat",
};

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
        })
      }
    />
  ),
};

/** Chat with reasoning/thinking blocks */
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

/** Bash tool with expanded script and output sections */
export const WithBashTool: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-bash",
          messages: [
            createUserMessage("msg-1", "Check project status", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Let me check the git status and run tests:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashTool(
                  "call-1",
                  `#!/bin/bash
set -e

# Check git status
echo "=== Git Status ==="
git status --short

# Run tests
echo "=== Running Tests ==="
npm test 2>&1 | head -20`,
                  [
                    "=== Git Status ===",
                    " M src/api/users.ts",
                    " M src/auth/jwt.ts",
                    "?? src/api/users.test.ts",
                    "",
                    "=== Running Tests ===",
                    "PASS src/api/users.test.ts",
                    "  ✓ should authenticate (24ms)",
                    "  ✓ should reject invalid tokens (18ms)",
                    "",
                    "Tests: 2 passed, 2 total",
                  ].join("\n"),
                  0,
                  10,
                  1250
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
        story: "Bash tool showing multi-line script in expanded view with proper padding.",
      },
    },
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Expand the bash tool to show Script section with padding
    await waitFor(async () => {
      const toolHeader = canvas.getByText(/set -e/);
      await userEvent.click(toolHeader);
    });
    // Remove unintended focus state for deterministic visual snapshot
    (document.activeElement as HTMLElement)?.blur();
  },
};

/** Bash tool in executing state showing "Waiting for result" */
export const WithBashToolWaiting: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-bash-waiting",
          messages: [
            createUserMessage("msg-1", "Run the tests", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-2", "Running the test suite:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createPendingTool("call-1", "bash", {
                  script: "npm test",
                  run_in_background: false,
                  display_name: "Test Runner",
                  timeout_secs: 30,
                }),
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
        story:
          "Bash tool in executing state with 'Waiting for result...' showing consistent padding.",
      },
    },
  },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Expand the bash tool to show "Waiting for result" section
    await waitFor(async () => {
      const toolHeader = canvas.getByText(/npm test/);
      await userEvent.click(toolHeader);
    });
    // Remove unintended focus state for deterministic visual snapshot
    (document.activeElement as HTMLElement)?.blur();
  },
};

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

/** Voice input button shows user education when OpenAI API key is not set */
export const VoiceInputNoApiKey: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [],
          // No OpenAI key configured - voice button should be disabled with tooltip
          providersConfig: {
            anthropic: { apiKeySet: true },
            // openai deliberately missing
          },
        })
      }
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
            toolName: "read_file",
            args: { target_file: "src/db/connection.ts" },
          },
          gitStatus: { dirty: 1 },
        })
      }
    />
  ),
};

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
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    await waitFor(async () => {
      const toolHeader = canvas.getByText("fetch_data");
      await userEvent.click(toolHeader);
    });
    // Remove unintended focus state for deterministic visual snapshot
    (document.activeElement as HTMLElement)?.blur();
  },
};

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
