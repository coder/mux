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

  test("does not inherit the Anthropic beta toggle from a mapped model", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    // Optional Anthropic beta 1M remains a runtime capability, not something a custom
    // runtime inherits just because its metadata maps to a Claude family. Native 1M models
    // still contribute their published context window through metadata.
    const mappedStats = getModelStats(KNOWN_MODELS.SONNET.id);
    const limit = getEffectiveContextLimit("ollama:custom", true, config);
    expect(limit).toBe(mappedStats?.max_input_tokens ?? null);
  });

  test("uses GPT-5.4's native 1.05M context without the 1M toggle", () => {
    const baseLimit = getEffectiveContextLimit(KNOWN_MODELS.GPT.id, false, null);
    const toggledLimit = getEffectiveContextLimit(KNOWN_MODELS.GPT.id, true, null);

    expect(baseLimit).toBe(1_050_000);
    expect(toggledLimit).toBe(1_050_000);
  });

  test("uses Claude Sonnet 4.6's native 1M context without the beta toggle", () => {
    const baseLimit = getEffectiveContextLimit(KNOWN_MODELS.SONNET.id, false, null);
    const toggledLimit = getEffectiveContextLimit(KNOWN_MODELS.SONNET.id, true, null);

    expect(baseLimit).toBe(1_000_000);
    expect(toggledLimit).toBe(1_000_000);
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
