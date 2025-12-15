import { z } from "zod";
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

// Base schema for tool parts - shared fields
const MuxToolPartBase = z.object({
  type: z.literal("dynamic-tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  timestamp: z.number().optional(),
});

// Discriminated tool part schemas - output required only when state is "output-available"
export const DynamicToolPartPendingSchema = MuxToolPartBase.extend({
  state: z.literal("input-available"),
});

export const DynamicToolPartAvailableSchema = MuxToolPartBase.extend({
  state: z.literal("output-available"),
  output: z.unknown(),
});

export const DynamicToolPartSchema = z.discriminatedUnion("state", [
  DynamicToolPartAvailableSchema,
  DynamicToolPartPendingSchema,
]);

// Alias for message schemas
export const MuxToolPartSchema = DynamicToolPartSchema;

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
      contextUsage: z.any().optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      contextProviderMetadata: z.record(z.string(), z.unknown()).optional(),
      duration: z.number().optional(),
      systemMessageTokens: z.number().optional(),
      muxMetadata: z.any().optional(),
      cmuxMetadata: z.any().optional(), // Legacy field for backward compatibility
      compacted: z.boolean().optional(), // Marks compaction summary messages
      idleCompacted: z.boolean().optional(), // Marks auto-compaction due to inactivity
      toolPolicy: z.any().optional(),
      mode: z.string().optional(),
      partial: z.boolean().optional(),
      synthetic: z.boolean().optional(),
      error: z.string().optional(),
      errorType: StreamErrorTypeSchema.optional(),
    })
    .optional(),
});

export const BranchListResultSchema = z.object({
  branches: z.array(z.string()),
  /** Recommended trunk branch, or null for non-git directories */
  recommendedTrunk: z.string().nullable(),
});
