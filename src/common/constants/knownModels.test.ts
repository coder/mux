/**
 * Integration tests for the curated known-model registry.
 */

import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS, MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";
import modelsJson from "@/common/utils/tokens/models.json";
import { modelsExtra } from "@/common/utils/tokens/models-extra";

describe("Known Models Integration", () => {
  test("all known models exist in token metadata", () => {
    const missingModels: string[] = [];

    for (const [key, model] of Object.entries(KNOWN_MODELS)) {
      const modelId = model.providerModelId;

      // xAI models are prefixed with "xai/" in models.json.
      const lookupKey = model.provider === "xai" ? `xai/${modelId}` : modelId;
      if (!(lookupKey in modelsJson) && !(modelId in modelsExtra)) {
        missingModels.push(`${key}: ${model.provider}:${modelId}`);
      }
    }

    if (missingModels.length > 0) {
      throw new Error(
        `The following known models are missing from token metadata:\n${missingModels.join("\n")}\n\n` +
          `Run 'bun scripts/update_models.ts' to refresh models.json from LiteLLM.`
      );
    }
  });

  test("known model ids and aliases stay unique across the curated registry", () => {
    const seenIds = new Set<string>();
    const seenAliases = new Set<string>();

    for (const model of Object.values(KNOWN_MODELS)) {
      expect(seenIds.has(model.id)).toBe(false);
      seenIds.add(model.id);

      for (const alias of model.aliases ?? []) {
        expect(seenAliases.has(alias)).toBe(false);
        seenAliases.add(alias);
        expect(MODEL_ABBREVIATIONS[alias]).toBe(model.id);
      }
    }
  });
});
