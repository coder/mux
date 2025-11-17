import type { Meta, StoryObj } from "@storybook/react-vite";
import { useRef } from "react";
import { AppLoader } from "./components/AppLoader";
import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { IPCApi } from "@/common/types/ipc";
import type { ChatStats } from "@/common/types/chatStats";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

// Stable timestamp for testing active states (use fixed time minus small offsets)
// This ensures workspaces don't show as "Older than 1 day" and keeps stories deterministic
const NOW = 1700000000000; // Fixed timestamp: Nov 14, 2023
const STABLE_TIMESTAMP = NOW - 60000; // 1 minute ago

// Mock window.api for App component
function setupMockAPI(options: {
  projects?: Map<string, ProjectConfig>;
  workspaces?: FrontendWorkspaceMetadata[];
  selectedWorkspaceId?: string;
  apiOverrides?: Partial<IPCApi>;
}) {
  const mockProjects = options.projects ?? new Map();
  const mockWorkspaces = options.workspaces ?? [];
  const mockStats: ChatStats = {
    consumers: [],
    totalTokens: 0,
    model: "mock-model",
    tokenizerName: "mock-tokenizer",
    usageHistory: [],
  };

  const mockApi: IPCApi = {
    tokenizer: {
      countTokens: () => Promise.resolve(0),
      countTokensBatch: (_model, texts) => Promise.resolve(texts.map(() => 0)),
      calculateStats: () => Promise.resolve(mockStats),
    },
    providers: {
      setProviderConfig: () => Promise.resolve({ success: true, data: undefined }),
      list: () => Promise.resolve([]),
    },
    workspace: {
      create: (projectPath: string, branchName: string) =>
        Promise.resolve({
          success: true,
          metadata: {
            // Mock stable ID (production uses crypto.randomBytes(5).toString('hex'))
            id: Math.random().toString(36).substring(2, 12),
            name: branchName,
            projectPath,
            projectName: projectPath.split("/").pop() ?? "project",
            namedWorkspacePath: `/mock/workspace/${branchName}`,
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
          },
        }),
      list: () => Promise.resolve(mockWorkspaces),
      rename: (workspaceId: string) =>
        Promise.resolve({
          success: true,
          data: { newWorkspaceId: workspaceId },
        }),
      remove: () => Promise.resolve({ success: true }),
      fork: () => Promise.resolve({ success: false, error: "Not implemented in mock" }),
      openTerminal: () => Promise.resolve(undefined),
      onChat: () => () => undefined,
      onMetadata: () => () => undefined,
      sendMessage: () => Promise.resolve({ success: true, data: undefined }),
      resumeStream: () => Promise.resolve({ success: true, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true, data: undefined }),
      clearQueue: () => Promise.resolve({ success: true, data: undefined }),
      truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
      replaceChatHistory: () => Promise.resolve({ success: true, data: undefined }),
      getInfo: () => Promise.resolve(null),
      executeBash: () =>
        Promise.resolve({
          success: true,
          data: { success: true, output: "", exitCode: 0, wall_duration_ms: 0 },
        }),
    },
    projects: {
      list: () => Promise.resolve(Array.from(mockProjects.entries())),
      create: () =>
        Promise.resolve({
          success: true,
          data: { projectConfig: { workspaces: [] }, normalizedPath: "/mock/project/path" },
        }),
      remove: () => Promise.resolve({ success: true, data: undefined }),
      listBranches: () =>
        Promise.resolve({
          branches: ["main", "develop", "feature/new-feature"],
          recommendedTrunk: "main",
        }),
      secrets: {
        get: () => Promise.resolve([]),
        update: () => Promise.resolve({ success: true, data: undefined }),
      },
    },
    window: {
      setTitle: () => Promise.resolve(undefined),
    },
    terminal: {
      create: () =>
        Promise.resolve({
          sessionId: "mock-session",
          workspaceId: "mock-workspace",
          cols: 80,
          rows: 24,
        }),
      close: () => Promise.resolve(undefined),
      resize: () => Promise.resolve(undefined),
      sendInput: () => undefined,
      onOutput: () => () => undefined,
      onExit: () => () => undefined,
      openWindow: () => Promise.resolve(undefined),
      closeWindow: () => Promise.resolve(undefined),
    },
    update: {
      check: () => Promise.resolve(undefined),
      download: () => Promise.resolve(undefined),
      install: () => undefined,
      onStatus: () => () => undefined,
    },
    ...options.apiOverrides,
  };

  // @ts-expect-error - Assigning mock API to window for Storybook
  window.api = mockApi;
}

const meta = {
  title: "App/Full Application",
  component: AppLoader,
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
  },
  tags: ["autodocs"],
} satisfies Meta<typeof AppLoader>;

export default meta;
type Story = StoryObj<typeof meta>;

// Story wrapper that sets up mocks synchronously before rendering
const AppWithMocks: React.FC<{
  projects?: Map<string, ProjectConfig>;
  workspaces?: FrontendWorkspaceMetadata[];
  selectedWorkspaceId?: string;
}> = ({ projects, workspaces, selectedWorkspaceId }) => {
  // Set up mock API only once per component instance (not on every render)
  // Use useRef to ensure it runs synchronously before first render
  const initialized = useRef(false);
  if (!initialized.current) {
    setupMockAPI({ projects, workspaces, selectedWorkspaceId });
    initialized.current = true;
  }

  return <AppLoader />;
};

export const WelcomeScreen: Story = {
  render: () => <AppWithMocks projects={new Map()} workspaces={[]} />,
};

export const SingleProject: Story = {
  render: () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/home/user/projects/my-app",
        {
          workspaces: [
            { path: "/home/user/.mux/src/my-app/main", id: "a1b2c3d4e5", name: "main" },
            {
              path: "/home/user/.mux/src/my-app/feature-auth",
              id: "f6g7h8i9j0",
              name: "feature/auth",
            },
            {
              path: "/home/user/.mux/src/my-app/bugfix",
              id: "k1l2m3n4o5",
              name: "bugfix/memory-leak",
            },
          ],
        },
      ],
    ]);

    const workspaces: FrontendWorkspaceMetadata[] = [
      {
        id: "a1b2c3d4e5",
        name: "main",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/main",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
      {
        id: "f6g7h8i9j0",
        name: "feature/auth",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/feature-auth",
        runtimeConfig: {
          type: "ssh",
          host: "dev-server.example.com",
          srcBaseDir: "/home/user/.mux/src",
        },
      },
      {
        id: "my-app-bugfix",
        name: "bugfix/memory-leak",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/bugfix",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
    ];

    return <AppWithMocks projects={projects} workspaces={workspaces} />;
  },
};

export const MultipleProjects: Story = {
  render: () => {
    // Note: Workspace IDs are fixtures using hex-like format (production uses random 10-hex chars)
    const projects = new Map<string, ProjectConfig>([
      [
        "/home/user/projects/frontend",
        {
          workspaces: [
            { path: "/home/user/.mux/src/frontend/main", id: "1a2b3c4d5e", name: "main" },
            {
              path: "/home/user/.mux/src/frontend/redesign",
              id: "2b3c4d5e6f",
              name: "redesign",
            },
          ],
        },
      ],
      [
        "/home/user/projects/backend",
        {
          workspaces: [
            { path: "/home/user/.mux/src/backend/main", id: "3c4d5e6f7a", name: "main" },
            { path: "/home/user/.mux/src/backend/api-v2", id: "4d5e6f7a8b", name: "api-v2" },
            {
              path: "/home/user/.mux/src/backend/db-migration",
              id: "5e6f7a8b9c",
              name: "db-migration",
            },
          ],
        },
      ],
      [
        "/home/user/projects/mobile",
        {
          workspaces: [{ path: "/home/user/.mux/src/mobile/main", id: "6f7a8b9c0d", name: "main" }],
        },
      ],
    ]);

    const workspaces: FrontendWorkspaceMetadata[] = [
      {
        id: "1a2b3c4d5e",
        name: "main",
        projectPath: "/home/user/projects/frontend",
        projectName: "frontend",
        namedWorkspacePath: "/home/user/.mux/src/frontend/main",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
      {
        id: "2b3c4d5e6f",
        name: "redesign",
        projectPath: "/home/user/projects/frontend",
        projectName: "frontend",
        namedWorkspacePath: "/home/user/.mux/src/frontend/redesign",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
      {
        id: "3c4d5e6f7a",
        name: "main",
        projectPath: "/home/user/projects/backend",
        projectName: "backend",
        namedWorkspacePath: "/home/user/.mux/src/backend/main",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
      {
        id: "4d5e6f7a8b",
        name: "api-v2",
        projectPath: "/home/user/projects/backend",
        projectName: "backend",
        namedWorkspacePath: "/home/user/.mux/src/backend/api-v2",
        runtimeConfig: {
          type: "ssh",
          host: "prod-server.example.com",
          srcBaseDir: "/home/user/.mux/src",
        },
      },
      {
        id: "5e6f7a8b9c",
        name: "db-migration",
        projectPath: "/home/user/projects/backend",
        projectName: "backend",
        namedWorkspacePath: "/home/user/.mux/src/backend/db-migration",
        runtimeConfig: {
          type: "ssh",
          host: "staging.example.com",
          srcBaseDir: "/home/user/.mux/src",
        },
      },
      {
        id: "6f7a8b9c0d",
        name: "main",
        projectPath: "/home/user/projects/mobile",
        projectName: "mobile",
        namedWorkspacePath: "/home/user/.mux/src/mobile/main",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
      },
    ];

    return <AppWithMocks projects={projects} workspaces={workspaces} />;
  },
};

export const ManyWorkspaces: Story = {
  render: () => {
    const workspaceNames = [
      "main",
      "develop",
      "staging",
      "feature/authentication",
      "feature/dashboard",
      "feature/notifications",
      "feature/search",
      "bugfix/memory-leak",
      "bugfix/login-redirect",
      "refactor/components",
      "experiment/new-ui",
      "release/v1.2.0",
    ];

    const projects = new Map<string, ProjectConfig>([
      [
        "/home/user/projects/big-app",
        {
          workspaces: workspaceNames.map((name) => ({
            path: `/home/user/.mux/src/big-app/${name}`,
            id: `big-app-${name}`,
            name,
          })),
        },
      ],
    ]);

    const workspaces: FrontendWorkspaceMetadata[] = workspaceNames.map((name) => ({
      id: `big-app-${name}`,
      name,
      projectPath: "/home/user/projects/big-app",
      projectName: "big-app",
      namedWorkspacePath: `/home/user/.mux/src/big-app/${name}`,
      runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    }));

    return <AppWithMocks projects={projects} workspaces={workspaces} />;
  },
};

/**
 * Story demonstrating all possible UI indicators in the project sidebar.
 *
 * This story showcases:
 *
 * **Active Workspace (feature/auth)**
 * - Chat history with various message types
 * - Agent status indicator (🚀 emoji with PR link)
 * - Git status: dirty (uncommitted changes) + ahead/behind
 * - All tool types: read_file, search_replace, run_terminal_cmd, status_set
 * - Reasoning blocks (thinking)
 * - Local runtime
 *
 * **Streaming Workspace (feature/streaming)** ⚡
 * - **ACTIVELY WORKING** - shows the streaming/working state
 * - Incomplete assistant message with tool call in progress
 * - Model indicator showing current model
 * - Git status: dirty (1 uncommitted file)
 * - Use this to see what an active workspace looks like!
 *
 * **Other Workspaces (Git Status Variations)**
 * - **main**: Clean (no git indicators)
 * - **feature/new-ui**: Ahead of origin
 * - **feature/api**: Behind origin
 * - **bugfix/crash**: Dirty (uncommitted changes)
 * - **refactor/db**: Diverged (ahead + behind + dirty)
 * - **deploy/prod**: SSH runtime + git status
 *
 * **UI Indicators Shown**
 * - GitStatusIndicator: ↑ ahead, ↓ behind, * dirty
 * - AgentStatusIndicator: streaming, unread, agent status emoji
 * - RuntimeBadge: SSH vs local
 * - Active workspace highlight
 *
 * Use this story to test sidebar redesigns and ensure all data is visible.
 */
export const ActiveWorkspaceWithChat: Story = {
  render: () => {
    const workspaceId = "demo-workspace";

    // Create multiple workspaces showcasing all UI variations
    const streamingWorkspaceId = "ws-streaming";
    const projects = new Map<string, ProjectConfig>([
      [
        "/home/user/projects/my-app",
        {
          workspaces: [
            { path: "/home/user/.mux/src/my-app/feature", id: workspaceId, name: "feature/auth" },
            {
              path: "/home/user/.mux/src/my-app/streaming",
              id: streamingWorkspaceId,
              name: "feature/streaming",
            },
            { path: "/home/user/.mux/src/my-app/main", id: "ws-clean", name: "main" },
            { path: "/home/user/.mux/src/my-app/ahead", id: "ws-ahead", name: "feature/new-ui" },
            { path: "/home/user/.mux/src/my-app/behind", id: "ws-behind", name: "feature/api" },
            { path: "/home/user/.mux/src/my-app/dirty", id: "ws-dirty", name: "bugfix/crash" },
            {
              path: "/home/user/.mux/src/my-app/diverged",
              id: "ws-diverged",
              name: "refactor/db",
            },
            { path: "/home/user/.mux/src/my-app/ssh-remote", id: "ws-ssh", name: "deploy/prod" },
          ],
        },
      ],
      [
        "/home/user/projects/another-app",
        {
          workspaces: [],
        },
      ],
    ]);

    const workspaces: FrontendWorkspaceMetadata[] = [
      // Active workspace with chat, streaming, and agent status
      {
        id: workspaceId,
        name: "feature/auth",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/feature",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        createdAt: new Date(NOW - 7200000).toISOString(), // 2 hours ago
      },
      // Workspace actively streaming (working state)
      {
        id: streamingWorkspaceId,
        name: "feature/streaming",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/streaming",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        createdAt: new Date(NOW - 3600000).toISOString(), // 1 hour ago
      },
      // Clean workspace (no git indicators)
      {
        id: "ws-clean",
        name: "main",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/main",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        createdAt: new Date(NOW - 10800000).toISOString(), // 3 hours ago
      },
      // Ahead of origin
      {
        id: "ws-ahead",
        name: "feature/new-ui",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/ahead",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        createdAt: new Date(NOW - 14400000).toISOString(), // 4 hours ago
      },
      // Behind origin
      {
        id: "ws-behind",
        name: "feature/api",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/behind",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        createdAt: new Date(NOW - 18000000).toISOString(), // 5 hours ago
      },
      // Dirty (uncommitted changes)
      {
        id: "ws-dirty",
        name: "bugfix/crash",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/dirty",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        createdAt: new Date(NOW - 21600000).toISOString(), // 6 hours ago
      },
      // Diverged (ahead + behind + dirty)
      {
        id: "ws-diverged",
        name: "refactor/db",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/diverged",
        runtimeConfig: DEFAULT_RUNTIME_CONFIG,
        createdAt: new Date(NOW - 25200000).toISOString(), // 7 hours ago
      },
      // SSH workspace
      {
        id: "ws-ssh",
        name: "deploy/prod",
        projectPath: "/home/user/projects/my-app",
        projectName: "my-app",
        namedWorkspacePath: "/home/user/.mux/src/my-app/ssh-remote",
        runtimeConfig: {
          type: "ssh",
          host: "prod.example.com",
          srcBaseDir: "/home/deploy/.mux/src",
        },
        createdAt: new Date(NOW - 28800000).toISOString(), // 8 hours ago
      },
    ];

    const AppWithChatMocks: React.FC = () => {
      // Set up mock API only once per component instance (not on every render)
      const initialized = useRef(false);
      if (!initialized.current) {
        setupMockAPI({
          projects,
          workspaces,
          apiOverrides: {
            providers: {
              setProviderConfig: () => Promise.resolve({ success: true, data: undefined }),
              list: () => Promise.resolve(["anthropic", "openai"]),
            },
            workspace: {
              create: (projectPath: string, branchName: string) =>
                Promise.resolve({
                  success: true,
                  metadata: {
                    // Mock stable ID (production uses crypto.randomBytes(5).toString('hex'))
                    id: Math.random().toString(36).substring(2, 12),
                    name: branchName,
                    projectPath,
                    projectName: projectPath.split("/").pop() ?? "project",
                    namedWorkspacePath: `/mock/workspace/${branchName}`,
                    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
                  },
                }),
              list: () => Promise.resolve(workspaces),
              rename: (workspaceId: string) =>
                Promise.resolve({
                  success: true,
                  data: { newWorkspaceId: workspaceId },
                }),
              remove: () => Promise.resolve({ success: true }),
              fork: () => Promise.resolve({ success: false, error: "Not implemented in mock" }),
              openTerminal: () => Promise.resolve(undefined),
              onChat: (wsId, callback) => {
                // Active workspace with complete chat history
                if (wsId === workspaceId) {
                  setTimeout(() => {
                    // User message
                    callback({
                      id: "msg-1",
                      role: "user",
                      parts: [
                        { type: "text", text: "Add authentication to the user API endpoint" },
                      ],
                      metadata: {
                        historySequence: 1,
                        timestamp: STABLE_TIMESTAMP - 300000,
                      },
                    });

                    // Assistant message with tool calls
                    callback({
                      id: "msg-2",
                      role: "assistant",
                      parts: [
                        {
                          type: "text",
                          text: "I'll help you add authentication to the user API endpoint. Let me first check the current implementation.",
                        },
                        {
                          type: "dynamic-tool",
                          toolCallId: "call-1",
                          toolName: "read_file",
                          state: "output-available",
                          input: { target_file: "src/api/users.ts" },
                          output: {
                            success: true,
                            content:
                              "export function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}",
                          },
                        },
                      ],
                      metadata: {
                        historySequence: 2,
                        timestamp: STABLE_TIMESTAMP - 290000,
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 1250,
                          outputTokens: 450,
                          totalTokens: 1700,
                        },
                        duration: 3500,
                      },
                    });

                    // User response
                    callback({
                      id: "msg-3",
                      role: "user",
                      parts: [{ type: "text", text: "Yes, add JWT token validation" }],
                      metadata: {
                        historySequence: 3,
                        timestamp: STABLE_TIMESTAMP - 280000,
                      },
                    });

                    // Assistant message with file edit (large diff)
                    callback({
                      id: "msg-4",
                      role: "assistant",
                      parts: [
                        {
                          type: "text",
                          text: "I'll add JWT token validation to the endpoint. Let me update the file with proper authentication middleware and error handling.",
                        },
                        {
                          type: "dynamic-tool",
                          toolCallId: "call-2",
                          toolName: "file_edit_replace_string",
                          state: "output-available",
                          input: {
                            file_path: "src/api/users.ts",
                            old_string:
                              "import express from 'express';\nimport { db } from '../db';\n\nexport function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}",
                            new_string:
                              "import express from 'express';\nimport { db } from '../db';\nimport { verifyToken } from '../auth/jwt';\nimport { logger } from '../utils/logger';\n\nexport async function getUser(req, res) {\n  try {\n    const token = req.headers.authorization?.split(' ')[1];\n    if (!token) {\n      logger.warn('Missing authorization token');\n      return res.status(401).json({ error: 'Unauthorized' });\n    }\n    const decoded = await verifyToken(token);\n    const user = await db.users.find(req.params.id);\n    res.json(user);\n  } catch (err) {\n    logger.error('Auth error:', err);\n    return res.status(401).json({ error: 'Invalid token' });\n  }\n}",
                          },
                          output: {
                            success: true,
                            diff: [
                              "--- src/api/users.ts",
                              "+++ src/api/users.ts",
                              "@@ -2,0 +3,2 @@",
                              "+import { verifyToken } from '../auth/jwt';",
                              "+import { logger } from '../utils/logger';",
                              "@@ -4,28 +6,14 @@",
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
                              "-  // FIXME: No input validation",
                              "-  // FIXME: Direct database access without repository pattern",
                              "-  // FIXME: No logging",
                              "-",
                              "-  const user = db.users.find(req.params.id);",
                              "-",
                              "-  // TODO: Check if user exists",
                              "-  // TODO: Filter sensitive fields (password hash, etc)",
                              "-  // TODO: Check permissions - user should only access their own data",
                              "-",
                              "-  res.json(user);",
                              "+export async function getUser(req, res) {",
                              "+  try {",
                              "+    const token = req.headers.authorization?.split(' ')[1];",
                              "+    if (!token) {",
                              "+      logger.warn('Missing authorization token');",
                              "+      return res.status(401).json({ error: 'Unauthorized' });",
                              "+    }",
                              "+    const decoded = await verifyToken(token);",
                              "+    const user = await db.users.find(req.params.id);",
                              "+    res.json(user);",
                              "+  } catch (err) {",
                              "+    logger.error('Auth error:', err);",
                              "+    return res.status(401).json({ error: 'Invalid token' });",
                              "+  }",
                              "@@ -34,3 +22,2 @@",
                              "-// TODO: Add updateUser function",
                              "-// TODO: Add deleteUser function",
                              "-// TODO: Add listUsers function with pagination",
                              "+// Note: updateUser, deleteUser, and listUsers endpoints will be added in separate PR",
                              "+// to keep changes focused and reviewable",
                              "@@ -41,0 +29,11 @@",
                              "+",
                              "+export async function rotateApiKey(req, res) {",
                              "+  const admin = await db.admins.find(req.user.id);",
                              "+  if (!admin) {",
                              "+    return res.status(403).json({ error: 'Forbidden' });",
                              "+  }",
                              "+",
                              "+  const apiKey = await db.tokens.rotate(admin.orgId);",
                              "+  logger.info('Rotated API key', { orgId: admin.orgId });",
                              "+  res.json({ apiKey });",
                              "+}",
                            ].join("\n"),
                            edits_applied: 1,
                          },
                        },
                      ],
                      metadata: {
                        historySequence: 4,
                        timestamp: STABLE_TIMESTAMP - 270000,
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 2100,
                          outputTokens: 680,
                          totalTokens: 2780,
                        },
                        duration: 4200,
                      },
                    });

                    // Assistant with code block example
                    callback({
                      id: "msg-5",
                      role: "assistant",
                      parts: [
                        {
                          type: "text",
                          text: "Perfect! I've added JWT authentication. Here's what the updated endpoint looks like:\n\n```typescript\nimport { verifyToken } from '../auth/jwt';\n\nexport function getUser(req, res) {\n  const token = req.headers.authorization?.split(' ')[1];\n  if (!token || !verifyToken(token)) {\n    return res.status(401).json({ error: 'Unauthorized' });\n  }\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}\n```\n\nThe endpoint now requires a valid JWT token in the Authorization header. Let me run the tests to verify everything works.",
                        },
                      ],
                      metadata: {
                        historySequence: 5,
                        timestamp: STABLE_TIMESTAMP - 260000,
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 1800,
                          outputTokens: 520,
                          totalTokens: 2320,
                        },
                        duration: 3200,
                      },
                    });

                    // User asking to run tests
                    callback({
                      id: "msg-6",
                      role: "user",
                      parts: [
                        { type: "text", text: "Can you run the tests to make sure it works?" },
                      ],
                      metadata: {
                        historySequence: 6,
                        timestamp: STABLE_TIMESTAMP - 240000,
                      },
                    });

                    // Assistant running tests
                    callback({
                      id: "msg-7",
                      role: "assistant",
                      parts: [
                        {
                          type: "text",
                          text: "I'll run the tests to verify the authentication is working correctly.",
                        },
                        {
                          type: "dynamic-tool",
                          toolCallId: "call-3",
                          toolName: "run_terminal_cmd",
                          state: "output-available",
                          input: {
                            command: "npm test src/api/users.test.ts",
                            explanation: "Running tests for the users API endpoint",
                          },
                          output: {
                            success: true,
                            stdout:
                              "PASS src/api/users.test.ts\n  ✓ should return user when authenticated (24ms)\n  ✓ should return 401 when no token (18ms)\n  ✓ should return 401 when invalid token (15ms)\n\nTest Suites: 1 passed, 1 total\nTests:       3 passed, 3 total",
                            exitCode: 0,
                          },
                        },
                      ],
                      metadata: {
                        historySequence: 7,
                        timestamp: STABLE_TIMESTAMP - 230000,
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 2800,
                          outputTokens: 420,
                          totalTokens: 3220,
                        },
                        duration: 5100,
                      },
                    });

                    // User follow-up about error handling
                    callback({
                      id: "msg-8",
                      role: "user",
                      parts: [
                        {
                          type: "text",
                          text: "Great! What about error handling if the JWT library throws?",
                        },
                      ],
                      metadata: {
                        historySequence: 8,
                        timestamp: STABLE_TIMESTAMP - 180000,
                      },
                    });

                    // Assistant response with thinking (reasoning)
                    callback({
                      id: "msg-9",
                      role: "assistant",
                      parts: [
                        {
                          type: "reasoning",
                          text: "The user is asking about error handling for JWT verification. The verifyToken function could throw if the token is malformed or if there's an issue with the secret. I should wrap it in a try-catch block and return a proper error response.",
                        },
                        {
                          type: "text",
                          text: "Good catch! We should add try-catch error handling around the JWT verification. Let me update that.",
                        },
                        {
                          type: "dynamic-tool",
                          toolCallId: "call-4",
                          toolName: "search_replace",
                          state: "output-available",
                          input: {
                            file_path: "src/api/users.ts",
                            old_string:
                              "  const token = req.headers.authorization?.split(' ')[1];\n  if (!token || !verifyToken(token)) {\n    return res.status(401).json({ error: 'Unauthorized' });\n  }",
                            new_string:
                              "  try {\n    const token = req.headers.authorization?.split(' ')[1];\n    if (!token || !verifyToken(token)) {\n      return res.status(401).json({ error: 'Unauthorized' });\n    }\n  } catch (err) {\n    console.error('Token verification failed:', err);\n    return res.status(401).json({ error: 'Invalid token' });\n  }",
                          },
                          output: {
                            success: true,
                            message: "File updated successfully",
                          },
                        },
                      ],
                      metadata: {
                        historySequence: 9,
                        timestamp: STABLE_TIMESTAMP - 170000,
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 3500,
                          outputTokens: 520,
                          totalTokens: 4020,
                          reasoningTokens: 150,
                        },
                        duration: 6200,
                      },
                    });

                    // Assistant quick update with a single-line reasoning trace to exercise inline display
                    callback({
                      id: "msg-9a",
                      role: "assistant",
                      parts: [
                        {
                          type: "reasoning",
                          text: "Cache is warm already; rerunning the full suite would be redundant.",
                        },
                        {
                          type: "text",
                          text: "Cache is warm from the last test run, so I'll shift focus to documentation next.",
                        },
                      ],
                      metadata: {
                        historySequence: 10,
                        timestamp: STABLE_TIMESTAMP - 165000,
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 1200,
                          outputTokens: 180,
                          totalTokens: 1380,
                          reasoningTokens: 20,
                        },
                        duration: 900,
                      },
                    });

                    // Assistant message with status_set tool to show agent status
                    callback({
                      id: "msg-10",
                      role: "assistant",
                      parts: [
                        {
                          type: "text",
                          text: "I've created PR #1234 with the authentication changes. The CI pipeline is running tests now.",
                        },
                        {
                          type: "dynamic-tool",
                          toolCallId: "call-5",
                          toolName: "status_set",
                          state: "output-available",
                          input: {
                            emoji: "🚀",
                            message: "PR #1234 waiting for CI",
                            url: "https://github.com/example/repo/pull/1234",
                          },
                          output: {
                            success: true,
                            emoji: "🚀",
                            message: "PR #1234 waiting for CI",
                            url: "https://github.com/example/repo/pull/1234",
                          },
                        },
                      ],
                      metadata: {
                        historySequence: 11,
                        timestamp: STABLE_TIMESTAMP - 160000,
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 800,
                          outputTokens: 150,
                          totalTokens: 950,
                        },
                        duration: 1200,
                      },
                    });

                    // User follow-up asking about documentation
                    callback({
                      id: "msg-11",
                      role: "user",
                      parts: [
                        {
                          type: "text",
                          text: "Should we add documentation for the authentication changes?",
                        },
                      ],
                      metadata: {
                        historySequence: 12,
                        timestamp: STABLE_TIMESTAMP - 150000,
                      },
                    });

                    // Mark as caught up
                    callback({ type: "caught-up" });

                    // Now start streaming assistant response with reasoning
                    callback({
                      type: "stream-start",
                      workspaceId: workspaceId,
                      messageId: "msg-12",
                      model: "anthropic:claude-sonnet-4-5",
                      historySequence: 13,
                    });

                    // Send reasoning delta
                    callback({
                      type: "reasoning-delta",
                      workspaceId: workspaceId,
                      messageId: "msg-12",
                      delta:
                        "The user is asking about documentation. This is important because the authentication changes introduce a breaking change for API clients. They'll need to know how to include JWT tokens in their requests. I should suggest adding both inline code comments and updating the API documentation to explain the new authentication requirements, including examples of how to obtain and use tokens.",
                      tokens: 65,
                      timestamp: STABLE_TIMESTAMP - 140000,
                    });
                  }, 100);

                  // Keep sending reasoning deltas to maintain streaming state
                  const intervalId = setInterval(() => {
                    callback({
                      type: "reasoning-delta",
                      workspaceId: workspaceId,
                      messageId: "msg-12",
                      delta: ".",
                      tokens: 1,
                      timestamp: NOW,
                    });
                  }, 2000);

                  return () => {
                    clearInterval(intervalId);
                  };
                } else if (wsId === streamingWorkspaceId) {
                  // Streaming workspace - show active work in progress
                  setTimeout(() => {
                    const now = NOW; // Use stable timestamp

                    // Previous completed message with status_set (MUST be sent BEFORE caught-up)
                    callback({
                      id: "stream-msg-0",
                      role: "assistant",
                      parts: [
                        {
                          type: "text",
                          text: "I'm working on the database refactoring.",
                        },
                        {
                          type: "dynamic-tool",
                          toolCallId: "status-call-0",
                          toolName: "status_set",
                          state: "output-available",
                          input: {
                            emoji: "⚙️",
                            message: "Refactoring in progress",
                          },
                          output: {
                            success: true,
                            emoji: "⚙️",
                            message: "Refactoring in progress",
                          },
                        },
                      ],
                      metadata: {
                        historySequence: 0,
                        timestamp: now - 5000, // 5 seconds ago
                        model: "anthropic:claude-sonnet-4-5",
                        usage: {
                          inputTokens: 200,
                          outputTokens: 50,
                          totalTokens: 250,
                        },
                        duration: 800,
                      },
                    });

                    // User message (recent)
                    callback({
                      id: "stream-msg-1",
                      role: "user",
                      parts: [
                        {
                          type: "text",
                          text: "Refactor the database connection to use connection pooling",
                        },
                      ],
                      metadata: {
                        historySequence: 1,
                        timestamp: now - 3000, // 3 seconds ago
                      },
                    });

                    // CRITICAL: Send caught-up AFTER historical messages so they get processed!
                    // Streaming state is maintained by continuous stream-delta events, not by withholding caught-up
                    callback({ type: "caught-up" });

                    // Now send stream events - they'll be processed immediately
                    // Stream start event (very recent - just started)
                    callback({
                      type: "stream-start",
                      workspaceId: streamingWorkspaceId,
                      messageId: "stream-msg-2",
                      model: "anthropic:claude-sonnet-4-5",
                      historySequence: 2,
                    });

                    // Stream delta event - shows text being typed out (just happened)
                    callback({
                      type: "stream-delta",
                      workspaceId: streamingWorkspaceId,
                      messageId: "stream-msg-2",
                      delta:
                        "I'll help you refactor the database connection to use connection pooling.",
                      tokens: 15,
                      timestamp: now - 1000, // 1 second ago
                    });

                    // Tool call start event - shows tool being invoked (happening now)
                    callback({
                      type: "tool-call-start",
                      workspaceId: streamingWorkspaceId,
                      messageId: "stream-msg-2",
                      toolCallId: "stream-call-1",
                      toolName: "read_file",
                      args: { target_file: "src/db/connection.ts" },
                      tokens: 8,
                      timestamp: now - 500, // 0.5 seconds ago
                    });
                  }, 100);

                  // Keep sending deltas to maintain streaming state
                  const intervalId = setInterval(() => {
                    callback({
                      type: "stream-delta",
                      workspaceId: streamingWorkspaceId,
                      messageId: "stream-msg-2",
                      delta: ".",
                      tokens: 1,
                      timestamp: NOW,
                    });
                  }, 2000);

                  // Return cleanup function that stops the interval
                  return () => clearInterval(intervalId);
                } else {
                  // Other workspaces - send caught-up immediately
                  setTimeout(() => {
                    callback({ type: "caught-up" });
                  }, 100);

                  return () => {
                    // Cleanup
                  };
                }
              },
              onMetadata: () => () => undefined,
              sendMessage: () => Promise.resolve({ success: true, data: undefined }),
              resumeStream: () => Promise.resolve({ success: true, data: undefined }),
              interruptStream: () => Promise.resolve({ success: true, data: undefined }),
              clearQueue: () => Promise.resolve({ success: true, data: undefined }),
              truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
              replaceChatHistory: () => Promise.resolve({ success: true, data: undefined }),
              getInfo: () => Promise.resolve(null),
              executeBash: (wsId: string, command: string) => {
                // Mock git status script responses for each workspace
                const gitStatusMocks: Record<string, string> = {
                  [workspaceId]: `---PRIMARY---
main
---SHOW_BRANCH---
! [HEAD] WIP: Add JWT authentication
 ! [origin/main] Update dependencies
--
-  [a1b2c3d] Add JWT authentication
-  [e4f5g6h] Update auth middleware
-  [i7j8k9l] Add tests
---DIRTY---
3`,
                  [streamingWorkspaceId]: `---PRIMARY---
main
---SHOW_BRANCH---
! [HEAD] Refactoring database connection
 ! [origin/main] Old implementation
--
-  [b2c3d4e] Refactor connection pool
-  [f5g6h7i] Add retry logic
---DIRTY---
1`,
                  "ws-clean": `---PRIMARY---
main
---SHOW_BRANCH---
! [HEAD] Latest commit
 ! [origin/main] Latest commit
--
++ [m1n2o3p] Latest commit
---DIRTY---
0`,
                  "ws-ahead": `---PRIMARY---
main
---SHOW_BRANCH---
! [HEAD] Add new dashboard design
 ! [origin/main] Old design
--
-  [c3d4e5f] Add new dashboard design
-  [g6h7i8j] Update styles
---DIRTY---
0`,
                  "ws-behind": `---PRIMARY---
main
---SHOW_BRANCH---
 ! [origin/main] Latest API changes
! [HEAD] Old API implementation
--
 + [d4e5f6g] Latest API changes
 + [h7i8j9k] Fix API bug
---DIRTY---
0`,
                  "ws-dirty": `---PRIMARY---
main
---SHOW_BRANCH---
! [HEAD] Fix null pointer
 ! [origin/main] Stable version
--
-  [e5f6g7h] Fix null pointer
---DIRTY---
7`,
                  "ws-diverged": `---PRIMARY---
main
---SHOW_BRANCH---
! [HEAD] Database migration
 ! [origin/main] Old schema
--
-  [f6g7h8i] Database migration
-  [i9j0k1l] Update models
 + [l2m3n4o] Hotfix on main
---DIRTY---
5`,
                  "ws-ssh": `---PRIMARY---
main
---SHOW_BRANCH---
! [HEAD] Production deployment
 ! [origin/main] Development version
--
-  [g7h8i9j] Production deployment
---DIRTY---
0`,
                };

                // Return mock git status if this is the git status script
                if (command.includes("git status") || command.includes("git show-branch")) {
                  const output = gitStatusMocks[wsId] || "";
                  return Promise.resolve({
                    success: true,
                    data: { success: true, output, exitCode: 0, wall_duration_ms: 50 },
                  });
                }

                // Default response for other commands
                return Promise.resolve({
                  success: true,
                  data: { success: true, output: "", exitCode: 0, wall_duration_ms: 0 },
                });
              },
            },
          },
        });

        // Set initial workspace selection
        localStorage.setItem(
          "selectedWorkspace",
          JSON.stringify({
            workspaceId: workspaceId,
            projectPath: "/home/user/projects/my-app",
            projectName: "my-app",
            namedWorkspacePath: "/home/user/.mux/src/my-app/feature",
          })
        );

        initialized.current = true;
      }

      return <AppLoader />;
    };

    return <AppWithChatMocks />;
  },
};

/**
 * Story demonstrating markdown table rendering
 * Shows various table formats without disruptive copy/download actions
 */
export const MarkdownTables: Story = {
  render: () => {
    const AppWithTableMocks = () => {
      const initialized = useRef(false);

      if (!initialized.current) {
        const workspaceId = "my-app-feature";

        const workspaces: FrontendWorkspaceMetadata[] = [
          {
            id: workspaceId,
            name: "feature",
            projectPath: "/home/user/projects/my-app",
            projectName: "my-app",
            namedWorkspacePath: "/home/user/.mux/src/my-app/feature",
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
          },
        ];

        setupMockAPI({
          projects: new Map([
            [
              "/home/user/projects/my-app",
              {
                workspaces: [
                  { path: "/home/user/.mux/src/my-app/feature", id: workspaceId, name: "feature" },
                ],
              },
            ],
          ]),
          workspaces,
          selectedWorkspaceId: workspaceId,
          apiOverrides: {
            workspace: {
              create: (projectPath: string, branchName: string) =>
                Promise.resolve({
                  success: true,
                  metadata: {
                    id: Math.random().toString(36).substring(2, 12),
                    name: branchName,
                    projectPath,
                    projectName: projectPath.split("/").pop() ?? "project",
                    namedWorkspacePath: `/mock/workspace/${branchName}`,
                    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
                  },
                }),
              list: () => Promise.resolve(workspaces),
              rename: (workspaceId: string) =>
                Promise.resolve({
                  success: true,
                  data: { newWorkspaceId: workspaceId },
                }),
              remove: () => Promise.resolve({ success: true }),
              fork: () => Promise.resolve({ success: false, error: "Not implemented in mock" }),
              openTerminal: () => Promise.resolve(undefined),
              onChat: (workspaceId, callback) => {
                setTimeout(() => {
                  // User message
                  callback({
                    id: "msg-1",
                    role: "user",
                    parts: [{ type: "text", text: "Show me some table examples" }],
                    metadata: {
                      historySequence: 1,
                      timestamp: STABLE_TIMESTAMP,
                    },
                  });

                  // Assistant message with tables
                  callback({
                    id: "msg-2",
                    role: "assistant",
                    parts: [
                      {
                        type: "text",
                        text: `Here are various markdown table examples:

## Simple Table

| Column 1 | Column 2 | Column 3 |
|----------|----------|----------|
| Value A  | Value B  | Value C  |
| Value D  | Value E  | Value F  |
| Value G  | Value H  | Value I  |

## Table with Different Alignments

| Left Aligned | Center Aligned | Right Aligned |
|:-------------|:--------------:|--------------:|
| Left         | Center         | Right         |
| Text         | Text           | Text          |
| More         | Data           | Here          |

## Code and Links in Tables

| Feature | Status | Notes |
|---------|--------|-------|
| \`markdown\` support | ✅ Done | Full GFM support |
| [Links](https://example.com) | ✅ Done | Opens externally |
| **Bold** and _italic_ | ✅ Done | Standard formatting |

## Large Table with Many Rows

| ID | Name | Email | Status | Role | Last Login |
|----|------|-------|--------|------|------------|
| 1 | Alice Smith | alice@example.com | Active | Admin | 2024-01-20 |
| 2 | Bob Jones | bob@example.com | Active | User | 2024-01-19 |
| 3 | Carol White | carol@example.com | Inactive | User | 2024-01-15 |
| 4 | David Brown | david@example.com | Active | Moderator | 2024-01-21 |
| 5 | Eve Wilson | eve@example.com | Active | User | 2024-01-18 |
| 6 | Frank Miller | frank@example.com | Pending | User | 2024-01-10 |
| 7 | Grace Lee | grace@example.com | Active | Admin | 2024-01-22 |
| 8 | Henry Davis | henry@example.com | Active | User | 2024-01-17 |

## Narrow Table

| #  | Item |
|----|------|
| 1  | First |
| 2  | Second |
| 3  | Third |

## Wide Table with Long Content

| Configuration Key | Default Value | Description | Environment Variable |
|-------------------|---------------|-------------|---------------------|
| \`api.timeout\` | 30000 | Request timeout in milliseconds | \`API_TIMEOUT\` |
| \`cache.enabled\` | true | Enable response caching | \`CACHE_ENABLED\` |
| \`logging.level\` | info | Log verbosity level (debug, info, warn, error) | \`LOG_LEVEL\` |
| \`server.port\` | 3000 | Port number for HTTP server | \`PORT\` |

These tables should render cleanly without any disruptive copy or download actions.`,
                      },
                    ],
                    metadata: {
                      historySequence: 2,
                      timestamp: STABLE_TIMESTAMP + 1000,
                      model: "anthropic:claude-sonnet-4-5",
                      usage: {
                        inputTokens: 100,
                        outputTokens: 500,
                        totalTokens: 600,
                      },
                      duration: 2000,
                    },
                  });

                  // Mark as caught up
                  callback({ type: "caught-up" });
                }, 100);

                return () => {
                  // Cleanup
                };
              },
              onMetadata: () => () => undefined,
              sendMessage: () => Promise.resolve({ success: true, data: undefined }),
              resumeStream: () => Promise.resolve({ success: true, data: undefined }),
              interruptStream: () => Promise.resolve({ success: true, data: undefined }),
              clearQueue: () => Promise.resolve({ success: true, data: undefined }),
              truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
              replaceChatHistory: () => Promise.resolve({ success: true, data: undefined }),
              getInfo: () => Promise.resolve(null),
              executeBash: () =>
                Promise.resolve({
                  success: true,
                  data: { success: true, output: "", exitCode: 0, wall_duration_ms: 0 },
                }),
            },
          },
        });

        // Set initial workspace selection
        localStorage.setItem(
          "selectedWorkspace",
          JSON.stringify({
            workspaceId: workspaceId,
            projectPath: "/home/user/projects/my-app",
            projectName: "my-app",
            namedWorkspacePath: "/home/user/.mux/src/my-app/feature",
          })
        );

        initialized.current = true;
      }

      return <AppLoader />;
    };

    return <AppWithTableMocks />;
  },
};
