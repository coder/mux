import type { WorkspaceChatMessage, ChatMuxMessage } from "@/common/orpc/types";
import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, CHROMATIC_SMOKE_MODES } from "@/browser/stories/meta.js";
import {
  setupCustomChatStory,
  setupSimpleChatStory,
  setupStreamingChatStory,
} from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar } from "@/browser/stories/helpers/uiState";
import {
  createAssistantMessage,
  createGoalBudgetLimitMessage,
  createGoalContinuationMessage,
  createUserMessage,
} from "@/browser/stories/mocks/messages";
import {
  WORKFLOW_RESULT_METADATA_TYPE,
  WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE,
  WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
  buildWorkflowRunCardMessage,
} from "@/common/utils/workflowRunMessages";
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

/**
 * Core conversation composite (smoke story).
 *
 * Folds several non-interactive permutations into one chat to keep the
 * Chromatic snapshot budget low while preserving coverage:
 * - truncated/hidden history indicator (merged from HiddenHistory)
 * - user/assistant text + web search / file read / file edit tool calls
 * - reasoning/thinking blocks (merged from WithReasoning)
 */
export const Conversation: AppStory = {
  parameters: { chromatic: { modes: CHROMATIC_SMOKE_MODES } },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        // Hidden message type uses special "hidden" role not in ChatMuxMessage union.
        // Cast is needed since this is a display-only message type.
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
          // Reasoning/thinking blocks (merged from former WithReasoning story)
          createUserMessage("msg-6", "What about error handling if the JWT library throws?", {
            historySequence: 6,
            timestamp: STABLE_TIMESTAMP - 100000,
          }),
          createAssistantMessage(
            "msg-7",
            "Good catch! We should add try-catch error handling around the JWT verification.",
            {
              historySequence: 7,
              timestamp: STABLE_TIMESTAMP - 90000,
              reasoning:
                "The user is asking about error handling for JWT verification. The verifyToken function could throw if the token is malformed or if there's an issue with the secret. I should wrap it in a try-catch block and return a proper error response.",
            }
          ),
          createAssistantMessage("msg-8", "Cache is warm, shifting focus to documentation next.", {
            historySequence: 8,
            timestamp: STABLE_TIMESTAMP - 80000,
            reasoning: "Cache is warm already; rerunning would be redundant.",
          }),
        ];

        return setupSimpleChatStory({ messages });
      }}
    />
  ),
};

export const WorkflowTriggeredCommand: AppStory = {
  parameters: { chromatic: { disableSnapshot: true } },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const rawCommand = "/shallow-review what do you think of workflows";
        const runId = "wfr_workflow_trigger_story";
        const workflowRun = {
          id: runId,
          workspaceId: "ws-workflow-trigger",
          workflow: {
            name: "shallow-review",
            description: "Quick workflow review",
            scope: "project" as const,
            sourcePath: "/tmp/mux/sessions/workspace/workflows/shallow-review.js",
            executable: true,
          },
          source: "export default function workflow() { return null; }",
          sourceHash: "sha256:workflow-trigger-story",
          args: { input: "what do you think of workflows" },
          status: "running" as const,
          createdAt: "2026-05-29T00:00:00.000Z",
          updatedAt: "2026-05-29T00:00:01.000Z",
          events: [
            {
              sequence: 1,
              type: "status" as const,
              at: "2026-05-29T00:00:00.000Z",
              status: "running" as const,
            },
            { sequence: 2, type: "phase" as const, at: "2026-05-29T00:00:01.000Z", name: "gather" },
          ],
          steps: [],
        };
        const workflowCard = buildWorkflowRunCardMessage(
          { name: "shallow-review", args: workflowRun.args },
          { runId, status: workflowRun.status, result: null, run: workflowRun },
          STABLE_TIMESTAMP - 295000
        ) as ChatMuxMessage;
        workflowCard.type = "message";
        workflowCard.metadata = {
          historySequence: 2,
          timestamp: STABLE_TIMESTAMP - 295000,
          synthetic: true,
          uiVisible: true,
          muxMetadata: { type: WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE, runId },
        };

        return setupSimpleChatStory({
          workspaceId: "ws-workflow-trigger",
          messages: [
            createUserMessage("workflow-command", rawCommand, {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
              muxMetadata: {
                type: WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE,
                rawCommand,
                commandPrefix: "/shallow-review",
                runId,
              },
            }),
            workflowCard,
            createUserMessage(
              "workflow-result-hidden",
              `${rawCommand}\n\n<mux_workflow_result>{}</mux_workflow_result>`,
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 290000,
                muxMetadata: {
                  type: WORKFLOW_RESULT_METADATA_TYPE,
                  rawCommand,
                  commandPrefix: "/shallow-review",
                  runId,
                },
              }
            ),
          ],
        });
      }}
    />
  ),
};

/**
 * Synthetic / goal system-message composite.
 *
 * Folds three non-interactive permutations into one chat:
 * - synthetic auto-resume messages shown with "AUTO" badge and dimmed opacity
 * - goal continuation message (merged from GoalContinuationMessages)
 * - goal budget-limit wrap-up message (merged from BudgetLimitWrapupMessages)
 */
export const SyntheticAutoResumeMessages: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return setupSimpleChatStory({
          workspaceId: "ws-synthetic-goal",
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
            createUserMessage(
              "msg-4",
              "Your background sub-agent task(s) have completed. Use task_await to retrieve their reports and integrate the results.",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 285000,
                synthetic: true,
              }
            ),
            // Goal continuation (merged from former GoalContinuationMessages story)
            createGoalContinuationMessage(
              "msg-5",
              "Continue working on the active workspace goal.\n\n<untrusted_objective>Ship the requested feature with tests.</untrusted_objective>",
              {
                historySequence: 5,
                timestamp: STABLE_TIMESTAMP - 120000,
              }
            ),
            createAssistantMessage(
              "msg-6",
              "Continuing from the active goal, I'll add coverage next.",
              {
                historySequence: 6,
                timestamp: STABLE_TIMESTAMP - 110000,
              }
            ),
            // Goal budget-limit wrap-up (merged from former BudgetLimitWrapupMessages story)
            createGoalBudgetLimitMessage(
              "msg-7",
              "The budget for this goal has been exhausted.\n\n<untrusted_objective>Ship the requested feature with tests.</untrusted_objective>\n\nBring the current line of work to a clean stopping point, summarize where things stand, and stop.",
              {
                historySequence: 7,
                timestamp: STABLE_TIMESTAMP - 60000,
              }
            ),
            createAssistantMessage(
              "msg-8",
              "Stopping here: tests are partially updated and the remaining risk is in the UI smoke coverage.",
              {
                historySequence: 8,
                timestamp: STABLE_TIMESTAMP - 50000,
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

/**
 * Stream error composite gallery.
 *
 * Folds three non-interactive error permutations into one chat, each rendering
 * as a distinct stream-error row in the message list:
 * - generic rate-limit error (StreamError)
 * - Anthropic overloaded / HTTP 529 server error (merged from AnthropicOverloaded)
 * - Mux gateway insufficient-balance quota error (merged from MuxGatewayQuota)
 */
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
                createUserMessage("msg-1", "Why did my request fail?", {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 100000,
                })
              );
              callback({ type: "caught-up" });

              // Generic rate-limit error (former StreamError)
              callback({
                type: "stream-error",
                messageId: "error-msg",
                error: "Rate limit exceeded. Please wait before making more requests.",
                errorType: "rate_limit",
              });

              // Anthropic overloaded / HTTP 529 (former AnthropicOverloaded)
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

              // Mux gateway insufficient balance / quota (former MuxGatewayQuota)
              callback({
                type: "stream-start",
                workspaceId,
                messageId: "assistant-2",
                model: "mux-gateway:anthropic/claude-sonnet-4",
                routedThroughGateway: true,
                historySequence: 3,
                startTime: STABLE_TIMESTAMP - 80000,
                mode: "exec",
              });
              callback({
                type: "stream-error",
                messageId: "assistant-2",
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
