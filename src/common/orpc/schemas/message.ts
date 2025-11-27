import { z } from "zod";
import { ChatUsageDisplaySchema } from "./chatStats";
import { StreamErrorTypeSchema } from "./errors";

export const ImagePartSchema = z.object({
  url: z.string(),
  mediaType: z.string(),
});

export const MuxTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  timestamp: z.number().optional(),
});

export const MuxReasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  timestamp: z.number().optional(),
});

// Discriminated tool part schemas for proper type inference
export const DynamicToolPartAvailableSchema = z.object({
  type: z.literal("dynamic-tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  state: z.literal("output-available"),
  input: z.unknown(),
  output: z.unknown(),
  timestamp: z.number().optional(),
});

export const DynamicToolPartPendingSchema = z.object({
  type: z.literal("dynamic-tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  state: z.literal("input-available"),
  input: z.unknown(),
  timestamp: z.number().optional(),
});

export const DynamicToolPartSchema = z.discriminatedUnion("state", [
  DynamicToolPartAvailableSchema,
  DynamicToolPartPendingSchema,
]);

// Alias for backward compatibility - used in message schemas
export const MuxToolPartSchema = z.object({
  type: z.literal("dynamic-tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  state: z.enum(["input-available", "output-available"]),
  input: z.unknown(),
  output: z.unknown().optional(),
  timestamp: z.number().optional(),
});

export const MuxImagePartSchema = z.object({
  type: z.literal("file"),
  mediaType: z.string(),
  url: z.string(),
  filename: z.string().optional(),
});

// Export types inferred from schemas for reuse across app/test code.
export type ImagePart = z.infer<typeof ImagePartSchema>;
export type MuxImagePart = z.infer<typeof MuxImagePartSchema>;

// MuxMessage (simplified)
export const MuxMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(
    z.discriminatedUnion("type", [
      MuxTextPartSchema,
      MuxReasoningPartSchema,
      MuxToolPartSchema,
      MuxImagePartSchema,
    ])
  ),
  createdAt: z.date().optional(),
  metadata: z
    .object({
      historySequence: z.number().optional(),
      timestamp: z.number().optional(),
      model: z.string().optional(),
      usage: z.any().optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      duration: z.number().optional(),
      systemMessageTokens: z.number().optional(),
      muxMetadata: z.any().optional(),
      cmuxMetadata: z.any().optional(), // Legacy field for backward compatibility
      compacted: z.boolean().optional(), // Marks compaction summary messages
      toolPolicy: z.any().optional(),
      mode: z.string().optional(),
      partial: z.boolean().optional(),
      synthetic: z.boolean().optional(),
      error: z.string().optional(),
      errorType: StreamErrorTypeSchema.optional(),
      historicalUsage: ChatUsageDisplaySchema.optional(),
    })
    .optional(),
});

export const BranchListResultSchema = z.object({
  branches: z.array(z.string()),
  recommendedTrunk: z.string(),
});
