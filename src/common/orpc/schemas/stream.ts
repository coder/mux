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
      usage: LanguageModelV2UsageSchema.optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
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
      usage: LanguageModelV2UsageSchema.optional(),
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

export const ToolCallEndEventSchema = z.object({
  type: z.literal("tool-call-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
});

export const ReasoningStartEventSchema = z.object({
  type: z.literal("reasoning-start"),
  workspaceId: z.string(),
  messageId: z.string(),
});

export const ReasoningDeltaEventSchema = z.object({
  type: z.literal("reasoning-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  tokens: z.number().meta({ description: "Token count for this delta" }),
  timestamp: z.number().meta({ description: "When delta was received (Date.now())" }),
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

export const UsageDeltaEventSchema = z.object({
  type: z.literal("usage-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  usage: LanguageModelV2UsageSchema.meta({
    description: "This step's usage (inputTokens = full context)",
  }),
});

export const WorkspaceInitEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init-start"),
    hookPath: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("init-output"),
    line: z.string(),
    timestamp: z.number(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("init-end"),
    exitCode: z.number(),
    timestamp: z.number(),
  }),
]);

export const QueuedMessageChangedEventSchema = z.object({
  type: z.literal("queued-message-changed"),
  workspaceId: z.string(),
  queuedMessages: z.array(z.string()),
  displayText: z.string(),
  imageParts: z.array(ImagePartSchema).optional(),
});

export const RestoreToInputEventSchema = z.object({
  type: z.literal("restore-to-input"),
  workspaceId: z.string(),
  text: z.string(),
  imageParts: z.array(ImagePartSchema).optional(),
});

// Order matters: z.union() tries schemas in order until one passes.
// Put discriminatedUnion first since streaming events (stream-delta, etc.)
// are most frequent and have a `type` field for O(1) lookup.
// MuxMessageSchema lacks `type`, so trying it first caused validation overhead.
export const WorkspaceChatMessageSchema = z.union([
  z.discriminatedUnion("type", [
    CaughtUpMessageSchema,
    StreamErrorMessageSchema,
    DeleteMessageSchema,
    StreamStartEventSchema,
    StreamDeltaEventSchema,
    StreamEndEventSchema,
    StreamAbortEventSchema,
    ToolCallStartEventSchema,
    ToolCallDeltaEventSchema,
    ToolCallEndEventSchema,
    ReasoningDeltaEventSchema,
    ReasoningEndEventSchema,
    UsageDeltaEventSchema,
    QueuedMessageChangedEventSchema,
    RestoreToInputEventSchema,
  ]),
  WorkspaceInitEventSchema,
  MuxMessageSchema,
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

// SendMessage options
export const SendMessageOptionsSchema = z.object({
  editMessageId: z.string().optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  model: z.string("No model specified"),
  toolPolicy: z.any().optional(), // Complex recursive type, skipping for now
  additionalSystemInstructions: z.string().optional(),
  maxOutputTokens: z.number().optional(),
  providerOptions: MuxProviderOptionsSchema.optional(),
  mode: z.string().optional(),
  muxMetadata: z.any().optional(), // Black box
});

// Re-export ChatUsageDisplaySchema for convenience
export { ChatUsageDisplaySchema };
