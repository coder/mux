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

  test("does not inherit 1M toggle from mapped model (provider-level capability)", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    // 1M context is a provider-level capability (Anthropic/Gemini), not
    // inherited through model mapping. ollama:custom should use the mapped
    // model's base context limit, not 1M.
    const mappedStats = getModelStats(KNOWN_MODELS.SONNET.id);
    const limit = getEffectiveContextLimit("ollama:custom", true, config);
    expect(limit).toBe(mappedStats?.max_input_tokens ?? null);
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
