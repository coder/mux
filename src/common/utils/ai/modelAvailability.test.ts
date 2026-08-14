import { describe, expect, test } from "bun:test";

import type { ProvidersConfigMap } from "@/common/orpc/types";
import { isModelServableWithProvidersConfig } from "./modelAvailability";

const MODEL = "anthropic:claude-haiku-4-5";

function providers(entry: { isConfigured: boolean; isEnabled?: boolean }): ProvidersConfigMap {
  return { anthropic: entry } as unknown as ProvidersConfigMap;
}

describe("isModelServableWithProvidersConfig", () => {
  test("serves a model whose direct provider is configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(true);
  });

  test("rejects a model whose provider is not configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: false }),
      })
    ).toBe(false);
  });

  test("a disabled provider does not count as configured", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: ["direct"],
        providersConfig: providers({ isConfigured: true, isEnabled: false }),
      })
    ).toBe(false);
  });

  test("a configured provider outside the route priority list cannot serve", () => {
    // Availability must honor route priority (matching a real send), not just
    // "some provider somewhere is configured".
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        routePriority: [],
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(false);
  });

  test("route priority defaults to direct when omitted", () => {
    expect(
      isModelServableWithProvidersConfig({
        canonicalModel: MODEL,
        providersConfig: providers({ isConfigured: true }),
      })
    ).toBe(true);
  });

  describe("direct OpenAI credential gating", () => {
    function openaiProviders(entry: Record<string, unknown>): ProvidersConfigMap {
      return { openai: { isConfigured: true, ...entry } } as unknown as ProvidersConfigMap;
    }

    test("an OAuth-only config cannot serve an OAuth-ineligible model directly", () => {
      // gpt-5.5-pro is not in the Codex OAuth allowed set: with no API key the
      // factory would reject the direct route (api_key_not_found), so
      // availability must not claim it.
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5-pro",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ codexOauthSet: true }),
        })
      ).toBe(false);
    });

    test("an OAuth-only config serves OAuth-allowed models directly", () => {
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ codexOauthSet: true }),
        })
      ).toBe(true);
    });

    test("an API key serves OAuth-ineligible models directly", () => {
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.5-pro",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ apiKeySet: true }),
        })
      ).toBe(true);
    });

    test("an API key serves OAuth-preferred models too (factory falls back to the key)", () => {
      expect(
        isModelServableWithProvidersConfig({
          canonicalModel: "openai:gpt-5.3-codex-spark",
          routePriority: ["direct"],
          providersConfig: openaiProviders({ apiKeySet: true }),
        })
      ).toBe(true);
    });
  });
});
