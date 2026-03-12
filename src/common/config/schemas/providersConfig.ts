import { z } from "zod";

import { ModelParametersByModelSchema } from "./modelParameters";
import { ProviderModelEntrySchema } from "./providerModelEntry";
import { OpenAICompatibleProvidersConfigSchema } from "./openaiCompatibleProvider";
import type { OpenAICompatibleProviderInstanceSchema } from "./openaiCompatibleProvider";

export const CacheTtlSchema = z.enum(["5m", "1h"]);
export const ServiceTierSchema = z.enum(["auto", "default", "flex", "priority"]);
export const CodexOauthDefaultAuthSchema = z.enum(["oauth", "apiKey"]);

export const BaseProviderConfigSchema = z
  .object({
    apiKey: z.string().optional(),
    apiKeyOpLabel: z.string().optional(),
    baseUrl: z.string().optional(),
    baseURL: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    models: z.array(ProviderModelEntrySchema).optional(),
    modelParameters: ModelParametersByModelSchema.optional(),
  })
  .passthrough();

export const AnthropicProviderConfigSchema = BaseProviderConfigSchema.extend({
  cacheTtl: CacheTtlSchema.optional(),
});

export const OpenAIProviderConfigSchema = BaseProviderConfigSchema.extend({
  serviceTier: ServiceTierSchema.optional(),
  organization: z.string().optional(),
  codexOauthDefaultAuth: CodexOauthDefaultAuthSchema.optional(),
  codexOauth: z.record(z.string(), z.unknown()).optional(),
  defaultModel: z.string().optional(),
  apiVersion: z.string().optional(),
});

export const BedrockProviderConfigSchema = BaseProviderConfigSchema.extend({
  region: z.string().optional(),
  profile: z.string().optional(),
  bearerToken: z.string().optional(),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
});

export const OpenRouterProviderConfigSchema = BaseProviderConfigSchema.extend({
  order: z.string().optional(),
  allow_fallbacks: z.boolean().optional(),
  only: z.array(z.string()).optional(),
  ignore: z.array(z.string()).optional(),
  require_parameters: z.boolean().optional(),
  data_collection: z.string().optional(),
  sort: z.string().optional(),
  quantizations: z.array(z.string()).optional(),
});

export const XAIProviderConfigSchema = BaseProviderConfigSchema.extend({
  searchParameters: z.record(z.string(), z.unknown()).optional(),
});

export const MuxGatewayProviderConfigSchema = BaseProviderConfigSchema.extend({
  couponCode: z.string().optional(),
  voucher: z.string().optional(),
});

export const GoogleProviderConfigSchema = BaseProviderConfigSchema;
export const DeepSeekProviderConfigSchema = BaseProviderConfigSchema;
export const OllamaProviderConfigSchema = BaseProviderConfigSchema;
export const GitHubCopilotProviderConfigSchema = BaseProviderConfigSchema;

export const ProvidersConfigSchema = z
  .object({
    anthropic: AnthropicProviderConfigSchema.optional(),
    openai: OpenAIProviderConfigSchema.optional(),
    bedrock: BedrockProviderConfigSchema.optional(),
    openrouter: OpenRouterProviderConfigSchema.optional(),
    xai: XAIProviderConfigSchema.optional(),
    "mux-gateway": MuxGatewayProviderConfigSchema.optional(),
    google: GoogleProviderConfigSchema.optional(),
    deepseek: DeepSeekProviderConfigSchema.optional(),
    ollama: OllamaProviderConfigSchema.optional(),
    "github-copilot": GitHubCopilotProviderConfigSchema.optional(),
    "openai-compatible": OpenAICompatibleProvidersConfigSchema.optional(),
  })
  .catchall(BaseProviderConfigSchema);

export type BaseProviderConfig = z.infer<typeof BaseProviderConfigSchema>;
export type AnthropicProviderConfig = z.infer<typeof AnthropicProviderConfigSchema>;
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderConfigSchema>;
export type BedrockProviderConfig = z.infer<typeof BedrockProviderConfigSchema>;
export type OpenRouterProviderConfig = z.infer<typeof OpenRouterProviderConfigSchema>;
export type XAIProviderConfig = z.infer<typeof XAIProviderConfigSchema>;
export type MuxGatewayProviderConfig = z.infer<typeof MuxGatewayProviderConfigSchema>;
export type GoogleProviderConfig = z.infer<typeof GoogleProviderConfigSchema>;
export type DeepSeekProviderConfig = z.infer<typeof DeepSeekProviderConfigSchema>;
export type OllamaProviderConfig = z.infer<typeof OllamaProviderConfigSchema>;
export type GitHubCopilotProviderConfig = z.infer<typeof GitHubCopilotProviderConfigSchema>;
export type OpenAICompatibleProvidersConfig = z.infer<typeof OpenAICompatibleProvidersConfigSchema>;
export type OpenAICompatibleProviderInstance = z.infer<
  typeof OpenAICompatibleProviderInstanceSchema
>;

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;
