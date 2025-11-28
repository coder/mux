/**
 * Shared story setup helpers to reduce boilerplate.
 *
 * These helpers encapsulate common patterns used across multiple stories,
 * making each story file more focused on the specific visual state being tested.
 */

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceChatMessage, ChatMuxMessage } from "@/common/orpc/types";
import {
  SELECTED_WORKSPACE_KEY,
  EXPANDED_PROJECTS_KEY,
  getInputKey,
  getModelKey,
} from "@/common/constants/storage";
import {
  createWorkspace,
  createMockAPI,
  installMockAPI,
  groupWorkspacesByProject,
  createStaticChatHandler,
  createStreamingChatHandler,
  type GitStatusFixture,
} from "./mockFactory";

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE SELECTION
// ═══════════════════════════════════════════════════════════════════════════════

/** Set localStorage to select a workspace */
export function selectWorkspace(workspace: FrontendWorkspaceMetadata): void {
  localStorage.setItem(
    SELECTED_WORKSPACE_KEY,
    JSON.stringify({
      workspaceId: workspace.id,
      projectPath: workspace.projectPath,
      projectName: workspace.projectName,
      namedWorkspacePath: workspace.namedWorkspacePath,
    })
  );
}

/** Set input text for a workspace */
export function setWorkspaceInput(workspaceId: string, text: string): void {
  localStorage.setItem(getInputKey(workspaceId), text);
}

/** Set model for a workspace */
export function setWorkspaceModel(workspaceId: string, model: string): void {
  localStorage.setItem(getModelKey(workspaceId), model);
}

/** Expand projects in the sidebar */
export function expandProjects(projectPaths: string[]): void {
  localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(projectPaths));
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE CHAT STORY SETUP
// ═══════════════════════════════════════════════════════════════════════════════

export interface SimpleChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  messages: ChatMuxMessage[];
  gitStatus?: GitStatusFixture;
  providersConfig?: Record<string, { apiKeySet: boolean; baseUrl?: string; models?: string[] }>;
}

/**
 * Setup a simple chat story with one workspace and messages.
 * Handles workspace creation, mock API, and workspace selection.
 */
export function setupSimpleChatStory(opts: SimpleChatSetupOptions): void {
  const workspaceId = opts.workspaceId ?? "ws-chat";
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: opts.workspaceName ?? "feature",
      projectName: opts.projectName ?? "my-app",
    }),
  ];

  const chatHandlers = new Map([[workspaceId, createStaticChatHandler(opts.messages)]]);
  const gitStatus = opts.gitStatus
    ? new Map<string, GitStatusFixture>([[workspaceId, opts.gitStatus]])
    : undefined;

  installMockAPI(
    createMockAPI({
      projects: groupWorkspacesByProject(workspaces),
      workspaces,
      chatHandlers,
      gitStatus,
      providersConfig: opts.providersConfig,
    })
  );

  selectWorkspace(workspaces[0]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// STREAMING CHAT STORY SETUP
// ═══════════════════════════════════════════════════════════════════════════════

export interface StreamingChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  messages: ChatMuxMessage[];
  streamingMessageId: string;
  model?: string;
  historySequence: number;
  streamText?: string;
  pendingTool?: { toolCallId: string; toolName: string; args: object };
  gitStatus?: GitStatusFixture;
}

/**
 * Setup a streaming chat story with active streaming state.
 */
export function setupStreamingChatStory(opts: StreamingChatSetupOptions): void {
  const workspaceId = opts.workspaceId ?? "ws-streaming";
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: opts.workspaceName ?? "feature",
      projectName: opts.projectName ?? "my-app",
    }),
  ];

  const chatHandlers = new Map([
    [
      workspaceId,
      createStreamingChatHandler({
        messages: opts.messages,
        streamingMessageId: opts.streamingMessageId,
        model: opts.model ?? "anthropic:claude-sonnet-4-5",
        historySequence: opts.historySequence,
        streamText: opts.streamText,
        pendingTool: opts.pendingTool,
      }),
    ],
  ]);

  const gitStatus = opts.gitStatus
    ? new Map<string, GitStatusFixture>([[workspaceId, opts.gitStatus]])
    : undefined;

  installMockAPI(
    createMockAPI({
      projects: groupWorkspacesByProject(workspaces),
      workspaces,
      chatHandlers,
      gitStatus,
    })
  );

  selectWorkspace(workspaces[0]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM CHAT HANDLER SETUP
// ═══════════════════════════════════════════════════════════════════════════════

type ChatHandler = (callback: (event: WorkspaceChatMessage) => void) => () => void;

export interface CustomChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  chatHandler: ChatHandler;
}

/**
 * Setup a chat story with a custom chat handler for special scenarios
 * (e.g., stream errors, custom message sequences).
 */
export function setupCustomChatStory(opts: CustomChatSetupOptions): void {
  const workspaceId = opts.workspaceId ?? "ws-custom";
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: opts.workspaceName ?? "feature",
      projectName: opts.projectName ?? "my-app",
    }),
  ];

  const chatHandlers = new Map([[workspaceId, opts.chatHandler]]);

  installMockAPI(
    createMockAPI({
      projects: groupWorkspacesByProject(workspaces),
      workspaces,
      chatHandlers,
    })
  );

  selectWorkspace(workspaces[0]);
}
