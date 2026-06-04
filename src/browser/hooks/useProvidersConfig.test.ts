import { describe, expect, test } from "bun:test";

import type { ProviderConfigInfo } from "@/common/orpc/types";
import { getOptimisticConfiguredProvider } from "./useProvidersConfig";

function providerConfig(overrides: Partial<ProviderConfigInfo> = {}): ProviderConfigInfo {
  return {
    apiKeySet: false,
    isEnabled: true,
    isConfigured: false,
    ...overrides,
  };
}

describe("getOptimisticConfiguredProvider", () => {
  test("requires custom provider base URL even when auth is present", () => {
    const withAuthOnly = getOptimisticConfiguredProvider(
      "custom-openai-compatible",
      providerConfig({
        apiKeySet: true,
        apiKeySource: "config",
        providerType: "openai-compatible",
        isCustom: true,
      })
    );

    expect(withAuthOnly.isConfigured).toBe(false);

    const withBaseUrl = getOptimisticConfiguredProvider(
      "custom-openai-compatible",
      providerConfig({
        apiKeySet: true,
        apiKeySource: "config",
        baseUrl: "https://models.example.test/v1",
        providerType: "openai-compatible",
        isCustom: true,
      })
    );

    expect(withBaseUrl.isConfigured).toBe(true);
  });

  test("mirrors Bedrock region-based configuredness instead of credential flags", () => {
    const credentialsWithoutRegion = getOptimisticConfiguredProvider(
      "bedrock",
      providerConfig({
        aws: {
          bearerTokenSet: true,
          accessKeyIdSet: true,
          secretAccessKeySet: true,
        },
      })
    );

    expect(credentialsWithoutRegion.isConfigured).toBe(false);

    const regionOnly = getOptimisticConfiguredProvider(
      "bedrock",
      providerConfig({
        aws: {
          region: "us-east-1",
          bearerTokenSet: false,
          accessKeyIdSet: false,
          secretAccessKeySet: false,
        },
      })
    );

    expect(regionOnly.isConfigured).toBe(true);
  });

  test("keeps keyless local providers tied to explicit base URL or model config", () => {
    const emptyOllama = getOptimisticConfiguredProvider("ollama", providerConfig());
    expect(emptyOllama.isConfigured).toBe(false);

    const withModel = getOptimisticConfiguredProvider(
      "ollama",
      providerConfig({ models: [{ id: "llama3.2" }] })
    );
    expect(withModel.isConfigured).toBe(true);
  });
});
