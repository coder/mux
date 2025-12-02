import type { Result } from "./result";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "./workspace";
import type { MuxMessage, MuxFrontendMetadata } from "./message";
import type { ChatStats } from "./chatStats";
import type { ProjectConfig } from "@/node/config";
import type { SendMessageError, StreamErrorType } from "./errors";
import type { ThinkingLevel } from "./thinking";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { BashToolResult } from "./tools";
import type { Secret } from "./secrets";
import type { MuxProviderOptions } from "./providerOptions";
import type { RuntimeConfig } from "./runtime";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import type { TerminalSession, TerminalCreateParams, TerminalResizeParams } from "./terminal";
import type {
  StreamStartEvent,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamAbortEvent,
  UsageDeltaEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
} from "./stream";

// Import constants from constants module (single source of truth)
import { IPC_CHANNELS, getChatChannel } from "@/common/constants/ipc-constants";

// Re-export for TypeScript consumers
export { IPC_CHANNELS, getChatChannel };

// Type for all channel names
export type IPCChannel = string;

export interface BranchListResult {
  branches: string[];
  recommendedTrunk: string;
}

// Caught up message type
export interface CaughtUpMessage {
  type: "caught-up";
}

// Stream error message type (for async streaming errors)
export interface StreamErrorMessage {
  type: "stream-error";
  messageId: string;
  error: string;
  errorType: StreamErrorType;
}

// Delete message type (for truncating history)
export interface DeleteMessage {
  type: "delete";
  historySequences: number[];
}

// Workspace init hook events (persisted to init-status.json, not chat.jsonl)
export type WorkspaceInitEvent =
  | {
      type: "init-start";
      hookPath: string;
      timestamp: number;
    }
  | {
      type: "init-output";
      line: string;
      timestamp: number;
      isError?: boolean;
    }
  | {
      type: "init-end";
      exitCode: number;
      timestamp: number;
    };

export interface QueuedMessageChangedEvent {
  type: "queued-message-changed";
  workspaceId: string;
  queuedMessages: string[]; // Raw messages for editing/restoration
  displayText: string; // Display text (handles slash commands)
  imageParts?: ImagePart[]; // Optional image attachments
}

// Restore to input event (when stream ends/aborts with queued messages)
export interface RestoreToInputEvent {
  type: "restore-to-input";
  workspaceId: string;
  text: string;
  imageParts?: ImagePart[]; // Optional image attachments to restore
}
// Union type for workspace chat messages
export type WorkspaceChatMessage =
  | MuxMessage
  | CaughtUpMessage
  | StreamErrorMessage
  | DeleteMessage
  | StreamStartEvent
  | StreamDeltaEvent
  | UsageDeltaEvent
  | StreamEndEvent
  | StreamAbortEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | WorkspaceInitEvent
  | QueuedMessageChangedEvent
  | RestoreToInputEvent;

// Type guard for caught up messages
export function isCaughtUpMessage(msg: WorkspaceChatMessage): msg is CaughtUpMessage {
  return "type" in msg && msg.type === "caught-up";
}

// Type guard for stream error messages
export function isStreamError(msg: WorkspaceChatMessage): msg is StreamErrorMessage {
  return "type" in msg && msg.type === "stream-error";
}

// Type guard for delete messages
export function isDeleteMessage(msg: WorkspaceChatMessage): msg is DeleteMessage {
  return "type" in msg && msg.type === "delete";
}

// Type guard for stream start events
export function isStreamStart(msg: WorkspaceChatMessage): msg is StreamStartEvent {
  return "type" in msg && msg.type === "stream-start";
}

// Type guard for stream delta events
export function isStreamDelta(msg: WorkspaceChatMessage): msg is StreamDeltaEvent {
  return "type" in msg && msg.type === "stream-delta";
}

// Type guard for stream end events
export function isStreamEnd(msg: WorkspaceChatMessage): msg is StreamEndEvent {
  return "type" in msg && msg.type === "stream-end";
}

// Type guard for stream abort events
export function isStreamAbort(msg: WorkspaceChatMessage): msg is StreamAbortEvent {
  return "type" in msg && msg.type === "stream-abort";
}

// Type guard for usage delta events
export function isUsageDelta(msg: WorkspaceChatMessage): msg is UsageDeltaEvent {
  return "type" in msg && msg.type === "usage-delta";
}

// Type guard for tool call start events
export function isToolCallStart(msg: WorkspaceChatMessage): msg is ToolCallStartEvent {
  return "type" in msg && msg.type === "tool-call-start";
}

// Type guard for tool call delta events
export function isToolCallDelta(msg: WorkspaceChatMessage): msg is ToolCallDeltaEvent {
  return "type" in msg && msg.type === "tool-call-delta";
}

// Type guard for tool call end events
export function isToolCallEnd(msg: WorkspaceChatMessage): msg is ToolCallEndEvent {
  return "type" in msg && msg.type === "tool-call-end";
}

// Type guard for reasoning delta events
export function isReasoningDelta(msg: WorkspaceChatMessage): msg is ReasoningDeltaEvent {
  return "type" in msg && msg.type === "reasoning-delta";
}

// Type guard for reasoning end events
export function isReasoningEnd(msg: WorkspaceChatMessage): msg is ReasoningEndEvent {
  return "type" in msg && msg.type === "reasoning-end";
}

// Type guard for MuxMessage (messages with role but no type field)
export function isMuxMessage(msg: WorkspaceChatMessage): msg is MuxMessage {
  return "role" in msg && !("type" in msg);
}

// Type guards for init events
export function isInitStart(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceInitEvent, { type: "init-start" }> {
  return "type" in msg && msg.type === "init-start";
}

export function isInitOutput(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceInitEvent, { type: "init-output" }> {
  return "type" in msg && msg.type === "init-output";
}

export function isInitEnd(
  msg: WorkspaceChatMessage
): msg is Extract<WorkspaceInitEvent, { type: "init-end" }> {
  return "type" in msg && msg.type === "init-end";
}

// Type guard for queued message changed events
export function isQueuedMessageChanged(
  msg: WorkspaceChatMessage
): msg is QueuedMessageChangedEvent {
  return "type" in msg && msg.type === "queued-message-changed";
}

// Type guard for restore to input events
export function isRestoreToInput(msg: WorkspaceChatMessage): msg is RestoreToInputEvent {
  return "type" in msg && msg.type === "restore-to-input";
}

// Type guard for stream stats events

// Options for sendMessage and resumeStream
export interface SendMessageOptions {
  editMessageId?: string;
  thinkingLevel?: ThinkingLevel;
  model: string;
  toolPolicy?: ToolPolicy;
  additionalSystemInstructions?: string;
  maxOutputTokens?: number;
  providerOptions?: MuxProviderOptions;
  mode?: string; // Mode name - frontend narrows to specific values, backend accepts any string
  muxMetadata?: MuxFrontendMetadata; // Frontend-defined metadata, backend treats as black-box
}

// API method signatures (shared between main and preload)
// We strive to have a small, tight interface between main and the renderer
// to promote good SoC and testing.
//
// Design principle: IPC methods should be idempotent when possible.
// For example, calling resumeStream on an already-active stream should
// return success (not error), making client code simpler and more resilient.
//
// Minimize the number of methods - use optional parameters for operation variants
// (e.g. remove(id, force?) not remove(id) + removeForce(id)).
export interface IPCApi {
  tokenizer: {
    countTokens(model: string, text: string): Promise<number>;
    countTokensBatch(model: string, texts: string[]): Promise<number[]>;
    calculateStats(messages: MuxMessage[], model: string): Promise<ChatStats>;
  };
  providers: {
    setProviderConfig(
      provider: string,
      keyPath: string[],
      value: string
    ): Promise<Result<void, string>>;
    setModels(provider: string, models: string[]): Promise<Result<void, string>>;
    getConfig(): Promise<
      Record<string, { apiKeySet: boolean; baseUrl?: string; models?: string[] }>
    >;
    list(): Promise<string[]>;
  };
  fs?: {
    listDirectory(root: string): Promise<FileTreeNode>;
  };
  projects: {
    create(
      projectPath: string
    ): Promise<Result<{ projectConfig: ProjectConfig; normalizedPath: string }, string>>;
    pickDirectory(): Promise<string | null>;
    remove(projectPath: string): Promise<Result<void, string>>;
    list(): Promise<Array<[string, ProjectConfig]>>;
    listBranches(projectPath: string): Promise<BranchListResult>;
    secrets: {
      get(projectPath: string): Promise<Secret[]>;
      update(projectPath: string, secrets: Secret[]): Promise<Result<void, string>>;
    };
  };
  workspace: {
    list(): Promise<FrontendWorkspaceMetadata[]>;
    create(
      projectPath: string,
      branchName: string,
      trunkBranch: string,
      runtimeConfig?: RuntimeConfig
    ): Promise<
      { success: true; metadata: FrontendWorkspaceMetadata } | { success: false; error: string }
    >;
    remove(
      workspaceId: string,
      options?: { force?: boolean }
    ): Promise<{ success: boolean; error?: string }>;
    rename(
      workspaceId: string,
      newName: string
    ): Promise<Result<{ newWorkspaceId: string }, string>>;
    fork(
      sourceWorkspaceId: string,
      newName: string
    ): Promise<
      | { success: true; metadata: WorkspaceMetadata; projectPath: string }
      | { success: false; error: string }
    >;
    sendMessage(
      workspaceId: string | null,
      message: string,
      options?: SendMessageOptions & {
        imageParts?: ImagePart[];
        runtimeConfig?: RuntimeConfig;
        projectPath?: string; // Required when workspaceId is null
        trunkBranch?: string; // Optional - trunk branch to branch from (when workspaceId is null)
      }
    ): Promise<
      | Result<void, SendMessageError>
      | { success: true; workspaceId: string; metadata: FrontendWorkspaceMetadata }
    >;
    resumeStream(
      workspaceId: string,
      options: SendMessageOptions
    ): Promise<Result<void, SendMessageError>>;
    interruptStream(
      workspaceId: string,
      options?: { abandonPartial?: boolean; sendQueuedImmediately?: boolean }
    ): Promise<Result<void, string>>;
    clearQueue(workspaceId: string): Promise<Result<void, string>>;
    truncateHistory(workspaceId: string, percentage?: number): Promise<Result<void, string>>;
    replaceChatHistory(
      workspaceId: string,
      summaryMessage: MuxMessage
    ): Promise<Result<void, string>>;
    getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null>;
    executeBash(
      workspaceId: string,
      script: string,
      options?: {
        timeout_secs?: number;
        niceness?: number;
      }
    ): Promise<Result<BashToolResult, string>>;
    openTerminal(workspacePath: string): Promise<void>;

    // Event subscriptions (renderer-only)
    // These methods are designed to send current state immediately upon subscription,
    // followed by real-time updates. We deliberately don't provide one-off getters
    // to encourage the renderer to maintain an always up-to-date view of the state
    // through continuous subscriptions rather than polling patterns.
    onChat(workspaceId: string, callback: (data: WorkspaceChatMessage) => void): () => void;
    onMetadata(
      callback: (data: { workspaceId: string; metadata: FrontendWorkspaceMetadata }) => void
    ): () => void;
    activity: {
      list(): Promise<Record<string, WorkspaceActivitySnapshot>>;
      subscribe(
        callback: (payload: {
          workspaceId: string;
          activity: WorkspaceActivitySnapshot | null;
        }) => void
      ): () => void;
    };
  };
  window: {
    setTitle(title: string): Promise<void>;
  };
  terminal: {
    create(params: TerminalCreateParams): Promise<TerminalSession>;
    close(sessionId: string): Promise<void>;
    resize(params: TerminalResizeParams): Promise<void>;
    sendInput(sessionId: string, data: string): void;
    onOutput(sessionId: string, callback: (data: string) => void): () => void;
    onExit(sessionId: string, callback: (exitCode: number) => void): () => void;
    openWindow(workspaceId: string): Promise<void>;
    closeWindow(workspaceId: string): Promise<void>;
  };
  voice: {
    /** Transcribe audio using OpenAI Whisper. Audio should be base64-encoded webm/opus. */
    transcribe(audioBase64: string): Promise<Result<string, string>>;
  };
  update: {
    check(): Promise<void>;
    download(): Promise<void>;
    install(): void;
    onStatus(callback: (status: UpdateStatus) => void): () => void;
  };
  menu?: {
    onOpenSettings(callback: () => void): () => void;
  };
  server?: {
    getLaunchProject(): Promise<string | null>;
  };
  platform?: "electron" | "browser";
  versions?: {
    node?: string;
    chrome?: string;
    electron?: string;
  };
}

// Update status type (matches updater service)
export type UpdateStatus =
  | { type: "idle" } // Initial state, no check performed yet
  | { type: "checking" }
  | { type: "available"; info: { version: string } }
  | { type: "up-to-date" } // Explicitly checked, no updates available
  | { type: "downloading"; percent: number }
  | { type: "downloaded"; info: { version: string } }
  | { type: "error"; message: string };

export interface ImagePart {
  url: string; // Data URL (e.g., "data:image/png;base64,...")
  mediaType: string; // MIME type (e.g., "image/png", "image/jpeg")
}
