import { z } from "zod";
import { ChatUsageDisplaySchema } from "./chatStats";
import { StreamErrorTypeSchema } from "./errors";
import {
  ImagePartSchema,
  MuxMessageSchema,
  MuxReasoningPartSchema,
  MuxTextPartSchema,
  MuxToolPartSchema,
} from "./message";
import { MuxProviderOptionsSchema } from "./providerOptions";

// Chat Events
export const CaughtUpMessageSchema = z.object({
  type: z.literal("caught-up"),
});

/** Sent when a workspace becomes eligible for idle compaction while connected */
export const IdleCompactionNeededEventSchema = z.object({
  type: z.literal("idle-compaction-needed"),
});

export const StreamErrorMessageSchema = z.object({
  type: z.literal("stream-error"),
  messageId: z.string(),
  error: z.string(),
  errorType: StreamErrorTypeSchema,
});

export const DeleteMessageSchema = z.object({
  type: z.literal("delete"),
  historySequences: z.array(z.number()),
});

export const StreamStartEventSchema = z.object({
  type: z.literal("stream-start"),
  workspaceId: z.string(),
  messageId: z.string(),
  model: z.string(),
  historySequence: z.number().meta({
    description: "Backend assigns global message ordering",
  }),
  startTime: z.number().meta({
    description: "Backend timestamp when stream started (Date.now())",
  }),
  mode: z.string().optional().meta({
    description: "Agent mode for this stream",
  }),
});

export const StreamDeltaEventSchema = z.object({
  type: z.literal("stream-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  tokens: z.number().meta({
    description: "Token count for this delta",
  }),
  timestamp: z.number().meta({
    description: "When delta was received (Date.now())",
  }),
});

export const CompletedMessagePartSchema = z.discriminatedUnion("type", [
  MuxReasoningPartSchema,
  MuxTextPartSchema,
  MuxToolPartSchema,
]);

// Match LanguageModelV2Usage from @ai-sdk/provider exactly
// Note: inputTokens/outputTokens/totalTokens use `number | undefined` (required key, value can be undefined)
// while reasoningTokens/cachedInputTokens use `?: number | undefined` (optional key)
export const LanguageModelV2UsageSchema = z.object({
  inputTokens: z
    .union([z.number(), z.undefined()])
    .meta({ description: "The number of input tokens used" }),
  outputTokens: z
    .union([z.number(), z.undefined()])
    .meta({ description: "The number of output tokens used" }),
  totalTokens: z.union([z.number(), z.undefined()]).meta({
    description:
      "Total tokens used - may differ from sum of inputTokens and outputTokens (e.g. reasoning tokens or overhead)",
  }),
  reasoningTokens: z
    .number()
    .optional()
    .meta({ description: "The number of reasoning tokens used" }),
  cachedInputTokens: z
    .number()
    .optional()
    .meta({ description: "The number of cached input tokens" }),
});

export const StreamEndEventSchema = z.object({
  type: z.literal("stream-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  metadata: z
    .object({
      model: z.string(),
      // Total usage across all steps (for cost calculation)
      usage: LanguageModelV2UsageSchema.optional(),
      // Last step's usage only (for context window display - inputTokens = current context size)
      contextUsage: LanguageModelV2UsageSchema.optional(),
      // Aggregated provider metadata across all steps (for cost calculation)
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      // Last step's provider metadata (for context window cache display)
      contextProviderMetadata: z.record(z.string(), z.unknown()).optional(),
      duration: z.number().optional(),
      systemMessageTokens: z.number().optional(),
      historySequence: z.number().optional().meta({
        description: "Present when loading from history",
      }),
      timestamp: z.number().optional().meta({
        description: "Present when loading from history",
      }),
    })
    .meta({
      description: "Structured metadata from backend - directly mergeable with MuxMetadata",
    }),
  parts: z.array(CompletedMessagePartSchema).meta({
    description: "Parts array preserves temporal ordering of reasoning, text, and tool calls",
  }),
});

export const StreamAbortEventSchema = z.object({
  type: z.literal("stream-abort"),
  workspaceId: z.string(),
  messageId: z.string(),
  metadata: z
    .object({
      // Total usage across all steps (for cost calculation)
      usage: LanguageModelV2UsageSchema.optional(),
      // Last step's usage (for context window display - inputTokens = current context size)
      contextUsage: LanguageModelV2UsageSchema.optional(),
      // Provider metadata for cost calculation (cache tokens, etc.)
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      // Last step's provider metadata (for context window cache display)
      contextProviderMetadata: z.record(z.string(), z.unknown()).optional(),
      duration: z.number().optional(),
    })
    .optional()
    .meta({
      description: "Metadata may contain usage if abort occurred after stream completed processing",
    }),
  abandonPartial: z.boolean().optional(),
});

export const ToolCallStartEventSchema = z.object({
  type: z.literal("tool-call-start"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  tokens: z.number().meta({ description: "Token count for tool input" }),
  timestamp: z.number().meta({ description: "When tool call started (Date.now())" }),
  parentToolCallId: z.string().optional().meta({ description: "Set for nested PTC calls" }),
});

export const ToolCallDeltaEventSchema = z.object({
  type: z.literal("tool-call-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  delta: z.unknown(),
  tokens: z.number().meta({ description: "Token count for this delta" }),
  timestamp: z.number().meta({ description: "When delta was received (Date.now())" }),
});

/**
 * UI-only incremental output from the bash tool.
 *
 * This is intentionally NOT part of the tool result returned to the model.
 * It is streamed over workspace.onChat so users can "peek" while the tool is running.
 */
export const BashOutputEventSchema = z.object({
  type: z.literal("bash-output"),
  workspaceId: z.string(),
  toolCallId: z.string(),
  text: z.string(),
  isError: z.boolean().meta({ description: "True if this chunk is from stderr" }),
  timestamp: z.number().meta({ description: "When output was flushed (Date.now())" }),
});
export const ToolCallEndEventSchema = z.object({
  type: z.literal("tool-call-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
  timestamp: z.number().meta({ description: "When tool call completed (Date.now())" }),
  parentToolCallId: z.string().optional().meta({ description: "Set for nested PTC calls" }),
});

export const ReasoningDeltaEventSchema = z.object({
  type: z.literal("reasoning-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  tokens: z.number().meta({ description: "Token count for this delta" }),
  timestamp: z.number().meta({ description: "When delta was received (Date.now())" }),
  signature: z
    .string()
    .optional()
    .meta({ description: "Anthropic thinking block signature for replay" }),
});

export const ReasoningEndEventSchema = z.object({
  type: z.literal("reasoning-end"),
  workspaceId: z.string(),
  messageId: z.string(),
});

export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  workspaceId: z.string(),
  messageId: z.string(),
  error: z.string(),
  errorType: StreamErrorTypeSchema.optional(),
});

/**
 * Emitted when a child workspace is deleted and its accumulated session usage has been
 * rolled up into the parent workspace.
 */
export const SessionUsageDeltaEventSchema = z.object({
  type: z.literal("session-usage-delta"),
  workspaceId: z.string().meta({ description: "Parent workspace ID" }),
  sourceWorkspaceId: z.string().meta({ description: "Deleted child workspace ID" }),
  byModelDelta: z.record(z.string(), ChatUsageDisplaySchema),
  timestamp: z.number(),
});
export const UsageDeltaEventSchema = z.object({
  type: z.literal("usage-delta"),
  workspaceId: z.string(),
  messageId: z.string(),

  // Step-level: this step only (for context window display)
  usage: LanguageModelV2UsageSchema,
  providerMetadata: z.record(z.string(), z.unknown()).optional(),

  // Cumulative: sum across all steps (for live cost display)
  cumulativeUsage: LanguageModelV2UsageSchema,
  cumulativeProviderMetadata: z.record(z.string(), z.unknown()).optional(),
});

// Individual init event schemas for flat discriminated union
export const InitStartEventSchema = z.object({
  type: z.literal("init-start"),
  hookPath: z.string(),
  timestamp: z.number(),
});

export const InitOutputEventSchema = z.object({
  type: z.literal("init-output"),
  line: z.string(),
  timestamp: z.number(),
  isError: z.boolean().optional(),
});

export const InitEndEventSchema = z.object({
  type: z.literal("init-end"),
  exitCode: z.number(),
  timestamp: z.number(),
  /** Number of lines dropped from middle when output exceeded limit (omitted if 0) */
  truncatedLines: z.number().optional(),
});

// Composite schema for backwards compatibility
export const WorkspaceInitEventSchema = z.discriminatedUnion("type", [
  InitStartEventSchema,
  InitOutputEventSchema,
  InitEndEventSchema,
]);

// Chat message wrapper with type discriminator for streaming events
// MuxMessageSchema is used for persisted data (chat.jsonl) which doesn't have a type field.
// This wrapper adds a type discriminator for real-time streaming events.
export const ChatMuxMessageSchema = MuxMessageSchema.extend({
  type: z.literal("message"),
});

// Review data schema for queued message display
export const ReviewNoteDataSchema = z.object({
  filePath: z.string(),
  lineRange: z.string(),
  selectedCode: z.string(),
  selectedDiff: z.string().optional(),
  oldStart: z.number().optional(),
  newStart: z.number().optional(),
  userNote: z.string(),
});

export const QueuedMessageChangedEventSchema = z.object({
  type: z.literal("queued-message-changed"),
  workspaceId: z.string(),
  queuedMessages: z.array(z.string()),
  displayText: z.string(),
  imageParts: z.array(ImagePartSchema).optional(),
  reviews: z.array(ReviewNoteDataSchema).optional(),
});

export const RestoreToInputEventSchema = z.object({
  type: z.literal("restore-to-input"),
  workspaceId: z.string(),
  text: z.string(),
  imageParts: z.array(ImagePartSchema).optional(),
});

// All streaming events now have a `type` field for O(1) discriminated union lookup.
// MuxMessages (user/assistant chat messages) are emitted with type: "message"
// when loading from history or sending new messages.
export const WorkspaceChatMessageSchema = z.discriminatedUnion("type", [
  // Stream lifecycle events
  CaughtUpMessageSchema,
  StreamErrorMessageSchema,
  DeleteMessageSchema,
  StreamStartEventSchema,
  StreamDeltaEventSchema,
  StreamEndEventSchema,
  StreamAbortEventSchema,
  // Tool events
  ToolCallStartEventSchema,
  ToolCallDeltaEventSchema,
  ToolCallEndEventSchema,
  BashOutputEventSchema,
  // Reasoning events
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  // Error events
  ErrorEventSchema,
  // Usage and queue events
  UsageDeltaEventSchema,
  SessionUsageDeltaEventSchema,
  QueuedMessageChangedEventSchema,
  RestoreToInputEventSchema,
  // Idle compaction notification
  IdleCompactionNeededEventSchema,
  // Init events
  ...WorkspaceInitEventSchema.def.options,
  // Chat messages with type discriminator
  ChatMuxMessageSchema,
]);

// Update Status
export const UpdateStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("checking") }),
  z.object({ type: z.literal("available"), info: z.object({ version: z.string() }) }),
  z.object({ type: z.literal("up-to-date") }),
  z.object({ type: z.literal("downloading"), percent: z.number() }),
  z.object({ type: z.literal("downloaded"), info: z.object({ version: z.string() }) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

// Tool policy schemas
export const ToolPolicyFilterSchema = z.object({
  regex_match: z.string().meta({
    description: 'Regex pattern to match tool names (e.g., "bash", "file_edit_.*", ".*")',
  }),
  action: z.enum(["enable", "disable", "require"]).meta({
    description: "Action to take when pattern matches",
  }),
});

export const ToolPolicySchema = z.array(ToolPolicyFilterSchema).meta({
  description:
    "Tool policy - array of filters applied in order. Default behavior is allow all tools.",
});

// Experiments schema for feature gating
export const ExperimentsSchema = z.object({
  postCompactionContext: z.boolean().optional(),
  programmaticToolCalling: z.boolean().optional(),
  programmaticToolCallingExclusive: z.boolean().optional(),
});

// SendMessage options
export const SendMessageOptionsSchema = z.object({
  editMessageId: z.string().optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high", "xhigh"]).optional(),
  model: z.string("No model specified"),
  toolPolicy: ToolPolicySchema.optional(),
  additionalSystemInstructions: z.string().optional(),
  maxOutputTokens: z.number().optional(),
  providerOptions: MuxProviderOptionsSchema.optional(),
  mode: z.string().optional(),
  muxMetadata: z.any().optional(), // Black box
  experiments: ExperimentsSchema.optional(),
});

// Re-export ChatUsageDisplaySchema for convenience
export { ChatUsageDisplaySchema };
