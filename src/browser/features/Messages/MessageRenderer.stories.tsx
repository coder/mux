import type { WorkspaceChatMessage, ChatMuxMessage } from "@/common/orpc/types";
import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, CHROMATIC_SMOKE_MODES } from "@/browser/stories/meta.js";
import {
  setupCustomChatStory,
  setupSimpleChatStory,
  setupStreamingChatStory,
} from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar } from "@/browser/stories/helpers/uiState";
import { createStaticChatHandler } from "@/browser/stories/mocks/chatHandlers";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import {
  createFileEditTool,
  createFileReadTool,
  createWebSearchTool,
} from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";

const meta = { ...appMeta, title: "App/Chat/Messages" };
export default meta;

const LARGE_DIFF = [
  "--- src/api/users.ts",
  "+++ src/api/users.ts",
  "@@ -1,50 +1,80 @@",
  "-// TODO: Add authentication middleware",
  "-// Current implementation is insecure and allows unauthorized access",
  "-// Need to validate JWT tokens before processing requests",
  "-// Also need to add rate limiting to prevent abuse",
  "-// Consider adding request logging for audit trail",
  "-// Add input validation for user IDs",
  "-// Handle edge cases for deleted/suspended users",
  "-",
  "-/**",
  "- * Get user by ID",
  "- * @param {Object} req - Express request object",
  "- * @param {Object} res - Express response object",
  "- */",
  "-export function getUser(req, res) {",
  "-  // FIXME: No authentication check",
  "-  // FIXME: No error handling",
  "-  // FIXME: Synchronous database call blocks event loop",
  "-  const user = db.users.find(req.params.id);",
  "-  res.json(user);",
  "-}",
  "+import { verifyToken } from '../auth/jwt';",
  "+import { logger } from '../utils/logger';",
  "+import { validateUserId } from '../validation';",
  "+",
  "+/**",
  "+ * Get user by ID with proper authentication and error handling",
  "+ */",
  "+export async function getUser(req, res) {",
  "+  try {",
  "+    // Validate input",
  "+    const userId = validateUserId(req.params.id);",
  "+    if (!userId) {",
  "+      return res.status(400).json({ error: 'Invalid user ID' });",
  "+    }",
  "+",
  "+    // Verify authentication",
  "+    const token = req.headers.authorization?.split(' ')[1];",
  "+    if (!token) {",
  "+      logger.warn('Missing authorization token');",
  "+      return res.status(401).json({ error: 'Unauthorized' });",
  "+    }",
  "+",
  "+    const decoded = await verifyToken(token);",
  "+    logger.info('User authenticated', { userId: decoded.sub });",
  "+",
  "+    // Fetch user with async/await",
  "+    const user = await db.users.find(userId);",
  "+    if (!user) {",
  "+      return res.status(404).json({ error: 'User not found' });",
  "+    }",
  "+",
  "+    // Filter sensitive fields",
  "+    const safeUser = filterSensitiveFields(user);",
  "+    res.json(safeUser);",
  "+  } catch (err) {",
  "+    logger.error('Error in getUser:', err);",
  "+    return res.status(500).json({ error: 'Internal server error' });",
  "+  }",
  "+}",
].join("\n");

/** Basic chat conversation with various message types */
export const Conversation: AppStory = {
  parameters: { chromatic: { modes: CHROMATIC_SMOKE_MODES } },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
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
        });
      }}
    />
  ),
};

/** Chat with reasoning/thinking blocks */
/** Synthetic auto-resume messages shown with "AUTO" badge and dimmed opacity */
export const SyntheticAutoResumeMessages: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
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
        });
      }}
    />
  ),
};

export const WithReasoning: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
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

/** Streaming/working state with pending tool call */
export const Streaming: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupStreamingChatStory({
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
        });
      }}
    />
  ),
};

// ═══ Error scenarios (migrated from App.errors.stories.tsx) ═══

/** Stream error messages in chat */
export const StreamError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const workspaceId = "ws-error";

        return setupCustomChatStory({
          workspaceId,
          chatHandler: (callback: (event: WorkspaceChatMessage) => void) => {
            setTimeout(() => {
              callback(
                createUserMessage("msg-1", "Help me refactor the database layer", {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 100000,
                })
              );
              callback({ type: "caught-up" });

              // Simulate a stream error
              callback({
                type: "stream-error",
                messageId: "error-msg",
                error: "Rate limit exceeded. Please wait before making more requests.",
                errorType: "rate_limit",
              });
            }, 50);
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            return () => {};
          },
        });
      }}
    />
  ),
};

export const AnthropicOverloaded: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const workspaceId = "ws-anthropic-overloaded";

        return setupCustomChatStory({
          workspaceId,
          chatHandler: (callback: (event: WorkspaceChatMessage) => void) => {
            setTimeout(() => {
              callback(
                createUserMessage("msg-1", "Why did my request fail?", {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 100000,
                })
              );
              callback({ type: "caught-up" });

              callback({
                type: "stream-start",
                workspaceId,
                messageId: "assistant-1",
                model: "anthropic:claude-3-5-sonnet-20241022",
                historySequence: 2,
                startTime: STABLE_TIMESTAMP - 90000,
                mode: "exec",
              });

              callback({
                type: "stream-error",
                messageId: "assistant-1",
                error: "Anthropic is temporarily overloaded (HTTP 529). Please try again later.",
                errorType: "server_error",
              });
            }, 50);
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            return () => {};
          },
        });
      }}
    />
  ),
};

export const MuxGatewayQuota: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const workspaceId = "ws-mux-gateway-quota";

        return setupCustomChatStory({
          workspaceId,
          chatHandler: (callback: (event: WorkspaceChatMessage) => void) => {
            setTimeout(() => {
              callback(
                createUserMessage("msg-1", "Why did my request fail?", {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 100000,
                })
              );
              callback({ type: "caught-up" });

              callback({
                type: "stream-start",
                workspaceId,
                messageId: "assistant-1",
                model: "mux-gateway:anthropic/claude-sonnet-4",
                routedThroughGateway: true,
                historySequence: 2,
                startTime: STABLE_TIMESTAMP - 90000,
                mode: "exec",
              });

              callback({
                type: "stream-error",
                messageId: "assistant-1",
                error: "Insufficient balance. Please add credits to continue.",
                errorType: "quota",
              });
            }, 50);
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            return () => {};
          },
        });
      }}
    />
  ),
};

/** Chat with truncated/hidden history indicator */
export const HiddenHistory: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        // Hidden message type uses special "hidden" role not in ChatMuxMessage union
        // Cast is needed since this is a display-only message type
        const hiddenIndicator = {
          type: "message",
          id: "hidden-1",
          role: "hidden",
          parts: [],
          metadata: {
            historySequence: 0,
            hiddenCount: 42,
          },
        } as unknown as ChatMuxMessage;

        const messages: ChatMuxMessage[] = [
          hiddenIndicator,
          createUserMessage("msg-1", "Can you summarize what we discussed?", {
            historySequence: 43,
            timestamp: STABLE_TIMESTAMP - 100000,
          }),
          createAssistantMessage(
            "msg-2",
            "Based on our previous conversation, we discussed implementing authentication, adding tests, and refactoring the database layer.",
            {
              historySequence: 44,
              timestamp: STABLE_TIMESTAMP - 90000,
            }
          ),
        ];

        return setupCustomChatStory({
          workspaceId: "ws-history",
          chatHandler: createStaticChatHandler(messages),
        });
      }}
    />
  ),
};

/** Large file diff in chat */
export const LargeDiff: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
          workspaceId: "ws-diff",
          messages: [
            createUserMessage(
              "msg-1",
              "Refactor the user API with proper auth and error handling",
              {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 100000,
              }
            ),
            createAssistantMessage(
              "msg-2",
              "I've refactored the user API with authentication, validation, and proper error handling:",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
                toolCalls: [createFileEditTool("call-1", "src/api/users.ts", LARGE_DIFF)],
              }
            ),
          ],
        });
      }}
    />
  ),
};
