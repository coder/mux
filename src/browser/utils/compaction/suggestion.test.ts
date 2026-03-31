import { describe, expect, test } from "bun:test";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import type { ProvidersConfigMap } from "@/common/orpc/types";

import { getExplicitCompactionSuggestion } from "./suggestion";

const COPILOT_ONLY_PROVIDERS_CONFIG: ProvidersConfigMap = {
  "github-copilot": {
    apiKeySet: true,
    isEnabled: true,
    isConfigured: true,
    models: [KNOWN_MODELS.GPT_54_MINI.providerModelId],
  },
};

const COPILOT_ONLY_OPTIONS = {
  providersConfig: COPILOT_ONLY_PROVIDERS_CONFIG,
  policy: null,
  routePriority: ["direct"],
  routeOverrides: {},
};

describe("getExplicitCompactionSuggestion", () => {
  test("rejects explicit Copilot models missing from the authoritative catalog", () => {
    expect(
      getExplicitCompactionSuggestion({
        ...COPILOT_ONLY_OPTIONS,
        modelId: `github-copilot:${KNOWN_MODELS.GPT.providerModelId}`,
      })
    ).toBeNull();
  });

  test("keeps explicit Copilot models that the authoritative catalog exposes", () => {
    expect(
      getExplicitCompactionSuggestion({
        ...COPILOT_ONLY_OPTIONS,
        modelId: `github-copilot:${KNOWN_MODELS.GPT_54_MINI.providerModelId}`,
      })
    ).toMatchObject({
      kind: "preferred",
      modelId: `github-copilot:${KNOWN_MODELS.GPT_54_MINI.providerModelId}`,
    });
  });
});
