/**
 * Extra models not yet in LiteLLM's official models.json.
 *
 * modelStats.ts checks this file first, so stale entries here will shadow fixed upstream data.
 * Keep this list as small as possible and remove entries as soon as upstream covers them.
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
  // KEEP: Upstream currently advertises 1M input for Opus 4.6, but Mux treats 1M as an
  // explicit beta opt-in that is only enabled when we send the Anthropic 1M header.
  // Without this override, the app assumes a 1M default context even when the toggle is
  // off, which breaks compaction/context-limit behavior and can cause provider rejections.
  "claude-opus-4-6": {
    max_input_tokens: 200000,
    max_output_tokens: 128000,
    input_cost_per_token: 0.000005, // $5 per million input tokens
    output_cost_per_token: 0.000025, // $25 per million output tokens
    cache_creation_input_token_cost: 0.00000625, // $6.25 per million tokens
    cache_read_input_token_cost: 0.0000005, // $0.50 per million cached input tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_pdf_input: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // Not present in LiteLLM upstream models.json as of 2026-02-23.
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

  // GPT-5.3 Codex Spark - research preview (text-only) and currently available as 128k-context model.
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
};
