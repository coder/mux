/**
 * Comprehensive demo story exercising all features
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  NOW,
  STABLE_TIMESTAMP,
  createWorkspace,
  createSSHWorkspace,
  groupWorkspacesByProject,
  createUserMessage,
  createAssistantMessage,
  createFileReadTool,
  createFileEditTool,
  createTerminalTool,
  createStatusTool,
  createStaticChatHandler,
  createStreamingChatHandler,
  type GitStatusFixture,
} from "./mockFactory";
import {
  createGitStatusExecutor,
  createOnChatAdapter,
  type ChatHandler,
  selectWorkspace,
  setWorkspaceInput,
  setWorkspaceModel,
} from "./storyHelpers";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
export default {
  ...appMeta,
  title: "App/Demo",
};

/**
 * Comprehensive story showing all sidebar indicators and chat features.
 *
 * This exercises:
 * - Multiple workspaces with varied git status
 * - SSH and local runtime badges
 * - Active workspace with full chat history
 * - Streaming workspace showing working state
 * - All tool types: read_file, file_edit, terminal, status_set
 * - Reasoning blocks
 * - Agent status indicator
 */
export const Comprehensive: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const activeWorkspaceId = "ws-active";
        const streamingWorkspaceId = "ws-streaming";

        const workspaces = [
          createWorkspace({
            id: activeWorkspaceId,
            name: "feature/auth",
            projectName: "my-app",
            createdAt: new Date(NOW - 7200000).toISOString(),
          }),
          createWorkspace({
            id: streamingWorkspaceId,
            name: "feature/streaming",
            projectName: "my-app",
            createdAt: new Date(NOW - 3600000).toISOString(),
          }),
          createWorkspace({
            id: "ws-clean",
            name: "main",
            projectName: "my-app",
            createdAt: new Date(NOW - 10800000).toISOString(),
          }),
          createWorkspace({
            id: "ws-ahead",
            name: "feature/new-ui",
            projectName: "my-app",
            createdAt: new Date(NOW - 14400000).toISOString(),
          }),
          createSSHWorkspace({
            id: "ws-ssh",
            name: "deploy/prod",
            projectName: "my-app",
            host: "prod.example.com",
            createdAt: new Date(NOW - 18000000).toISOString(),
          }),
          // Empty project to show that state
          createWorkspace({ id: "ws-other", name: "main", projectName: "another-app" }),
        ];

        // Active workspace chat with full conversation
        const activeMessages = [
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
          createAssistantMessage("msg-4", "I'll add JWT validation with proper error handling.", {
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
                  "+  try {",
                  "+    const token = req.headers.authorization?.split(' ')[1];",
                  "+    if (!token || !verifyToken(token)) {",
                  "+      return res.status(401).json({ error: 'Unauthorized' });",
                  "+    }",
                  "   const user = db.users.find(req.params.id);",
                  "   res.json(user);",
                  "+  } catch (err) {",
                  "+    return res.status(401).json({ error: 'Invalid token' });",
                  "+  }",
                  " }",
                ].join("\n")
              ),
            ],
          }),
          createUserMessage("msg-5", "Run the tests", {
            historySequence: 5,
            timestamp: STABLE_TIMESTAMP - 240000,
          }),
          createAssistantMessage("msg-6", "Running the test suite:", {
            historySequence: 6,
            timestamp: STABLE_TIMESTAMP - 230000,
            toolCalls: [
              createTerminalTool(
                "call-3",
                "npm test",
                [
                  "PASS src/api/users.test.ts",
                  "  ✓ should return user when authenticated (24ms)",
                  "  ✓ should return 401 when no token (18ms)",
                  "",
                  "Test Suites: 1 passed, 1 total",
                  "Tests:       2 passed, 2 total",
                ].join("\n")
              ),
            ],
          }),
          createAssistantMessage("msg-7", "Tests pass! I've created a PR.", {
            historySequence: 7,
            timestamp: STABLE_TIMESTAMP - 200000,
            reasoning: "All tests pass. Time to create a PR for review.",
            toolCalls: [
              createStatusTool(
                "call-4",
                "🚀",
                "PR #1234 waiting for CI",
                "https://github.com/example/repo/pull/1234"
              ),
            ],
          }),
        ];

        // Streaming workspace messages
        const streamingMessages = [
          createUserMessage("msg-s1", "Refactor the database connection", {
            historySequence: 1,
            timestamp: NOW - 3000,
          }),
        ];

        const chatHandlers = new Map<string, ChatHandler>([
          [activeWorkspaceId, createStaticChatHandler(activeMessages)],
          [
            streamingWorkspaceId,
            createStreamingChatHandler({
              messages: streamingMessages,
              streamingMessageId: "msg-s2",
              model: "anthropic:claude-sonnet-4-5",
              historySequence: 2,
              streamText: "I'll help you refactor the database connection to use pooling.",
              pendingTool: {
                toolCallId: "call-s1",
                toolName: "file_read",
                args: { file_path: "src/db/connection.ts" },
              },
            }),
          ],
        ]);

        const gitStatus = new Map<string, GitStatusFixture>([
          [activeWorkspaceId, { ahead: 3, dirty: 3, headCommit: "WIP: Add JWT auth" }],
          [streamingWorkspaceId, { ahead: 2, dirty: 1, headCommit: "Refactoring db" }],
          ["ws-clean", {}],
          ["ws-ahead", { ahead: 2, headCommit: "New dashboard design" }],
          ["ws-ssh", { ahead: 1, headCommit: "Production deploy" }],
        ]);

        selectWorkspace(workspaces[0]);
        setWorkspaceInput(activeWorkspaceId, "Add OAuth2 support with Google and GitHub");
        setWorkspaceModel(activeWorkspaceId, "anthropic:claude-sonnet-4-5");

        return createMockORPCClient({
          projects: groupWorkspacesByProject(workspaces),
          workspaces,
          onChat: createOnChatAdapter(chatHandlers),
          executeBash: createGitStatusExecutor(gitStatus),
          providersList: ["anthropic", "openai", "xai"],
        });
      }}
    />
  ),
};
