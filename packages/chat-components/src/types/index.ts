/**
 * Shared types for Mux chat components.
 * These are the minimal types needed to render conversations in read-only mode.
 */

// ============================================================================
// Message Parts
// ============================================================================

/** Text content part */
export interface MuxTextPart {
  type: "text";
  text: string;
  timestamp?: number;
}

/** Extended thinking/reasoning content */
export interface MuxReasoningPart {
  type: "reasoning";
  text: string;
  timestamp?: number;
  signature?: string;
  providerOptions?: {
    anthropic?: {
      signature?: string;
    };
  };
}

/** Image/file attachment (multimodal messages) */
export interface MuxImagePart {
  type: "file";
  mediaType: string; // IANA media type, e.g., "image/png"
  url: string; // Data URL or hosted URL
  filename?: string;
}

/** Tool invocation part */
export interface MuxToolPart {
  type: "tool-invocation";
  toolInvocationId: string;
  toolName: string;
  args: unknown;
  state: "partial-call" | "call" | "result";
  result?: unknown;
}

export type MuxMessagePart = MuxTextPart | MuxReasoningPart | MuxImagePart | MuxToolPart;

// ============================================================================
// Messages
// ============================================================================

export interface MuxMetadata {
  historySequence?: number;
  duration?: number;
  timestamp?: number;
  model?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  partial?: boolean;
  error?: string;
  errorType?: string;
}

/** The raw message format from Mux history */
export interface MuxMessage {
  id: string;
  role: "user" | "assistant";
  parts: MuxMessagePart[];
  metadata?: MuxMetadata;
}

// ============================================================================
// Displayed Messages (UI types)
// ============================================================================

/** Base fields for all displayed message types */
interface DisplayedMessageBase {
  historyId: string;
  timestamp?: number;
  isStreaming?: boolean;
  isPartial?: boolean;
  isLastPartOfMessage?: boolean;
}

/** User message for display */
export interface DisplayedUserMessage extends DisplayedMessageBase {
  type: "user";
  content: string;
  imageParts?: MuxImagePart[];
  compactionRequest?: {
    rawCommand: string;
    continueMessage?: { text: string };
  };
}

/** Assistant text message for display */
export interface DisplayedAssistantMessage extends DisplayedMessageBase {
  type: "assistant";
  content: string;
  model?: string;
  duration?: number;
  usage?: MuxMetadata["usage"];
}

/** Tool call message for display */
export interface DisplayedToolMessage extends DisplayedMessageBase {
  type: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  status: "executing" | "completed" | "error";
}

/** Reasoning/thinking message for display */
export interface DisplayedReasoningMessage extends DisplayedMessageBase {
  type: "reasoning";
  content: string;
}

/** Stream error message for display */
export interface DisplayedStreamErrorMessage extends DisplayedMessageBase {
  type: "stream-error";
  error: string;
  errorType?: string;
}

/** Hidden history indicator */
export interface DisplayedHistoryHiddenMessage extends DisplayedMessageBase {
  type: "history-hidden";
  hiddenCount: number;
}

/** Workspace init message */
export interface DisplayedInitMessage extends DisplayedMessageBase {
  type: "workspace-init";
  workspacePath: string;
  model: string;
}

/** Plan display message */
export interface DisplayedPlanMessage extends DisplayedMessageBase {
  type: "plan-display";
  content: string;
  path: string;
}

export type DisplayedMessage =
  | DisplayedUserMessage
  | DisplayedAssistantMessage
  | DisplayedToolMessage
  | DisplayedReasoningMessage
  | DisplayedStreamErrorMessage
  | DisplayedHistoryHiddenMessage
  | DisplayedInitMessage
  | DisplayedPlanMessage;

// ============================================================================
// Shared Conversation (for mux.md sharing)
// ============================================================================

export interface SharedConversationMetadata {
  workspaceId?: string;
  projectName?: string;
  model?: string;
  exportedAt: number;
  totalTokens?: number;
  sharedBy?: string; // GitHub user if signed
}

/**
 * The shared conversation format for mux.md.
 * Contains raw MuxMessages that get transformed to DisplayedMessages for rendering.
 */
export interface SharedConversation {
  version: 1;
  messages: MuxMessage[];
  metadata: SharedConversationMetadata;
}
