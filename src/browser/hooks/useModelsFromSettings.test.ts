import { describe, expect, test } from "bun:test";
import { filterHiddenModels, getSuggestedModels } from "./useModelsFromSettings";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";

function countOccurrences(haystack: string[], needle: string): number {
  return haystack.filter((v) => v === needle).length;
}

describe("getSuggestedModels", () => {
  test("returns custom models first, then built-ins (deduped)", () => {
    const firstBuiltIn = Object.values(KNOWN_MODELS)[0];
    if (!firstBuiltIn) {
      throw new Error("KNOWN_MODELS unexpectedly empty");
    }
    const builtIn = firstBuiltIn.id;
    const [builtInProvider, builtInModelId] = builtIn.split(":", 2);
    if (!builtInProvider || !builtInModelId) {
      throw new Error(`Unexpected built-in model id: ${builtIn}`);
    }

    const config: ProvidersConfigMap = {
      openai: { apiKeySet: true, isConfigured: true, models: ["my-team-model"] },
      [builtInProvider]: { apiKeySet: true, isConfigured: true, models: [builtInModelId] },
      "mux-gateway": {
        apiKeySet: true,
        isConfigured: true,
        couponCodeSet: true,
        models: ["ignored"],
      },
    };

    const suggested = getSuggestedModels(config);

    // Custom models are listed first (in config order)
    expect(suggested[0]).toBe("openai:my-team-model");
    expect(suggested[1]).toBe(`${builtInProvider}:${builtInModelId}`);

    // mux-gateway models should never appear as selectable entries
    expect(suggested.some((m) => m.startsWith("mux-gateway:"))).toBe(false);

    // Built-ins should be present, but deduped against any custom entry
    expect(countOccurrences(suggested, builtIn)).toBe(1);
  });
});

describe("filterHiddenModels", () => {
  test("filters out hidden models", () => {
    expect(filterHiddenModels(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });
});
