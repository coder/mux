import { describe, expect, test } from "bun:test";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { getModelStats } from "@/common/utils/tokens/modelStats";
import { getEffectiveContextLimit } from "./contextLimit";

describe("getEffectiveContextLimit", () => {
  test("uses mapped model metadata for context limits", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    const mappedStats = getModelStats(KNOWN_MODELS.SONNET.id);
    expect(mappedStats).not.toBeNull();

    const limit = getEffectiveContextLimit("ollama:custom", false, config);
    expect(limit).toBe(mappedStats?.max_input_tokens ?? null);
  });

  test("applies 1M toggle for mapped models that support 1M context", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    const limit = getEffectiveContextLimit("ollama:custom", true, config);
    expect(limit).toBe(1_000_000);
  });

  test("prefers custom context overrides over mapped model stats", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [
          {
            id: "custom",
            contextWindowTokens: 123_456,
            mappedToModel: KNOWN_MODELS.SONNET.id,
          },
        ],
      },
    };

    const limit = getEffectiveContextLimit("ollama:custom", false, config);
    expect(limit).toBe(123_456);
  });
});
