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
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_vision?: boolean;
  supports_reasoning?: boolean;
  supports_response_schema?: boolean;
  knowledge_cutoff?: string;
  supported_endpoints?: string[];
}

export const modelsExtra: Record<string, ModelData> = {
  // Claude Opus 4.5 - Released November 2025
  // $15/M input, $75/M output (same pricing as Opus 4.1)
  "claude-opus-4-5": {
    max_input_tokens: 200000,
    max_output_tokens: 32000,
    input_cost_per_token: 0.000015, // $15 per million input tokens
    output_cost_per_token: 0.000075, // $75 per million output tokens
    cache_creation_input_token_cost: 0.00001875, // $18.75 per million tokens
    cache_read_input_token_cost: 0.0000015, // $1.50 per million tokens
    litellm_provider: "anthropic",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
  },

  // GPT-5 Pro - Released October 6, 2025 at DevDay
  // $15/M input, $120/M output
  // Only available via OpenAI's Responses API
  "gpt-5-pro": {
    max_input_tokens: 400000,
    max_output_tokens: 272000,
    input_cost_per_token: 0.000015, // $15 per million input tokens
    output_cost_per_token: 0.00012, // $120 per million output tokens
    litellm_provider: "openai",
    mode: "chat",
    supports_function_calling: true,
    supports_vision: true,
    supports_reasoning: true,
    supports_response_schema: true,
    knowledge_cutoff: "2024-09-30",
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
};
