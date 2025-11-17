/**
 * Integration test for known models - verifies all models exist in models.json
 *
 * This test does NOT go through IPC - it directly uses data from models.json
 * to verify that every providerModelId in KNOWN_MODELS exists.
 */

import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import modelsJson from "@/common/utils/tokens/models.json";

describe("Known Models Integration", () => {
  test("all known models exist in models.json", () => {
    const missingModels: string[] = [];

    for (const [key, model] of Object.entries(KNOWN_MODELS)) {
      const modelId = model.providerModelId;
      const candidateModelIds = [modelId];

      if (model.provider === "xai") {
        candidateModelIds.push(`xai/${modelId}`);
      }

      const hasMatch = candidateModelIds.some((candidateId) => candidateId in modelsJson);

      // Check if model exists in models.json
      if (!hasMatch) {
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
    for (const model of Object.values(KNOWN_MODELS)) {
      const modelId = model.providerModelId;
      const candidateModelIds = [modelId];

      if (model.provider === "xai") {
        candidateModelIds.push(`xai/${modelId}`);
      }

      const modelDataEntry = candidateModelIds
        .map((candidateId) => modelsJson[candidateId as keyof typeof modelsJson])
        .find((entry) => entry !== undefined) as Record<string, unknown> | undefined;

      expect(modelDataEntry).toBeDefined();
      // Check that basic metadata fields exist (not all models have all fields)
      expect(typeof modelDataEntry?.litellm_provider).toBe("string");
    }
  });
});
