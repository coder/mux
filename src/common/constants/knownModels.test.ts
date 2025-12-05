/**
 * Integration test for known models - verifies all models exist in models.json
 *
 * This test does NOT go through IPC - it directly uses data from models.json
 * to verify that every providerModelId in KNOWN_MODELS exists.
 */

import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import modelsJson from "@/common/utils/tokens/models.json";
import { modelsExtra } from "@/common/utils/tokens/models-extra";

describe("Known Models Integration", () => {
  test("all known models exist in models.json", () => {
    const missingModels: string[] = [];

    for (const [key, model] of Object.entries(KNOWN_MODELS)) {
      const modelId = model.providerModelId;

      // Check if model exists in models.json or models-extra
      // xAI models are prefixed with "xai/" in models.json
      const lookupKey = model.provider === "xai" ? `xai/${modelId}` : modelId;
      if (!(lookupKey in modelsJson) && !(modelId in modelsExtra)) {
        missingModels.push(`${key}: ${model.provider}:${modelId}`);
      }
    }

    // Report all missing models at once for easier debugging
    if (missingModels.length > 0) {
      throw new Error(
        `The following known models are missing from models.json:\n${missingModels.join("\n")}\n\n` +
          `Run 'bun scripts/update_models.ts' to refresh models.json from LiteLLM.`
      );
    }
  });

  test("all known models have required metadata", () => {
    for (const [, model] of Object.entries(KNOWN_MODELS)) {
      const modelId = model.providerModelId;
      // xAI models are prefixed with "xai/" in models.json
      const lookupKey = model.provider === "xai" ? `xai/${modelId}` : modelId;
      const modelData = modelsJson[lookupKey as keyof typeof modelsJson] ?? modelsExtra[modelId];

      expect(modelData).toBeDefined();
      // Check that basic metadata fields exist (not all models have all fields)
      expect(typeof modelData.litellm_provider).toBe("string");
    }
  });
});
