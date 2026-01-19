import type { UIMessage } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { StreamErrorType } from "./errors";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { ImagePart, MuxToolPartSchema } from "@/common/orpc/schemas";
import type { AgentMode } from "@/common/types/mode";
import type { z } from "zod";
import type { AgentSkillScope } from "./agentSkill";
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
 * Brand symbol for ContinueMessage - ensures it can only be created via factory functions.
 * This prevents bugs where code manually constructs { text: "..." } and forgets fields.
 */
declare const ContinueMessageBrand: unique symbol;

/**
 * Message to continue with after compaction.
 * Branded type - must be created via buildContinueMessage() or rebuildContinueMessage().
 */
export type ContinueMessage = UserMessageContent & {
  model?: string;
  /** Agent ID for the continue message (determines tool policy via agent definitions). Defaults to 'exec'. */
  agentId?: string;
  /** Frontend metadata to apply to the queued follow-up user message (e.g., preserve /skill display) */
  muxMetadata?: MuxFrontendMetadata;
  /** Brand marker - not present at runtime, enforces factory usage at compile time */
  readonly [ContinueMessageBrand]: true;
};

/**
 * Input options for building a ContinueMessage.
 * All content fields optional - returns undefined if no content provided.
 */
export interface BuildContinueMessageOptions {
  text?: string;
  imageParts?: ImagePart[];
  reviews?: ReviewNoteDataForDisplay[];
  /** Optional frontend metadata to carry through to the queued follow-up user message */
  muxMetadata?: MuxFrontendMetadata;
  model: string;
  agentId: string;
}

/**
 * Build a ContinueMessage from raw inputs.
 * Centralizes the has-content check and field construction.
 *
 * @returns ContinueMessage if there's content to continue with, undefined otherwise
 */
export function buildContinueMessage(
  opts: BuildContinueMessageOptions
): ContinueMessage | undefined {
  const hasText = opts.text && opts.text.length > 0;
  const hasImages = opts.imageParts && opts.imageParts.length > 0;
  const hasReviews = opts.reviews && opts.reviews.length > 0;
  if (!hasText && !hasImages && !hasReviews) return undefined;

  // Type assertion is safe here - this is the only factory for ContinueMessage
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const result: ContinueMessage = {
    text: opts.text ?? "",
    imageParts: opts.imageParts,
    reviews: opts.reviews,
    muxMetadata: opts.muxMetadata,
    model: opts.model,
    agentId: opts.agentId,
  } as ContinueMessage;
  return result;
}

/**
 * Persisted ContinueMessage shape - what we read from storage/history.
 * May be missing fields if saved by older code versions.
 */
export type PersistedContinueMessage =
  // Older versions stored `mode` instead of `agentId`.
  // Keep `mode` here so rebuildContinueMessage can migrate existing history.
  Partial<Omit<ContinueMessage, typeof ContinueMessageBrand>> & {
    mode?: "exec" | "plan";
  };

/**
 * Rebuild a ContinueMessage from persisted data.
 * Use this when reading from storage/history where the data may have been
 * saved by older code that didn't include all fields.
 *
 * @param persisted - Data from storage (may be partial)
 * @param defaults - Default values for model/mode if not in persisted data
 * @returns Branded ContinueMessage, or undefined if no content
 */
export function rebuildContinueMessage(
  persisted: PersistedContinueMessage | undefined,
  defaults: { model: string; agentId: string }
): ContinueMessage | undefined {
  if (!persisted) return undefined;

  const persistedAgentId =
    typeof persisted.agentId === "string" && persisted.agentId.trim().length > 0
      ? persisted.agentId.trim()
      : undefined;

  const legacyAgentId =
    persisted.mode === "plan" || persisted.mode === "exec" ? persisted.mode : undefined;

  return buildContinueMessage({
    text: persisted.text,
    imageParts: persisted.imageParts,
    reviews: persisted.reviews,
    muxMetadata: persisted.muxMetadata,
    model: persisted.model ?? defaults.model,
    agentId: persistedAgentId ?? legacyAgentId ?? defaults.agentId,
  });
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
        type: "agent-skill";
        /** The original /{skillName} invocation as typed by user (for display) */
        rawCommand: string;
        skillName: string;
        scope: "project" | "global" | "built-in";
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
  // Compaction source: "user" (manual /compact), "idle" (auto-triggered), or legacy boolean `true`
  // Readers should use helper: isCompacted = compacted !== undefined && compacted !== false
  compacted?: "user" | "idle" | boolean;
  toolPolicy?: ToolPolicy; // Tool policy active when this message was sent (user messages only)
  mode?: AgentMode; // The mode active when this message was sent (assistant messages only)
  cmuxMetadata?: MuxFrontendMetadata; // Frontend-defined metadata, backend treats as black-box
  muxMetadata?: MuxFrontendMetadata; // Frontend-defined metadata, backend treats as black-box
  /**
   * @file mention snapshot token(s) this message provides content for.
   * When present, injectFileAtMentions() skips re-reading these tokens,
   * preserving prompt cache stability across turns.
   */
  fileAtMentionSnapshot?: string[];

  /**
   * Agent skill snapshot metadata for synthetic messages that inject skill bodies.
   */
  agentSkillSnapshot?: {
    skillName: string;
    scope: AgentSkillScope;
    sha256: string;
  };
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
  /**
   * Anthropic thinking block signature for replay.
   * Required to send reasoning back to Anthropic - the API validates signatures
   * to ensure thinking blocks haven't been tampered with. Reasoning without
   * signatures will be stripped before sending to avoid "empty content" errors.
   */
  signature?: string;
  /**
   * Provider options for SDK compatibility.
   * When converting to ModelMessages via the SDK's convertToModelMessages,
   * this is passed through. For Anthropic thinking blocks, this should contain
   * { anthropic: { signature } } to allow reasoning replay.
   */
  providerOptions?: {
    anthropic?: {
      signature?: string;
    };
  };
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
      isSynthetic?: boolean;
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
      mode?: string; // Mode active when this message was sent (assistant messages only)
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
      // Nested tool calls for code_execution (from PTC streaming or reconstructed from result)
      nestedCalls?: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
        output?: unknown;
        state: "input-available" | "output-available";
        timestamp?: number;
      }>;
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
      lines: Array<{ line: string; isError: boolean }>; // Accumulated output lines (stderr tagged via isError)
      exitCode: number | null; // Final exit code (null while running)
      timestamp: number;
      durationMs: number | null; // Duration in milliseconds (null while running)
      truncatedLines?: number; // Number of lines dropped from middle when output was too long
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
  /** True when the queued message is a compaction request (/compact) */
  hasCompactionRequest?: boolean;
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
