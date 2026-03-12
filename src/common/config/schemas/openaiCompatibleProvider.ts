import { z } from "zod";
import { ProviderModelEntrySchema } from "./providerModelEntry";

/**
 * Schema for a single OpenAI-compatible provider instance.
 * Each instance represents a separate API endpoint that uses the OpenAI-compatible API format.
 * Examples: Together AI, Fireworks, LM Studio, Jan, custom inference servers.
 */
export const OpenAICompatibleProviderInstanceSchema = z.object({
  /** Unique identifier for this provider instance (used in model strings like "openai-compatible/my-provider:model-id") */
  id: z.string().min(1),
  /** Display name shown in the UI */
  name: z.string().min(1),
  /** API key for authentication (optional for local servers) */
  apiKey: z.string().optional(),
  /** Human-readable label if apiKey is a 1Password reference */
  apiKeyOpLabel: z.string().optional(),
  /** Base URL for the API endpoint (required) */
  baseUrl: z.string().url(),
  /** Custom headers to send with each request */
  headers: z.record(z.string(), z.string()).optional(),
  /** Models available from this provider */
  models: z.array(ProviderModelEntrySchema).optional(),
  /** Whether this provider instance is enabled */
  enabled: z.boolean().optional(),
});

/**
 * Schema for the openai-compatible provider configuration.
 * Contains an array of provider instances, each with its own baseUrl, apiKey, and models.
 */
export const OpenAICompatibleProvidersConfigSchema = z.object({
  providers: z.array(OpenAICompatibleProviderInstanceSchema).optional(),
});

export type OpenAICompatibleProviderInstance = z.infer<
  typeof OpenAICompatibleProviderInstanceSchema
>;
export type OpenAICompatibleProvidersConfig = z.infer<typeof OpenAICompatibleProvidersConfigSchema>;
