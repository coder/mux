/**
 * Error states & edge cases stories
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import type { WorkspaceChatMessage, ChatMuxMessage } from "@/common/orpc/types";
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
import { selectWorkspace, setupSimpleChatStory, setupCustomChatStory } from "./storyHelpers";
import { createMockORPCClient } from "../../../.storybook/mocks/orpc";

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
// STORIES
// ═══════════════════════════════════════════════════════════════════════════════

/** Stream error message in chat */
export const StreamError: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupCustomChatStory({
          workspaceId: "ws-error",
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
        })
      }
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
