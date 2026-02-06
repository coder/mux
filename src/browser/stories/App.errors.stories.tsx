/**
 * Error states & edge cases stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import type { WorkspaceChatMessage, ChatMuxMessage } from "@/common/orpc/types";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import {
  STABLE_TIMESTAMP,
  createWorkspace,
  createIncompatibleWorkspace,
  groupWorkspacesByProject,
  createUserMessage,
  createAssistantMessage,
  createFileEditTool,
  createStaticChatHandler,
} from "./mockFactory";
import { disableAutoRetryPreference } from "@/browser/utils/messages/autoRetryPreference";
import {
  collapseRightSidebar,
  createOnChatAdapter,
  expandProjects,
  selectWorkspace,
  setupCustomChatStory,
  setupSimpleChatStory,
} from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { userEvent, waitFor } from "@storybook/test";

export default {
  ...appMeta,
  title: "App/Errors",
};

// ═══════════════════════════════════════════════════════════════════════════════
// LARGE DIFF FIXTURE
// ═══════════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════════
// DEBUG LLM REQUEST FIXTURE
// ═══════════════════════════════════════════════════════════════════════════════

const createDebugLlmRequestSnapshot = (workspaceId: string): DebugLlmRequestSnapshot => ({
  capturedAt: STABLE_TIMESTAMP - 45000,
  workspaceId,
  messageId: "assistant-debug-1",
  model: "anthropic:claude-3-5-sonnet-20241022",
  providerName: "anthropic",
  thinkingLevel: "medium",
  mode: "exec",
  agentId: "exec",
  maxOutputTokens: 2048,
  systemMessage:
    "You are Mux, a focused coding agent. Follow the user’s instructions and keep answers short.",
  messages: [
    {
      role: "user",
      content: "We hit a rate limit while refactoring. Summarize the plan and retry.",
    },
    {
      role: "assistant",
      content: "Here’s a concise summary and the next steps to resume safely.",
    },
    {
      role: "tool",
      name: "write_summary",
      content: "Summarized 3 tasks, trimmed history, and queued a retry.",
    },
  ],
  response: {
    capturedAt: STABLE_TIMESTAMP - 44000,
    metadata: {
      model: "anthropic:claude-3-5-sonnet-20241022",
      usage: {
        inputTokens: 123,
        outputTokens: 456,
        totalTokens: 579,
      },
      duration: 1234,
      systemMessageTokens: 42,
    },
    parts: [
      {
        type: "text",
        text: "Here’s a concise summary and the next steps to resume safely.",
        timestamp: STABLE_TIMESTAMP - 44000,
      },
      {
        type: "dynamic-tool",
        toolCallId: "tool-1",
        toolName: "write_summary",
        state: "output-available",
        input: { tasks: 3 },
        output: { ok: true },
        timestamp: STABLE_TIMESTAMP - 43950,
      },
    ],
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Stream error messages in chat */

/**
 * Context exceeded error should offer a best-effort compaction action in the
 * Stream interrupted banner when a larger-context known model is configured.
 */
export const ContextExceededSuggestion: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-context-exceeded";
        // Disable auto-retry to keep this story deterministic (no countdown timer)
        disableAutoRetryPreference(workspaceId);

        return setupCustomChatStory({
          workspaceId,
          providersConfig: {
            openai: { apiKeySet: true, isConfigured: true },
            xai: { apiKeySet: true, isConfigured: true },
          },
          chatHandler: (callback: (event: WorkspaceChatMessage) => void) => {
            setTimeout(() => {
              callback(
                createUserMessage("msg-1", "Can you help me with this huge codebase?", {
                  historySequence: 1,
                  timestamp: STABLE_TIMESTAMP - 100000,
                })
              );
              callback({ type: "caught-up" });

              // Simulate a stream start with a smaller-context model...
              callback({
                type: "stream-start",
                workspaceId,
                messageId: "assistant-1",
                model: "openai:gpt-5.2",
                historySequence: 2,
                startTime: STABLE_TIMESTAMP - 90000,
                mode: "exec",
              });

              // ...and then the stream failing with a context limit error.
              callback({
                type: "stream-error",
                messageId: "assistant-1",
                error:
                  "Context length exceeded: the conversation is too long to send to this model.",
                errorType: "context_exceeded",
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

export const DebugLlmRequestModal: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-debug-request";
        disableAutoRetryPreference(workspaceId);

        const workspaces = [
          createWorkspace({ id: workspaceId, name: "debug", projectName: "my-app" }),
        ];
        selectWorkspace(workspaces[0]);
        collapseRightSidebar();

        const chatHandlers = new Map([
          [
            workspaceId,
            (callback: (event: WorkspaceChatMessage) => void) => {
              setTimeout(() => {
                callback(
                  createUserMessage("msg-1", "Can you summarize what just happened?", {
                    historySequence: 1,
                    timestamp: STABLE_TIMESTAMP - 100000,
                  })
                );
                callback({ type: "caught-up" });
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
          ],
        ]);

        const lastLlmRequestSnapshots = new Map([
          [workspaceId, createDebugLlmRequestSnapshot(workspaceId)],
        ]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          lastLlmRequestSnapshots,
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitFor(() => {
      const debugButton = canvasElement.querySelector(
        'button[aria-label="Open last LLM request debug modal"]'
      );
      if (!debugButton) throw new Error("Debug button not found");
    });

    const debugButton = canvasElement.querySelector(
      'button[aria-label="Open last LLM request debug modal"]'
    );
    if (!debugButton) {
      throw new Error("Debug button not found");
    }
    await userEvent.click(debugButton);

    await waitFor(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog?.textContent?.includes("Last LLM request")) {
        throw new Error("Debug modal did not open");
      }
    });
  },
};
export const StreamError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-error";
        // Disable auto-retry to show deterministic "Retry" button instead of countdown timer
        disableAutoRetryPreference(workspaceId);

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
        const workspaceId = "ws-anthropic-overloaded";
        // Disable auto-retry to show deterministic "Retry" button instead of countdown timer
        disableAutoRetryPreference(workspaceId);

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

/** Chat with truncated/hidden history indicator */
export const HiddenHistory: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
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

/**
 * Incompatible workspace error view.
 *
 * When a user downgrades to an older version of mux that doesn't support
 * a workspace's runtime configuration, the workspace shows an error message
 * instead of crashing. This ensures graceful degradation.
 */
export const IncompatibleWorkspace: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-main", name: "main", projectName: "my-app" }),
          createIncompatibleWorkspace({
            id: "ws-incompatible",
            name: "incompatible",
            projectName: "my-app",
          }),
        ];

        // Select the incompatible workspace
        selectWorkspace(workspaces[1]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
        });
      }}
    />
  ),
};

/** Large file diff in chat */
export const LargeDiff: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
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
        })
      }
    />
  ),
};

/**
 * Project removal error popover.
 *
 * Shows the error popup when attempting to remove a project that has active workspaces.
 * The play function hovers the project and clicks the remove button to trigger the error.
 */
export const ProjectRemovalError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaces = [
          createWorkspace({ id: "ws-1", name: "main", projectName: "my-app" }),
          createWorkspace({ id: "ws-2", name: "feature/auth", projectName: "my-app" }),
        ];

        // Expand the project so workspaces are visible
        expandProjects(["/mock/my-app"]);

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onProjectRemove: () => ({
            success: false,
            error:
              "Cannot remove project with active workspaces. Please remove all 2 workspace(s) first.",
          }),
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // Wait for the remove button to exist in DOM
    await waitFor(() => {
      const removeButton = canvasElement.querySelector(
        'button[aria-label="Remove project my-app"]'
      );
      if (!removeButton) throw new Error("Remove button not found");
    });

    // Get the project row container and hover to reveal the button
    const removeButton = canvasElement.querySelector('button[aria-label="Remove project my-app"]')!;
    const projectRow = removeButton.closest("[data-project-path]")!;
    await userEvent.hover(projectRow);

    // Small delay for hover state to apply
    await new Promise((r) => setTimeout(r, 100));

    // Click the remove button
    await userEvent.click(removeButton);

    // Wait for the error popover to appear
    await waitFor(() => {
      const errorPopover = document.querySelector('[role="alert"]');
      if (!errorPopover) throw new Error("Error popover not found");
    });
  },
};
