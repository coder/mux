/**
 * Mock factory for full-app Storybook stories.
 *
 * Design philosophy:
 * - All visual states should be tested in context (full app), never in isolation
 * - Factory provides composable building blocks for different scenarios
 * - Keep mocks minimal but sufficient to exercise all visual paths
 */

import type { ProjectConfig } from "@/node/config";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { IPCApi, WorkspaceChatMessage } from "@/common/types/ipc";
import type { ChatStats } from "@/common/types/chatStats";
import type {
  MuxMessage,
  MuxTextPart,
  MuxReasoningPart,
  MuxImagePart,
  MuxToolPart,
} from "@/common/types/message";

/** Part type for message construction */
type MuxPart = MuxTextPart | MuxReasoningPart | MuxImagePart | MuxToolPart;
import type { RuntimeConfig } from "@/common/types/runtime";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

// ═══════════════════════════════════════════════════════════════════════════════
// STABLE TIMESTAMPS
// ═══════════════════════════════════════════════════════════════════════════════

/** Fixed timestamp for deterministic visual tests (Nov 14, 2023) */
export const NOW = 1700000000000;
/** Timestamp for messages - 1 minute ago from NOW */
export const STABLE_TIMESTAMP = NOW - 60000;

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export interface WorkspaceFixture {
  id: string;
  name: string;
  projectPath: string;
  projectName: string;
  runtimeConfig?: RuntimeConfig;
  createdAt?: string;
}

/** Create a workspace with sensible defaults */
export function createWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string }
): FrontendWorkspaceMetadata {
  const projectPath = opts.projectPath ?? `/home/user/projects/${opts.projectName}`;
  const safeName = opts.name.replace(/\//g, "-");
  return {
    id: opts.id,
    name: opts.name,
    projectPath,
    projectName: opts.projectName,
    namedWorkspacePath: `/home/user/.mux/src/${opts.projectName}/${safeName}`,
    runtimeConfig: opts.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG,
    createdAt: opts.createdAt,
  };
}

/** Create SSH workspace */
export function createSSHWorkspace(
  opts: Partial<WorkspaceFixture> & { id: string; name: string; projectName: string; host: string }
): FrontendWorkspaceMetadata {
  return createWorkspace({
    ...opts,
    runtimeConfig: {
      type: "ssh",
      host: opts.host,
      srcBaseDir: "/home/user/.mux/src",
    },
  });
}

/** Create workspace with incompatible runtime (for downgrade testing) */
export function createIncompatibleWorkspace(
  opts: Partial<WorkspaceFixture> & {
    id: string;
    name: string;
    projectName: string;
    incompatibleReason?: string;
  }
): FrontendWorkspaceMetadata {
  return {
    ...createWorkspace(opts),
    incompatibleRuntime:
      opts.incompatibleReason ??
      "This workspace was created with a newer version of mux.\nPlease upgrade mux to use this workspace.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROJECT FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProjectFixture {
  path: string;
  workspaces: FrontendWorkspaceMetadata[];
}

/** Create project config from workspaces */
export function createProjectConfig(workspaces: FrontendWorkspaceMetadata[]): ProjectConfig {
  return {
    workspaces: workspaces.map((ws) => ({
      path: ws.namedWorkspacePath,
      id: ws.id,
      name: ws.name,
    })),
  };
}

/** Group workspaces into projects Map */
export function groupWorkspacesByProject(
  workspaces: FrontendWorkspaceMetadata[]
): Map<string, ProjectConfig> {
  const projects = new Map<string, ProjectConfig>();
  const byProject = new Map<string, FrontendWorkspaceMetadata[]>();

  for (const ws of workspaces) {
    const existing = byProject.get(ws.projectPath) ?? [];
    existing.push(ws);
    byProject.set(ws.projectPath, existing);
  }

  for (const [path, wsList] of byProject) {
    projects.set(path, createProjectConfig(wsList));
  }

  return projects;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGE FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createUserMessage(
  id: string,
  text: string,
  opts: { historySequence: number; timestamp?: number; images?: string[] }
): MuxMessage {
  const parts: MuxPart[] = [{ type: "text", text }];
  if (opts.images) {
    for (const url of opts.images) {
      parts.push({ type: "file", mediaType: "image/png", url });
    }
  }
  return {
    id,
    role: "user",
    parts,
    metadata: {
      historySequence: opts.historySequence,
      timestamp: opts.timestamp ?? STABLE_TIMESTAMP,
    },
  };
}

export function createAssistantMessage(
  id: string,
  text: string,
  opts: {
    historySequence: number;
    timestamp?: number;
    model?: string;
    reasoning?: string;
    toolCalls?: MuxPart[];
  }
): MuxMessage {
  const parts: MuxPart[] = [];
  if (opts.reasoning) {
    parts.push({ type: "reasoning", text: opts.reasoning });
  }
  parts.push({ type: "text", text });
  if (opts.toolCalls) {
    parts.push(...opts.toolCalls);
  }
  return {
    id,
    role: "assistant",
    parts,
    metadata: {
      historySequence: opts.historySequence,
      timestamp: opts.timestamp ?? STABLE_TIMESTAMP,
      model: opts.model ?? "anthropic:claude-sonnet-4-5",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      duration: 1000,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOOL CALL FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export function createFileReadTool(toolCallId: string, filePath: string, content: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "read_file",
    state: "output-available",
    input: { target_file: filePath },
    output: { success: true, content },
  };
}

export function createFileEditTool(toolCallId: string, filePath: string, diff: string): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "file_edit_replace_string",
    state: "output-available",
    input: { file_path: filePath, old_string: "...", new_string: "..." },
    output: { success: true, diff, edits_applied: 1 },
  };
}

export function createTerminalTool(
  toolCallId: string,
  command: string,
  output: string,
  exitCode = 0
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "run_terminal_cmd",
    state: "output-available",
    input: { command, explanation: "Running command" },
    output: { success: exitCode === 0, stdout: output, exitCode },
  };
}

export function createStatusTool(
  toolCallId: string,
  emoji: string,
  message: string,
  url?: string
): MuxPart {
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName: "status_set",
    state: "output-available",
    input: { emoji, message, url },
    output: { success: true, emoji, message, url },
  };
}

export function createPendingTool(toolCallId: string, toolName: string, args: object): MuxPart {
  // Note: "input-available" is used for in-progress tool calls that haven't completed yet
  return {
    type: "dynamic-tool",
    toolCallId,
    toolName,
    state: "input-available",
    input: args,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS MOCKS
// ═══════════════════════════════════════════════════════════════════════════════

export interface GitStatusFixture {
  ahead?: number;
  behind?: number;
  dirty?: number;
  headCommit?: string;
  originCommit?: string;
}

export function createGitStatusOutput(fixture: GitStatusFixture): string {
  const { ahead = 0, behind = 0, dirty = 0 } = fixture;
  const headCommit = fixture.headCommit ?? "Latest commit";
  const originCommit = fixture.originCommit ?? "Latest commit";

  const lines = ["---PRIMARY---", "main", "---SHOW_BRANCH---"];
  lines.push(`! [HEAD] ${headCommit}`);
  lines.push(` ! [origin/main] ${originCommit}`);
  lines.push("--");

  // Ahead commits (local only)
  for (let i = 0; i < ahead; i++) {
    lines.push(`-  [${randomHash()}] Local commit ${i + 1}`);
  }
  // Behind commits (origin only)
  for (let i = 0; i < behind; i++) {
    lines.push(` + [${randomHash()}] Origin commit ${i + 1}`);
  }
  // Synced commit
  if (ahead === 0 && behind === 0) {
    lines.push(`++ [${randomHash()}] ${headCommit}`);
  }

  lines.push("---DIRTY---");
  lines.push(String(dirty));

  return lines.join("\n");
}

function randomHash(): string {
  return Math.random().toString(36).substring(2, 9);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOCK API FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

/** Chat handler type for onChat callbacks */
type ChatHandler = (callback: (event: WorkspaceChatMessage) => void) => () => void;

export interface MockAPIOptions {
  projects: Map<string, ProjectConfig>;
  workspaces: FrontendWorkspaceMetadata[];
  /** Chat handlers keyed by workspace ID */
  chatHandlers?: Map<string, ChatHandler>;
  /** Git status keyed by workspace ID */
  gitStatus?: Map<string, GitStatusFixture>;
  /** Provider config */
  providersConfig?: Record<string, { apiKeySet: boolean; baseUrl?: string; models?: string[] }>;
  /** Available providers list */
  providersList?: string[];
}

export function createMockAPI(options: MockAPIOptions): IPCApi {
  const {
    projects,
    workspaces,
    chatHandlers = new Map<string, ChatHandler>(),
    gitStatus = new Map<string, GitStatusFixture>(),
    providersConfig = {},
    providersList = [],
  } = options;

  const mockStats: ChatStats = {
    consumers: [],
    totalTokens: 0,
    model: "mock-model",
    tokenizerName: "mock-tokenizer",
    usageHistory: [],
  };

  return {
    tokenizer: {
      countTokens: () => Promise.resolve(42),
      countTokensBatch: (_model, texts) => Promise.resolve(texts.map(() => 42)),
      calculateStats: () => Promise.resolve(mockStats),
    },
    providers: {
      setProviderConfig: () => Promise.resolve({ success: true, data: undefined }),
      setModels: () => Promise.resolve({ success: true, data: undefined }),
      getConfig: () => Promise.resolve(providersConfig),
      list: () => Promise.resolve(providersList),
    },
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
      onChat: (wsId, callback) => {
        const handler = chatHandlers.get(wsId);
        if (handler) {
          return handler(callback);
        }
        // Default: send caught-up immediately
        setTimeout(() => callback({ type: "caught-up" }), 50);
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        return () => {};
      },
      onMetadata: () => () => undefined,
      sendMessage: () => Promise.resolve({ success: true, data: undefined }),
      resumeStream: () => Promise.resolve({ success: true, data: undefined }),
      interruptStream: () => Promise.resolve({ success: true, data: undefined }),
      clearQueue: () => Promise.resolve({ success: true, data: undefined }),
      truncateHistory: () => Promise.resolve({ success: true, data: undefined }),
      replaceChatHistory: () => Promise.resolve({ success: true, data: undefined }),
      getInfo: () => Promise.resolve(null),
      activity: {
        list: () => Promise.resolve({}),
        subscribe: () => () => undefined,
      },
      executeBash: (wsId: string, command: string) => {
        // Return mock git status if this looks like git status script
        if (command.includes("git status") || command.includes("git show-branch")) {
          const emptyStatus: GitStatusFixture = {};
          const status = gitStatus.get(wsId) ?? emptyStatus;
          const output = createGitStatusOutput(status);
          return Promise.resolve({
            success: true,
            data: { success: true, output, exitCode: 0, wall_duration_ms: 50 },
          });
        }
        return Promise.resolve({
          success: true,
          data: { success: true, output: "", exitCode: 0, wall_duration_ms: 0 },
        });
      },
    },
    projects: {
      list: () => Promise.resolve(Array.from(projects.entries())),
      create: () =>
        Promise.resolve({
          success: true,
          data: { projectConfig: { workspaces: [] }, normalizedPath: "/mock/project/path" },
        }),
      remove: () => Promise.resolve({ success: true, data: undefined }),
      pickDirectory: () => Promise.resolve(null),
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
    voice: {
      transcribe: () => Promise.resolve({ success: false, error: "Not implemented in mock" }),
    },
    update: {
      check: () => Promise.resolve(undefined),
      download: () => Promise.resolve(undefined),
      install: () => undefined,
      onStatus: () => () => undefined,
    },
  };
}

/** Install mock API on window */
export function installMockAPI(api: IPCApi): void {
  // @ts-expect-error - Assigning mock API to window for Storybook
  window.api = api;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT SCENARIO BUILDERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Creates a chat handler that sends messages then caught-up */
export function createStaticChatHandler(messages: MuxMessage[]): ChatHandler {
  return (callback) => {
    setTimeout(() => {
      for (const msg of messages) {
        callback(msg);
      }
      callback({ type: "caught-up" });
    }, 50);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  };
}

/** Creates a chat handler with streaming state */
export function createStreamingChatHandler(opts: {
  messages: MuxMessage[];
  streamingMessageId: string;
  model: string;
  historySequence: number;
  streamText?: string;
  pendingTool?: { toolCallId: string; toolName: string; args: object };
}): ChatHandler {
  return (callback) => {
    setTimeout(() => {
      // Send historical messages
      for (const msg of opts.messages) {
        callback(msg);
      }
      callback({ type: "caught-up" });

      // Start streaming
      callback({
        type: "stream-start",
        workspaceId: "mock",
        messageId: opts.streamingMessageId,
        model: opts.model,
        historySequence: opts.historySequence,
      });

      // Send text delta if provided
      if (opts.streamText) {
        callback({
          type: "stream-delta",
          workspaceId: "mock",
          messageId: opts.streamingMessageId,
          delta: opts.streamText,
          tokens: 10,
          timestamp: STABLE_TIMESTAMP,
        });
      }

      // Send tool call start if provided
      if (opts.pendingTool) {
        callback({
          type: "tool-call-start",
          workspaceId: "mock",
          messageId: opts.streamingMessageId,
          toolCallId: opts.pendingTool.toolCallId,
          toolName: opts.pendingTool.toolName,
          args: opts.pendingTool.args,
          tokens: 5,
          timestamp: STABLE_TIMESTAMP,
        });
      }
    }, 50);

    // Keep streaming state alive
    const intervalId = setInterval(() => {
      callback({
        type: "stream-delta",
        workspaceId: "mock",
        messageId: opts.streamingMessageId,
        delta: ".",
        tokens: 0,
        timestamp: NOW,
      });
    }, 2000);

    return () => clearInterval(intervalId);
  };
}
