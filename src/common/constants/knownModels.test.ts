/**
 * Integration test for known models — verifies every model in KNOWN_MODELS
 * resolves through the real getModelStats() lookup chain (models-extra → models.json).
 *
 * This catches:
 *  - A knownModels entry whose providerModelId doesn't exist anywhere
 *  - A models-extra pruning that removed an entry upstream doesn't cover yet
 *  - An upstream models.json update that drops a model we rely on
 */

import { describe, test, expect } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getModelStats } from "@/common/utils/tokens/modelStats";

describe("Known Models Integration", () => {
  test("all known models resolve via getModelStats()", () => {
    const missing: string[] = [];

    for (const [key, model] of Object.entries(KNOWN_MODELS)) {
      const stats = getModelStats(model.id);
      if (!stats) {
        missing.push(`${key}: ${model.id}`);
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `The following known models have no stats (not in models.json or models-extra):\n` +
          `${missing.join("\n")}\n\n` +
          `Either add the model to models-extra.ts or run 'bun scripts/update_models.ts' to refresh models.json.`
      );
    }
  });

  test("all known models have positive token limits and non-negative costs", () => {
    for (const [, model] of Object.entries(KNOWN_MODELS)) {
      const stats = getModelStats(model.id);
      // Existence is covered by the test above; skip if null to avoid noise.
      if (!stats) continue;

      expect(stats.max_input_tokens).toBeGreaterThan(0);
      expect(stats.input_cost_per_token).toBeGreaterThanOrEqual(0);
      expect(stats.output_cost_per_token).toBeGreaterThanOrEqual(0);
    }
  });
});
