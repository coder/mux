import type { UIMessage } from "ai";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";
import type { StreamErrorType } from "./errors";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";
import type { FilePart, MuxToolPartSchema } from "@/common/orpc/schemas";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { z } from "zod";
import type { AgentMode } from "./mode";
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
 * both paths handle the same fields (text, attachments, reviews).
 */
export interface UserMessageContent {
  text: string;
  fileParts?: FilePart[];
  /** Review data - formatted into message text AND stored in metadata for display */
  reviews?: ReviewNoteDataForDisplay[];
}

/**
 * Input for follow-up content - what call sites provide when triggering compaction.
 * Does not include model/agentId since those come from sendMessageOptions.
 */
export interface CompactionFollowUpInput extends UserMessageContent {
  /** Frontend metadata to apply to the queued follow-up user message (e.g., preserve /skill display) */
  muxMetadata?: MuxFrontendMetadata;
}

/**
 * SendMessageOptions fields that should be preserved across compaction.
 * These affect how the follow-up message is processed (thinking level, system instructions, etc.)
 * and should use the user's original settings, not compaction defaults.
 */
type PreservedSendOptions = Pick<
  SendMessageOptions,
  | "thinkingLevel"
  | "additionalSystemInstructions"
  | "providerOptions"
  | "experiments"
  | "disableWorkspaceAgents"
>;

/**
 * Extract the send options that should be preserved across compaction.
 * Use this helper to avoid duplicating the field list when building CompactionFollowUpRequest.
 */
export function pickPreservedSendOptions(options: SendMessageOptions): PreservedSendOptions {
  return {
    thinkingLevel: options.thinkingLevel,
    additionalSystemInstructions: options.additionalSystemInstructions,
    providerOptions: options.providerOptions,
    experiments: options.experiments,
    disableWorkspaceAgents: options.disableWorkspaceAgents,
  };
}

/**
 * Content to send after compaction completes.
 * Extends CompactionFollowUpInput with model/agentId for the follow-up message,
 * plus preserved send options so the follow-up uses the same settings as the
 * original user message.
 *
 * These fields are required because compaction uses its own agentId ("compact")
 * and potentially a different model for summarization. The follow-up message
 * should use the user's original model, agentId, and send options.
 *
 * Call sites provide CompactionFollowUpInput; prepareCompactionMessage converts
 * it to CompactionFollowUpRequest by adding model/agentId/options from sendMessageOptions.
 */
export interface CompactionFollowUpRequest extends CompactionFollowUpInput, PreservedSendOptions {
  /** Model to use for the follow-up message (user's original model, not compaction model) */
  model: string;
  /** Agent ID for the follow-up message (user's original agentId, not "compact") */
  agentId: string;
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
  fileParts?: FilePart[];
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
  const hasFiles = opts.fileParts && opts.fileParts.length > 0;
  const hasReviews = opts.reviews && opts.reviews.length > 0;
  if (!hasText && !hasFiles && !hasReviews) return undefined;

  // Type assertion is safe here - this is the only factory for ContinueMessage
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const result: ContinueMessage = {
    text: opts.text ?? "",
    fileParts: opts.fileParts,
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
export type PersistedContinueMessage = Partial<
  Omit<ContinueMessage, typeof ContinueMessageBrand>
> & {
  /** @deprecated Legacy base mode persisted in older history entries. */
  mode?: AgentMode;
};

/**
 * True when the content is the default resume sentinel ("Continue")
 * with no attachments.
 */
export function isDefaultSourceContent(content?: Partial<UserMessageContent>): boolean {
  if (!content) return false;
  const text = typeof content.text === "string" ? content.text.trim() : "";
  const hasFiles = (content.fileParts?.length ?? 0) > 0;
  const hasReviews = (content.reviews?.length ?? 0) > 0;
  return text === "Continue" && !hasFiles && !hasReviews;
}

/** @deprecated Use isDefaultSourceContent. Legacy alias for backward compatibility. */
export const isDefaultContinueMessage = isDefaultSourceContent;

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

  const legacyMode = (persisted as { mode?: unknown }).mode;
  const legacyAgentId = legacyMode === "plan" || legacyMode === "exec" ? legacyMode : undefined;

  return buildContinueMessage({
    text: persisted.text,
    fileParts: persisted.fileParts,
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
  /** Content to send after compaction completes. Backend binds model/agentId at send time. */
  followUpContent?: CompactionFollowUpRequest;
}

/**
 * Process UserMessageContent into final message text and metadata.
 * Used by both normal send path and backend continue message processing.
 *
 * @param content - The user message content (text, attachments, reviews)
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

export interface BuildAgentSkillMetadataOptions {
  rawCommand: string;
  skillName: string;
  scope: AgentSkillScope;
  commandPrefix?: string;
}

export function buildAgentSkillMetadata(
  options: BuildAgentSkillMetadataOptions
): MuxFrontendMetadata {
  return {
    type: "agent-skill",
    rawCommand: options.rawCommand,
    commandPrefix: options.commandPrefix,
    skillName: options.skillName,
    scope: options.scope,
  };
}

/** Base fields common to all metadata types */
interface MuxFrontendMetadataBase {
  /** Structured review data for rich UI display (orthogonal to message type) */
  reviews?: ReviewNoteDataForDisplay[];
  /** Command prefix to highlight in UI (e.g., "/compact -m sonnet" or "/react-effects") */
  commandPrefix?: string;
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
        type: "compaction-summary";
        /**
         * Follow-up content to dispatch after compaction completes.
         * Stored on the summary so it survives crashes - the user message
         * persisted by dispatch serves as proof of completion.
         */
        pendingFollowUp?: CompactionFollowUpRequest;
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

export function getCompactionFollowUpContent(
  metadata?: MuxFrontendMetadata
): CompactionRequestData["followUpContent"] | undefined {
  // Keep follow-up extraction centralized so callers don't duplicate legacy handling.
  if (!metadata || metadata.type !== "compaction-request") {
    return undefined;
  }

  // Legacy compaction requests stored follow-up content in `continueMessage`.
  const parsed = metadata.parsed as CompactionRequestData & {
    continueMessage?: CompactionRequestData["followUpContent"];
  };
  return parsed.followUpContent ?? parsed.continueMessage;
}

/** Type for compaction-summary metadata variant */
export type CompactionSummaryMetadata = Extract<
  MuxFrontendMetadata,
  { type: "compaction-summary" }
>;

/** Type guard for compaction-summary metadata */
export function isCompactionSummaryMetadata(
  metadata: MuxFrontendMetadata | undefined
): metadata is CompactionSummaryMetadata {
  return metadata?.type === "compaction-summary";
}

// Our custom metadata type
export interface MuxMetadata {
  historySequence?: number; // Assigned by backend for global message ordering (required when writing to history)
  duration?: number;
  /** @deprecated Legacy base mode derived from agent definition. */
  mode?: AgentMode;
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
  agentId?: string; // Agent id active when this message was sent (assistant messages only)
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
    /**
     * YAML frontmatter for the resolved skill (no `---` delimiters).
     * Optional for backwards compatibility with older histories.
     */
    frontmatterYaml?: string;
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

// File part type for multimodal messages (matches AI SDK FileUIPart)
export interface MuxFilePart {
  type: "file";
  mediaType: string; // IANA media type, e.g., "image/png", "application/pdf"
  url: string; // Data URL (e.g., "data:application/pdf;base64,...") or hosted URL
  filename?: string; // Optional filename
}

// MuxMessage extends UIMessage with our metadata and custom parts
// Supports text, reasoning, file, and tool parts (including interrupted tool calls)
export type MuxMessage = Omit<UIMessage<MuxMetadata, never, never>, "parts"> & {
  parts: Array<MuxTextPart | MuxReasoningPart | MuxFilePart | MuxToolPart>;
};

// DisplayedMessage represents a single UI message block
// This is what the UI components consume, splitting complex messages into separate visual blocks
export type DisplayedMessage =
  | {
      type: "user";
      id: string; // Display ID for UI/React keys
      historyId: string; // Original MuxMessage ID for history operations
      content: string;
      /**
       * Command prefix to highlight in the UI (e.g. "/compact -m sonnet" or "/react-effects").
       * Only set when a slash command was processed.
       */
      commandPrefix?: string;
      fileParts?: FilePart[]; // Optional attachments
      historySequence: number; // Global ordering across all messages
      isSynthetic?: boolean;
      timestamp?: number;
      /** Present when this message invoked an agent skill via /{skill-name} */
      agentSkill?: {
        skillName: string;
        scope: AgentSkillScope;
        /**
         * Optional snapshot content attached later by message aggregation (e.g. tooltips).
         * Not persisted on the user message itself.
         */
        snapshot?: {
          frontmatterYaml?: string;
          body?: string;
        };
      };
      /** Present when this message is a /compact command */
      compactionRequest?: {
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
      agentId?: string; // Agent id active when this message was sent (assistant messages only)
      /** @deprecated Legacy base mode derived from agent definition. */
      mode?: AgentMode;
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
      /** Breakdown of omitted message types (when truncating for performance). */
      omittedMessageCounts?: {
        tool: number;
        reasoning: number;
      };
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

/** Convenience type alias for user-role DisplayedMessage */
export type DisplayedUserMessage = Extract<DisplayedMessage, { type: "user" }>;

export interface QueuedMessage {
  id: string;
  content: string;
  fileParts?: FilePart[];
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
