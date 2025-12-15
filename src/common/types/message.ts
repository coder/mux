import type { UIMessage } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { StreamErrorType } from "./errors";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { ImagePart, MuxToolPartSchema } from "@/common/orpc/schemas";
import type { z } from "zod";
import { type ReviewNoteData, formatReviewForModel } from "./review";

/**
 * Review data stored in message metadata for display.
 * Alias for ReviewNoteData - they have identical shape.
 */
export type ReviewNoteDataForDisplay = ReviewNoteData;

/**
 * Content that a user wants to send in a message.
 * Shared between normal send and continue-after-compaction to ensure
 * both paths handle the same fields (text, images, reviews).
 */
export interface UserMessageContent {
  text: string;
  imageParts?: ImagePart[];
  /** Review data - formatted into message text AND stored in metadata for display */
  reviews?: ReviewNoteDataForDisplay[];
}

/**
 * Message to continue with after compaction.
 * Extends UserMessageContent with model preference.
 */
export interface ContinueMessage extends UserMessageContent {
  model?: string;
}

// Parsed compaction request data (shared type for consistency)
export interface CompactionRequestData {
  model?: string; // Custom model override for compaction
  maxOutputTokens?: number;
  continueMessage?: ContinueMessage;
}

/**
 * Process UserMessageContent into final message text and metadata.
 * Used by both normal send path and backend continue message processing.
 *
 * @param content - The user message content (text, images, reviews)
 * @param existingMetadata - Optional existing metadata to merge with (e.g., for compaction messages)
 * @returns Object with finalText (reviews prepended) and metadata (reviews for display)
 */
export function prepareUserMessageForSend(
  content: UserMessageContent,
  existingMetadata?: MuxFrontendMetadata
): {
  finalText: string;
  metadata: MuxFrontendMetadata | undefined;
} {
  const { text, reviews } = content;

  // Format reviews into message text
  const reviewsText = reviews?.length ? reviews.map(formatReviewForModel).join("\n\n") : "";
  const finalText = reviewsText ? reviewsText + (text ? "\n\n" + text : "") : text;

  // Build metadata with reviews for display
  let metadata: MuxFrontendMetadata | undefined = existingMetadata;
  if (reviews?.length) {
    metadata = metadata ? { ...metadata, reviews } : { type: "normal", reviews };
  }

  return { finalText, metadata };
}

/** Base fields common to all metadata types */
interface MuxFrontendMetadataBase {
  /** Structured review data for rich UI display (orthogonal to message type) */
  reviews?: ReviewNoteDataForDisplay[];
}

/** Status to display in sidebar during background operations */
export interface DisplayStatus {
  emoji: string;
  message: string;
}

export type MuxFrontendMetadata = MuxFrontendMetadataBase &
  (
    | {
        type: "compaction-request";
        rawCommand: string; // The original /compact command as typed by user (for display)
        parsed: CompactionRequestData;
        /** Source of compaction request: user-initiated (undefined) or idle-compaction (auto) */
        source?: "idle-compaction";
        /** Transient status to display in sidebar during this operation */
        displayStatus?: DisplayStatus;
      }
    | {
        type: "plan-display"; // Ephemeral plan display from /plan command
        path: string;
      }
    | {
        type: "normal"; // Regular messages
      }
  );

// Our custom metadata type
export interface MuxMetadata {
  historySequence?: number; // Assigned by backend for global message ordering (required when writing to history)
  duration?: number;
  timestamp?: number;
  model?: string;
  // Total usage across all steps (for cost calculation)
  usage?: LanguageModelV2Usage;
  // Last step's usage only (for context window display - inputTokens = current context size)
  contextUsage?: LanguageModelV2Usage;
  // Aggregated provider metadata across all steps (for cost calculation)
  providerMetadata?: Record<string, unknown>;
  // Last step's provider metadata (for context window cache display)
  contextProviderMetadata?: Record<string, unknown>;
  systemMessageTokens?: number; // Token count for system message sent with this request (calculated by AIService)
  partial?: boolean; // Whether this message was interrupted and is incomplete
  synthetic?: boolean; // Whether this message was synthetically generated (e.g., [CONTINUE] sentinel)
  error?: string; // Error message if stream failed
  errorType?: StreamErrorType; // Error type/category if stream failed
  compacted?: boolean; // Whether this message is a compacted summary of previous history
  idleCompacted?: boolean; // Whether this compaction was auto-triggered due to workspace inactivity
  toolPolicy?: ToolPolicy; // Tool policy active when this message was sent (user messages only)
  mode?: string; // The mode (plan/exec/etc) active when this message was sent (assistant messages only)
  cmuxMetadata?: MuxFrontendMetadata; // Frontend-defined metadata, backend treats as black-box
  muxMetadata?: MuxFrontendMetadata; // Frontend-defined metadata, backend treats as black-box
}

// Extended tool part type that supports interrupted tool calls (input-available state)
// Standard AI SDK ToolUIPart only supports output-available (completed tools)
// Uses discriminated union: output is required when state is "output-available", absent when "input-available"
export type MuxToolPart = z.infer<typeof MuxToolPartSchema>;

// Text part type
export interface MuxTextPart {
  type: "text";
  text: string;
  timestamp?: number;
}

// Reasoning part type for extended thinking content
export interface MuxReasoningPart {
  type: "reasoning";
  text: string;
  timestamp?: number;
}

// File/Image part type for multimodal messages (matches AI SDK FileUIPart)
// Images are represented as files with image/* mediaType
export interface MuxImagePart {
  type: "file";
  mediaType: string; // IANA media type, e.g., "image/png", "image/jpeg"
  url: string; // Data URL (e.g., "data:image/png;base64,...") or hosted URL
  filename?: string; // Optional filename
}

// MuxMessage extends UIMessage with our metadata and custom parts
// Supports text, reasoning, image, and tool parts (including interrupted tool calls)
export type MuxMessage = Omit<UIMessage<MuxMetadata, never, never>, "parts"> & {
  parts: Array<MuxTextPart | MuxReasoningPart | MuxImagePart | MuxToolPart>;
};

// DisplayedMessage represents a single UI message block
// This is what the UI components consume, splitting complex messages into separate visual blocks
export type DisplayedMessage =
  | {
      type: "user";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original MuxMessage ID for history operations
      content: string;
      imageParts?: ImagePart[]; // Optional image attachments
      historySequence: number; // Global ordering across all messages
      timestamp?: number;
      compactionRequest?: {
        // Present if this is a /compact command
        rawCommand: string;
        parsed: CompactionRequestData;
      };
      /** Structured review data for rich UI display (from muxMetadata) */
      reviews?: ReviewNoteDataForDisplay[];
    }
  | {
      type: "assistant";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original MuxMessage ID for history operations
      content: string;
      historySequence: number; // Global ordering across all messages
      streamSequence?: number; // Local ordering within this assistant message
      isStreaming: boolean;
      isPartial: boolean; // Whether this message was interrupted
      isLastPartOfMessage?: boolean; // True if this is the last part of a multi-part message
      isCompacted: boolean; // Whether this is a compacted summary
      isIdleCompacted: boolean; // Whether this compaction was auto-triggered due to inactivity
      model?: string;
      timestamp?: number;
      tokens?: number;
    }
  | {
      type: "tool";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original MuxMessage ID for history operations
      toolCallId: string;
      toolName: string;
      args: unknown;
      result?: unknown;
      status: "pending" | "executing" | "completed" | "failed" | "interrupted";
      isPartial: boolean; // Whether the parent message was interrupted
      historySequence: number; // Global ordering across all messages
      streamSequence?: number; // Local ordering within this assistant message
      isLastPartOfMessage?: boolean; // True if this is the last part of a multi-part message
      timestamp?: number;
    }
  | {
      type: "reasoning";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original MuxMessage ID for history operations
      content: string;
      historySequence: number; // Global ordering across all messages
      streamSequence?: number; // Local ordering within this assistant message
      isStreaming: boolean;
      isPartial: boolean; // Whether the parent message was interrupted
      isLastPartOfMessage?: boolean; // True if this is the last part of a multi-part message
      timestamp?: number;
      tokens?: number; // Reasoning tokens if available
    }
  | {
      type: "stream-error";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original MuxMessage ID for history operations
      error: string; // Error message
      errorType: StreamErrorType; // Error type/category
      historySequence: number; // Global ordering across all messages
      timestamp?: number;
      model?: string;
      errorCount?: number; // Number of consecutive identical errors merged into this message
    }
  | {
      type: "history-hidden";
      id: string; // Display ID for UI/React keys
      hiddenCount: number; // Number of messages hidden
      historySequence: number; // Global ordering across all messages
    }
  | {
      type: "workspace-init";
      id: string; // Display ID for UI/React keys
      historySequence: number; // Position in message stream (-1 for ephemeral, non-persisted events)
      status: "running" | "success" | "error";
      hookPath: string; // Path to the init script being executed
      lines: string[]; // Accumulated output lines (stderr prefixed with "ERROR:")
      exitCode: number | null; // Final exit code (null while running)
      timestamp: number;
    }
  | {
      type: "plan-display"; // Ephemeral plan display from /plan command
      id: string; // Display ID for UI/React keys
      historyId: string; // Original MuxMessage ID (same as id for ephemeral messages)
      content: string; // Plan markdown content
      path: string; // Path to the plan file
      historySequence: number; // Global ordering across all messages
    };

export interface QueuedMessage {
  id: string;
  content: string;
  imageParts?: ImagePart[];
  /** Structured review data for rich UI display (from muxMetadata) */
  reviews?: ReviewNoteDataForDisplay[];
}

// Helper to create a simple text message
export function createMuxMessage(
  id: string,
  role: "user" | "assistant",
  content: string,
  metadata?: MuxMetadata,
  additionalParts?: MuxMessage["parts"]
): MuxMessage {
  const textPart = content
    ? [{ type: "text" as const, text: content, state: "done" as const }]
    : [];
  const parts = [...textPart, ...(additionalParts ?? [])];

  // Validation: User messages must have at least one part with content
  // This prevents empty user messages from being created (defense-in-depth)
  if (role === "user" && parts.length === 0) {
    throw new Error(
      "Cannot create user message with no parts. Empty messages should be rejected upstream."
    );
  }

  return {
    id,
    role,
    metadata,
    parts,
  };
}
