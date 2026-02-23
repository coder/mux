/**
 * Extra models not yet in LiteLLM's official models.json
 * This file is consulted as a fallback when a model is not found in the main file.
 * Models should be removed from here once they appear in the upstream LiteLLM repository.
 */

interface ModelData {
  max_input_tokens: number;
  max_output_tokens?: number;
  input_cost_per_token: number;
  output_cost_per_token: number;
  input_cost_per_token_above_200k_tokens?: number;
  output_cost_per_token_above_200k_tokens?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_pdf_input?: boolean;
  max_pdf_size_mb?: number;
  supports_reasoning?: boolean;
  supports_response_schema?: boolean;
  knowledge_cutoff?: string;
  supported_endpoints?: string[];
}

export const modelsExtra: Record<string, ModelData> = {
  // Claude Opus 4.6 - Released February 2026
  // Standard: $5/M input, $25/M output (≤200k context)
  // Premium (1M context): $10/M input, $37.50/M output
  // 128K max output tokens
  "claude-opus-4-6": {
    max_input_tokens: 200000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens
    cache_read_input_token_cost: 0.0000005, // $0.50 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    // User-reported issue: Opus 4.6 should accept PDF attachments like other Claude 4.x models.
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Sonnet 4.6 - Released February 2026
  // $3/M input, $15/M output (same as Sonnet 4.5)
  // 64K max output tokens, supports adaptive thinking + effort parameter
  "claude-sonnet-4-6": {
    max_input_tokens: 200000,
    max_output_tokens: 64000,
    input_cost_per_token: 0.000003, // $3 per million input tokens
    output_cost_per_token: 0.000015, // $15 per million output tokens
    cache_creation_input_token_cost: 0.00000375, // $3.75 per million tokens
    cache_read_input_token_cost: 0.0000003, // $0.30 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Claude Opus 4.5 - Released November 24, 2025
  // $5/M input, $25/M output (price drop from Opus 4.1's $15/$75)
  // 64K max output tokens (matches Sonnet 4.5)
  "claude-opus-4-5": {
    max_input_tokens: 200000,
    max_output_tokens: 64000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens (estimated)
    cache_read_input_token_cost: 0.0000005, // $0.50 per million tokens (estimated)
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GPT-5.2 / GPT-5.2 Codex - keep aligned
  // LiteLLM reports 400k context for Codex, but it should match GPT-5.2 (272k)
  // $1.75/M input, $14/M output
  // Cached input: $0.175/M
  // Supports off, low, medium, high, xhigh reasoning levels
  "gpt-5.2": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    // OpenAI model page lists "cached input" pricing, which corresponds to prompt cache reads.
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-08-31",
  },
  "gpt-5.2-codex": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    // OpenAI model page lists "cached input" pricing, which corresponds to prompt cache reads.
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "responses",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Gemini 3.1 Pro Preview - Released February 19, 2026
  // Tiered pricing: ≤200K tokens $2/M input, $12/M output; >200K tokens $4/M input, $18/M output
  // 1M input context, ~64K max output tokens
  "gemini-3.1-pro-preview": {
    max_input_tokens: 1048576,
    max_output_tokens: 65535,
    input_cost_per_token: 0.000002, // $2 per million input tokens (≤200K)
    output_cost_per_token: 0.000012, // $12 per million output tokens (≤200K)
    input_cost_per_token_above_200k_tokens: 0.000004, // $4 per million input tokens (>200K)
    output_cost_per_token_above_200k_tokens: 0.000018, // $18 per million output tokens (>200K)
    cache_read_input_token_cost: 2e-7,
    litellm_provider: "vertex_ai-language-models",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2025-01",
  },

  // GPT-5.3-Codex - same pricing as gpt-5.2-codex
  "gpt-5.3-codex": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "responses",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GPT-5.3 Codex Spark - research preview (text-only) and currently available as 128k-context model
  // Pricing is not published separately; reuse GPT-5.3-Codex pricing until confirmed.
  "gpt-5.3-codex-spark": {
    max_input_tokens: 128000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.00000175, // $1.75 per million input tokens
    output_cost_per_token: 0.000014, // $14 per million output tokens
    cache_read_input_token_cost: 0.000000175, // $0.175 per million cached input tokens
    litellm_provider: "openai",
    mode: "responses",
    supports_function_calling: true,
    supports_vision: false,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GPT-5.2 Pro - Released December 11, 2025
  // $21/M input, $168/M output
  // Supports medium, high, xhigh reasoning levels
  "gpt-5.2-pro": {
    max_input_tokens: 272000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000021, // $21 per million input tokens
    output_cost_per_token: 0.000168, // $168 per million output tokens
    knowledge_cutoff: "2025-08-31",
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    supported_endpoints: ["/v1/responses"],
  },

  // Claude Haiku 4.5 - Released October 15, 2025
  // $1/M input, $5/M output
  "claude-haiku-4-5": {
    max_input_tokens: 200000,
    max_output_tokens: 8192,
    input_cost_per_token: 0.000001, // $1 per million input tokens
    output_cost_per_token: 0.000005, // $5 per million output tokens
    cache_creation_input_token_cost: 0.00000125, // $1.25 per million tokens
    cache_read_input_token_cost: 0.0000001, // $0.10 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_response_schema: true,
  },

  // Z.AI GLM 4.6 via OpenRouter
  // $0.40/M input, $1.75/M output (OpenRouter pricing)
  // 200K context window, supports tool use and reasoning
  "openrouter/z-ai/glm-4.6": {
    max_input_tokens: 202752,
    max_output_tokens: 202752,
    input_cost_per_token: 0.0000004, // $0.40 per million input tokens
    output_cost_per_token: 0.00000175, // $1.75 per million output tokens
    litellm_provider: "openrouter",
    mode: "chat",
    supports_function_calling: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GPT-5.1-Codex-Max - Extended reasoning model with xhigh support
  // Same pricing as gpt-5.1-codex: $1.25/M input, $10/M output
  // Supports 5 reasoning levels: off, low, medium, high, xhigh
  "gpt-5.1-codex-max": {
    max_input_tokens: 272000, // Same as gpt-5.1-codex
    max_output_tokens: 128000, // Same as gpt-5.1-codex
    input_cost_per_token: 0.00000125, // $1.25 per million input tokens
    output_cost_per_token: 0.00001, // $10 per million output tokens
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    supported_endpoints: ["/v1/responses"],
  },
};
