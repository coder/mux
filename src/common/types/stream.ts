/**
 * Event types emitted by AIService
 */

import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { MuxReasoningPart, MuxTextPart, MuxToolPart } from "./message";
import type { StreamErrorType } from "./errors";

/**
 * Completed message part (reasoning, text, or tool) suitable for serialization
 * Used in StreamEndEvent and partial message storage
 */
export type CompletedMessagePart = MuxReasoningPart | MuxTextPart | MuxToolPart;

export interface StreamStartEvent {
  type: "stream-start";
  workspaceId: string;
  messageId: string;
  model: string;
  historySequence: number; // Backend assigns global message ordering
}

export interface StreamDeltaEvent {
  type: "stream-delta";
  workspaceId: string;
  messageId: string;
  delta: string;
  tokens: number; // Token count for this delta
  timestamp: number; // When delta was received (Date.now())
}

export interface StreamEndEvent {
  type: "stream-end";
  workspaceId: string;
  messageId: string;
  // Structured metadata from backend - directly mergeable with MuxMetadata
  metadata: {
    model: string;
    // Total usage across all steps (for cost calculation)
    usage?: LanguageModelV2Usage;
    // Last step's usage only (for context window display - inputTokens = current context size)
    contextUsage?: LanguageModelV2Usage;
    // Aggregated provider metadata across all steps (for cost calculation)
    providerMetadata?: Record<string, unknown>;
    // Last step's provider metadata (for context window cache display)
    contextProviderMetadata?: Record<string, unknown>;
    duration?: number;
    systemMessageTokens?: number;
    historySequence?: number; // Present when loading from history
    timestamp?: number; // Present when loading from history
  };
  // Parts array preserves temporal ordering of reasoning, text, and tool calls
  parts: CompletedMessagePart[];
}

export interface StreamAbortEvent {
  type: "stream-abort";
  workspaceId: string;
  messageId: string;
  // Metadata may contain usage if abort occurred after stream completed processing
  metadata?: {
    // Total usage across all steps (for cost calculation)
    usage?: LanguageModelV2Usage;
    // Last step's usage (for context window display - inputTokens = current context size)
    contextUsage?: LanguageModelV2Usage;
    // Provider metadata for cost calculation (cache tokens, etc.)
    providerMetadata?: Record<string, unknown>;
    // Last step's provider metadata (for context window cache display)
    contextProviderMetadata?: Record<string, unknown>;
    duration?: number;
  };
  abandonPartial?: boolean;
}

export interface ErrorEvent {
  type: "error";
  workspaceId: string;
  messageId: string;
  error: string;
  errorType?: StreamErrorType;
}

// Tool call events
export interface ToolCallStartEvent {
  type: "tool-call-start";
  workspaceId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  tokens: number; // Token count for tool input
  timestamp: number; // When tool call started (Date.now())
}

export interface ToolCallDeltaEvent {
  type: "tool-call-delta";
  workspaceId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  delta: unknown;
  tokens: number; // Token count for this delta
  timestamp: number; // When delta was received (Date.now())
}

export interface ToolCallEndEvent {
  type: "tool-call-end";
  workspaceId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  result: unknown;
}

// Reasoning events
export interface ReasoningStartEvent {
  type: "reasoning-start";
  workspaceId: string;
  messageId: string;
}

export interface ReasoningDeltaEvent {
  type: "reasoning-delta";
  workspaceId: string;
  messageId: string;
  delta: string;
  tokens: number; // Token count for this delta
  timestamp: number; // When delta was received (Date.now())
}

export interface ReasoningEndEvent {
  type: "reasoning-end";
  workspaceId: string;
  messageId: string;
}

/**
 * Emitted on each AI SDK finish-step event, providing incremental usage updates.
 * Allows UI to update token display as steps complete (after each tool call or at stream end).
 */
export interface UsageDeltaEvent {
  type: "usage-delta";
  workspaceId: string;
  messageId: string;
  // This step's usage (inputTokens = current context size, for context window display)
  usage: LanguageModelV2Usage;
  // Cumulative usage across all steps so far (for live cost display)
  cumulativeUsage: LanguageModelV2Usage;
  // Cumulative provider metadata across all steps (for live cost display with cache tokens)
  cumulativeProviderMetadata?: Record<string, unknown>;
}

export type AIServiceEvent =
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamEndEvent
  | StreamAbortEvent
  | ErrorEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ReasoningStartEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | UsageDeltaEvent;
