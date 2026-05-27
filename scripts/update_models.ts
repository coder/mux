#!/usr/bin/env bun

/**
 * Downloads the latest model prices and context window data from LiteLLM
 * and saves the subset Mux consumes to src/common/utils/tokens/models.json.
 */

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUTPUT_PATH = "src/common/utils/tokens/models.json";

const RETAINED_FIELDS = [
  "max_input_tokens",
  "max_output_tokens",
  "input_cost_per_token",
  "output_cost_per_token",
  "output_cost_per_image_token",
  "input_cost_per_token_above_200k_tokens",
  "output_cost_per_token_above_200k_tokens",
  "cache_creation_input_token_cost",
  "cache_creation_input_token_cost_above_200k_tokens",
  "cache_read_input_token_cost",
  "cache_read_input_token_cost_above_200k_tokens",
  "tiered_pricing_threshold_tokens",
  "mode",
  "litellm_provider",
  "supports_pdf_input",
  "supports_vision",
  "supports_audio_input",
  "supports_video_input",
  "max_pdf_size_mb",
] as const;

function pruneModelData(data: unknown): Record<string, Record<string, unknown>> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Expected LiteLLM model metadata object");
  }

  const pruned: Record<string, Record<string, unknown>> = {};
  for (const [modelId, rawMetadata] of Object.entries(data)) {
    if (!rawMetadata || typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
      continue;
    }

    const metadata = rawMetadata as Record<string, unknown>;
    const retained: Record<string, unknown> = {};
    // Keep models.json small: Mux only reads pricing, token limits, provider, mode, and media
    // capability fields, while upstream LiteLLM ships many provider-specific fields we never use.
    for (const field of RETAINED_FIELDS) {
      if (metadata[field] !== undefined) {
        retained[field] = metadata[field];
      }
    }
    pruned[modelId] = retained;
  }

  return pruned;
}

async function updateModels() {
  console.log(`Fetching model data from ${LITELLM_URL}...`);

  const response = await fetch(LITELLM_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch model data: ${response.status} ${response.statusText}`);
  }

  const data = pruneModelData(await response.json());

  console.log(`Writing model data to ${OUTPUT_PATH}...`);
  await Bun.write(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`);

  console.log("✓ Model data updated successfully");
}

updateModels().catch((error) => {
  console.error("Error updating models:", error);
  process.exit(1);
});
