#!/usr/bin/env bun

/**
 * Downloads the latest model prices and context window data from LiteLLM
 * and saves it to src/utils/tokens/models.json
 */

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OUTPUT_PATH = "src/common/utils/tokens/models.json";

async function updateModels() {
  console.log(`Fetching model data from ${LITELLM_URL}...`);

  const response = await fetch(LITELLM_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch model data: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  console.log(`Writing model data to ${OUTPUT_PATH}...`);
  await Bun.write(OUTPUT_PATH, JSON.stringify(data, null, 2));

  console.log("✓ Model data updated successfully");
}

updateModels().catch((error) => {
  console.error("Error updating models:", error);
  process.exit(1);
});
