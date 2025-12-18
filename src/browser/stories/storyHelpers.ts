/**
 * Shared story setup helpers to reduce boilerplate.
 *
 * These helpers encapsulate common patterns used across multiple stories,
 * making each story file more focused on the specific visual state being tested.
 */

import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type {
  WorkspaceChatMessage,
  ChatMuxMessage,
  ProvidersConfigMap,
  WorkspaceStatsSnapshot,
} from "@/common/orpc/types";
import type { APIClient } from "@/browser/contexts/API";
import {
  SELECTED_WORKSPACE_KEY,
  EXPANDED_PROJECTS_KEY,
  getInputKey,
  getModelKey,
  getReviewsKey,
} from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { Review, ReviewsState } from "@/common/types/review";
import { DEFAULT_MODEL } from "@/common/constants/knownModels";
import {
  createWorkspace,
  groupWorkspacesByProject,
  createStaticChatHandler,
  createStreamingChatHandler,
  createGitStatusOutput,
  type GitStatusFixture,
} from "./mockFactory";
import { createMockORPCClient, type MockSessionUsage } from "../../../.storybook/mocks/orpc";

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

/** Clear workspace selection from localStorage (for sidebar-focused stories) */
export function clearWorkspaceSelection(): void {
  localStorage.removeItem(SELECTED_WORKSPACE_KEY);
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

/** Set reviews for a workspace */
export function setReviews(workspaceId: string, reviews: Review[]): void {
  const state: ReviewsState = {
    workspaceId,
    reviews: Object.fromEntries(reviews.map((r) => [r.id, r])),
    lastUpdated: Date.now(),
  };
  updatePersistedState(getReviewsKey(workspaceId), state);
}

/** Create a sample review for stories */
export function createReview(
  id: string,
  filePath: string,
  lineRange: string,
  note: string,
  status: "pending" | "attached" | "checked" = "pending",
  createdAt?: number
): Review {
  return {
    id,
    data: {
      filePath,
      lineRange,
      selectedCode: "// sample code",
      userNote: note,
    },
    status,
    createdAt: createdAt ?? Date.now(),
    statusChangedAt: status === "checked" ? Date.now() : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS EXECUTOR
// ═══════════════════════════════════════════════════════════════════════════════

/** Creates an executeBash function that returns git status output for workspaces */
export function createGitStatusExecutor(gitStatus?: Map<string, GitStatusFixture>) {
  return (workspaceId: string, script: string) => {
    if (script.includes("git status") || script.includes("git show-branch")) {
      const status = gitStatus?.get(workspaceId) ?? {};
      const output = createGitStatusOutput(status);
      return Promise.resolve({ success: true as const, output, exitCode: 0, wall_duration_ms: 50 });
    }
    return Promise.resolve({
      success: true as const,
      output: "",
      exitCode: 0,
      wall_duration_ms: 0,
    });
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAT HANDLER ADAPTER
// ═══════════════════════════════════════════════════════════════════════════════

export type ChatHandler = (callback: (event: WorkspaceChatMessage) => void) => () => void;

/** Adapts callback-based chat handlers to ORPC onChat format */
export function createOnChatAdapter(chatHandlers: Map<string, ChatHandler>) {
  return (workspaceId: string, emit: (msg: WorkspaceChatMessage) => void) => {
    const handler = chatHandlers.get(workspaceId);
    if (handler) {
      return handler(emit);
    }
    // Default: emit caught-up immediately
    queueMicrotask(() => emit({ type: "caught-up" }));
    return undefined;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE CHAT STORY SETUP
// ═══════════════════════════════════════════════════════════════════════════════

export interface BackgroundProcessFixture {
  id: string;
  pid: number;
  script: string;
  displayName?: string;
  startTime: number;
  status: "running" | "exited" | "killed" | "failed";
  exitCode?: number;
}

export interface SimpleChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  messages: ChatMuxMessage[];
  gitStatus?: GitStatusFixture;
  providersConfig?: ProvidersConfigMap;
  backgroundProcesses?: BackgroundProcessFixture[];
  /** Session usage data for Costs tab */
  statsTabEnabled?: boolean;
  sessionUsage?: MockSessionUsage;
  /** Optional custom chat handler for emitting additional events (e.g., queued-message-changed) */
  onChat?: (workspaceId: string, emit: (msg: WorkspaceChatMessage) => void) => void;
}

/**
 * Setup a simple chat story with one workspace and messages.
 * Returns an APIClient configured with the mock data.
 */
export function setupSimpleChatStory(opts: SimpleChatSetupOptions): APIClient {
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

  // Set localStorage for workspace selection
  selectWorkspace(workspaces[0]);

  // Set up background processes map
  const bgProcesses = opts.backgroundProcesses
    ? new Map([[workspaceId, opts.backgroundProcesses]])
    : undefined;

  // Set up session usage map
  const sessionUsageMap = opts.sessionUsage
    ? new Map([[workspaceId, opts.sessionUsage]])
    : undefined;

  // Create onChat handler that combines static messages with custom handler
  const baseOnChat = createOnChatAdapter(chatHandlers);
  const onChat = opts.onChat
    ? (wsId: string, emit: (msg: WorkspaceChatMessage) => void) => {
        const cleanup = baseOnChat(wsId, emit);
        opts.onChat!(wsId, emit);
        return cleanup;
      }
    : baseOnChat;

  // Return ORPC client
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    onChat,
    executeBash: createGitStatusExecutor(gitStatus),
    providersConfig: opts.providersConfig,
    backgroundProcesses: bgProcesses,
    statsTabVariant: opts.statsTabEnabled ? "stats" : "control",
    sessionUsage: sessionUsageMap,
  });
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
  statsTabEnabled?: boolean;
}

/**
 * Setup a streaming chat story with active streaming state.
 * Returns an APIClient configured with the mock data.
 */
export function setupStreamingChatStory(opts: StreamingChatSetupOptions): APIClient {
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
        model: opts.model ?? DEFAULT_MODEL,
        historySequence: opts.historySequence,
        streamText: opts.streamText,
        pendingTool: opts.pendingTool,
      }),
    ],
  ]);

  const gitStatus = opts.gitStatus
    ? new Map<string, GitStatusFixture>([[workspaceId, opts.gitStatus]])
    : undefined;

  // Set localStorage for workspace selection
  selectWorkspace(workspaces[0]);

  const workspaceStatsSnapshots = new Map<string, WorkspaceStatsSnapshot>();
  if (opts.statsTabEnabled) {
    workspaceStatsSnapshots.set(workspaceId, {
      workspaceId,
      generatedAt: Date.now(),
      active: {
        messageId: opts.streamingMessageId,
        model: "openai:gpt-4o",
        elapsedMs: 2000,
        ttftMs: 200,
        toolExecutionMs: 0,
        modelTimeMs: 2000,
        streamingMs: 1800,
        outputTokens: 100,
        reasoningTokens: 0,
        liveTokenCount: 100,
        liveTPS: 50,
        invalid: false,
        anomalies: [],
      },
      session: {
        totalDurationMs: 0,
        totalToolExecutionMs: 0,
        totalStreamingMs: 0,
        totalTtftMs: 0,
        ttftCount: 0,
        responseCount: 0,
        totalOutputTokens: 0,
        totalReasoningTokens: 0,
        byModel: {},
      },
    });
  }

  // Return ORPC client
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    onChat: createOnChatAdapter(chatHandlers),
    executeBash: createGitStatusExecutor(gitStatus),
    workspaceStatsSnapshots,
    statsTabVariant: opts.statsTabEnabled ? "stats" : "control",
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOM CHAT HANDLER SETUP
// ═══════════════════════════════════════════════════════════════════════════════

export interface CustomChatSetupOptions {
  workspaceId?: string;
  workspaceName?: string;
  projectName?: string;
  chatHandler: ChatHandler;
}

/**
 * Setup a chat story with a custom chat handler for special scenarios
 * (e.g., stream errors, custom message sequences).
 * Returns an APIClient configured with the mock data.
 */
export function setupCustomChatStory(opts: CustomChatSetupOptions): APIClient {
  const workspaceId = opts.workspaceId ?? "ws-custom";
  const workspaces = [
    createWorkspace({
      id: workspaceId,
      name: opts.workspaceName ?? "feature",
      projectName: opts.projectName ?? "my-app",
    }),
  ];

  const chatHandlers = new Map([[workspaceId, opts.chatHandler]]);

  // Set localStorage for workspace selection
  selectWorkspace(workspaces[0]);

  // Return ORPC client
  return createMockORPCClient({
    projects: groupWorkspacesByProject(workspaces),
    workspaces,
    onChat: createOnChatAdapter(chatHandlers),
  });
}
