/**
 * Tests for provider options builder
 */

import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { createMuxMessage } from "@/common/types/message";
import { describe, test, expect, mock } from "bun:test";
import {
  buildProviderOptions,
  buildRequestHeaders,
  isAnthropic1MEffectivelyEnabled,
  preserveAnthropic1MContextForFollowUp,
  resolveProviderOptionsNamespaceKey,
  ANTHROPIC_1M_CONTEXT_HEADER,
  MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER,
  MUX_WORKSPACE_ID_HEADER,
} from "./providerOptions";

// Mock the log module to avoid console noise
void mock.module("@/node/services/log", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
}));

function createMockProvidersConfig(mappings: Record<string, string>): ProvidersConfigMap {
  const config: ProvidersConfigMap = {};

  for (const [customModelId, baseModelId] of Object.entries(mappings)) {
    const [provider, modelId] = customModelId.split(":", 2);
    if (!provider || !modelId) {
      continue;
    }

    const existingProviderConfig = config[provider];
    config[provider] = {
      apiKeySet: existingProviderConfig?.apiKeySet ?? false,
      isEnabled: existingProviderConfig?.isEnabled ?? true,
      isConfigured: existingProviderConfig?.isConfigured ?? true,
      models: [
        ...(existingProviderConfig?.models ?? []),
        { id: modelId, mappedToModel: baseModelId },
      ],
    };
  }

  return config;
}

describe("resolveProviderOptionsNamespaceKey", () => {
  test("returns the canonical provider for direct routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai")).toBe("openai");
  });

  test("returns the canonical provider for same-provider routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "openai")).toBe("openai");
  });

  test("returns the canonical provider for passthrough gateways", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "mux-gateway")).toBe("openai");
  });

  test("returns the route provider for non-passthrough OpenRouter routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "openrouter")).toBe("openrouter");
  });

  test("returns the route provider for non-passthrough Copilot routing", () => {
    expect(resolveProviderOptionsNamespaceKey("openai", "github-copilot")).toBe("github-copilot");
  });
});

const baseAnthropicOptions = {
  disableParallelToolUse: false,
  sendReasoning: true,
};

function anthropicProviderOptions(
  result: ReturnType<typeof buildProviderOptions>
): Record<string, unknown> {
  return (result as Record<string, unknown>).anthropic as Record<string, unknown>;
}

describe("buildProviderOptions - Anthropic", () => {
  describe("Opus 4.5 (effort parameter)", () => {
    for (const { model, thinking, budgetTokens, effort } of [
      { model: "claude-opus-4-5", thinking: "medium", budgetTokens: 10000, effort: "medium" },
      { model: "claude-opus-4-5-20251101", thinking: "high", budgetTokens: 20000, effort: "high" },
    ] as const) {
      test(`uses effort and thinking parameters for ${model}`, () => {
        expect(buildProviderOptions(`anthropic:${model}`, thinking)).toEqual({
          anthropic: {
            ...baseAnthropicOptions,
            thinking: { type: "enabled", budgetTokens },
            effort,
          },
        });
      });
    }

    test("should use effort 'low' with no thinking when off for Opus 4.5", () => {
      expect(buildProviderOptions("anthropic:claude-opus-4-5", "off")).toEqual({
        anthropic: { ...baseAnthropicOptions, effort: "low" },
      });
    });
  });

  for (const model of ["claude-opus-4-6", "claude-sonnet-4-6"] as const) {
    describe(`${model} (adaptive thinking + effort)`, () => {
      for (const { thinking, expectedThinking, effort } of [
        { thinking: "medium", expectedThinking: { type: "adaptive" }, effort: "medium" },
        { thinking: "xhigh", expectedThinking: { type: "adaptive" }, effort: "max" },
        { thinking: "off", expectedThinking: { type: "disabled" }, effort: "low" },
      ] as const) {
        test(`maps ${thinking} to ${effort} effort`, () => {
          const anthropic = anthropicProviderOptions(
            buildProviderOptions(`anthropic:${model}`, thinking)
          );

          if (thinking === "medium") {
            expect(anthropic.disableParallelToolUse).toBe(false);
            expect(anthropic.sendReasoning).toBe(true);
          }
          expect(anthropic.thinking).toEqual(expectedThinking);
          expect(anthropic.effort).toBe(effort);
        });
      }
    });
  }

  describe("Other Anthropic models (thinking/budgetTokens)", () => {
    for (const { model, thinking, budgetTokens } of [
      { model: "claude-sonnet-4-5", thinking: "medium", budgetTokens: 10000 },
      { model: "claude-opus-4-1", thinking: "high", budgetTokens: 20000 },
      { model: "claude-haiku-4-5", thinking: "low", budgetTokens: 4000 },
    ] as const) {
      test(`should use thinking.budgetTokens for ${model}`, () => {
        expect(buildProviderOptions(`anthropic:${model}`, thinking)).toEqual({
          anthropic: {
            ...baseAnthropicOptions,
            thinking: { type: "enabled", budgetTokens },
          },
        });
      });
    }

    test("should omit thinking when thinking is off for non-Opus 4.5", () => {
      expect(buildProviderOptions("anthropic:claude-sonnet-4-5", "off")).toEqual({
        anthropic: baseAnthropicOptions,
      });
    });
  });

  describe("Anthropic cache TTL overrides", () => {
    for (const { name, model, thinking, cacheTtl, expected } of [
      {
        name: "should omit top-level cacheControl even when cache TTL is configured",
        model: "claude-sonnet-4-5",
        thinking: "off",
        cacheTtl: "1h",
        expected: baseAnthropicOptions,
      },
      {
        name: "should preserve Opus 4.6 reasoning options without top-level cacheControl",
        model: "claude-opus-4-6",
        thinking: "medium",
        cacheTtl: "5m",
        expected: { ...baseAnthropicOptions, thinking: { type: "adaptive" }, effort: "medium" },
      },
    ] as const) {
      test(name, () => {
        expect(
          buildProviderOptions(`anthropic:${model}`, thinking, undefined, undefined, {
            anthropic: { cacheTtl },
          })
        ).toEqual({ anthropic: expected });
      });
    }
  });

  describe("disableBetaFeatures", () => {
    for (const disableBetaFeatures of [true, false] as const) {
      test(`keeps omitting top-level cacheControl when disableBetaFeatures is ${disableBetaFeatures}`, () => {
        const anthropic = anthropicProviderOptions(
          buildProviderOptions("anthropic:claude-sonnet-4-5", "medium", undefined, undefined, {
            anthropic: { cacheTtl: "1h", disableBetaFeatures },
          })
        );

        expect(anthropic.cacheControl).toBeUndefined();
        expect(anthropic.sendReasoning).toBe(true);
      });
    }
  });
});

describe("buildProviderOptions - mappedToModel resolution", () => {
  test("resolves custom alias to claude-sonnet-4-5 for thinking budget", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250514",
    });

    const result = buildProviderOptions(
      "anthropic:claude/sonnet",
      "medium",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providersConfig
    );

    expect(result).toEqual({
      anthropic: {
        disableParallelToolUse: false,
        sendReasoning: true,
        thinking: {
          type: "enabled",
          budgetTokens: 10000,
        },
      },
    });
  });

  test("resolves custom alias to claude-opus-4-6 for adaptive thinking", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/opus": "anthropic:claude-opus-4-6-20260219",
    });

    const result = buildProviderOptions(
      "anthropic:claude/opus",
      "high",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      providersConfig
    );
    const anthropic = (result as Record<string, unknown>).anthropic as Record<string, unknown>;

    expect(anthropic.thinking).toEqual({ type: "adaptive" });
    expect(anthropic.effort).toBe("high");
  });

  test("works without providersConfig (backward compat)", () => {
    const result = buildProviderOptions("anthropic:claude-sonnet-4-5-20250514", "medium");

    expect(result).toEqual({
      anthropic: {
        disableParallelToolUse: false,
        sendReasoning: true,
        thinking: {
          type: "enabled",
          budgetTokens: 10000,
        },
      },
    });
  });

  test("buildRequestHeaders resolves alias for 1M beta context header", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250929",
    });

    const result = buildRequestHeaders(
      "anthropic:claude/sonnet",
      { anthropic: { use1MContext: true } },
      undefined,
      providersConfig
    );

    expect(result).toEqual({ "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER });
  });
});

describe("isAnthropic1MEffectivelyEnabled", () => {
  test("returns true for beta-only Sonnet models with global 1M flag", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5", {
        anthropic: { use1MContext: true },
      })
    ).toBe(true);
  });

  test("returns true when use1MContextModels includes an alias mapped to a beta-only model", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250929",
    });

    expect(
      isAnthropic1MEffectivelyEnabled(
        "anthropic:claude/sonnet",
        {
          anthropic: { use1MContextModels: ["anthropic:claude/sonnet"] },
        },
        providersConfig
      )
    ).toBe(true);
  });

  test("returns false when beta features are disabled", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5", {
        anthropic: { use1MContext: true, disableBetaFeatures: true },
      })
    ).toBe(false);
  });

  test("returns false for native 1M models that no longer need the beta header", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-opus-4-6", {
        anthropic: { use1MContext: true },
      })
    ).toBe(false);
  });

  test("returns false for unsupported models", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-opus-4-1", {
        anthropic: { use1MContext: true },
      })
    ).toBe(false);
  });

  test("returns false when no 1M intent was provided", () => {
    expect(
      isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5", {
        anthropic: {},
      })
    ).toBe(false);
  });

  test("returns false when provider options are missing", () => {
    expect(isAnthropic1MEffectivelyEnabled("anthropic:claude-sonnet-4-5")).toBe(false);
  });
});

describe("preserveAnthropic1MContextForFollowUp", () => {
  test("preserves beta 1M for alias source model when providersConfig resolves to a beta-only model", () => {
    const providersConfig = createMockProvidersConfig({
      "anthropic:claude/sonnet": "anthropic:claude-sonnet-4-5-20250929",
    });

    const result = preserveAnthropic1MContextForFollowUp(
      "anthropic:claude/sonnet",
      "anthropic:claude-sonnet-4-5",
      {
        anthropic: {
          use1MContextModels: ["anthropic:claude/sonnet"],
        },
      },
      providersConfig
    );

    expect(result?.anthropic?.use1MContext).toBe(true);
  });

  test("does not preserve beta 1M for alias source model without providersConfig", () => {
    const result = preserveAnthropic1MContextForFollowUp(
      "anthropic:claude/sonnet",
      "anthropic:claude-sonnet-4-5",
      {
        anthropic: {
          use1MContextModels: ["anthropic:claude/sonnet"],
        },
      }
    );

    expect(result?.anthropic?.use1MContext).not.toBe(true);
  });
});

describe("buildProviderOptions - OpenAI", () => {
  // Helper to extract OpenAI options from the result
  const getOpenAIOptions = (
    result: ReturnType<typeof buildProviderOptions>
  ): OpenAIResponsesProviderOptions | undefined => {
    if ("openai" in result) {
      return result.openai;
    }
    return undefined;
  };

  test("keeps provider-level parallel tool calls enabled for Responses models", () => {
    const result = buildProviderOptions("openai:gpt-5.2", "medium", undefined, undefined, {
      openai: { wireFormat: "responses" },
    });
    const openai = getOpenAIOptions(result);

    expect(openai).toBeDefined();
    expect(openai!.parallelToolCalls).toBe(true);
  });

  describe("store option", () => {
    test("should include store: false when muxProviderOptions sets store to false", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { store: false },
      });
      const openai = (result as Record<string, unknown>).openai as Record<string, unknown>;
      expect(openai.store).toBe(false);
    });

    test("should not include store key when muxProviderOptions.openai.store is undefined", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: {},
      });
      const openai = (result as Record<string, unknown>).openai as Record<string, unknown>;
      expect("store" in openai).toBe(false);
    });

    test("should include store: true when explicitly set", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { store: true },
      });
      const openai = (result as Record<string, unknown>).openai as Record<string, unknown>;
      expect(openai.store).toBe(true);
    });
  });

  describe("serviceTier option", () => {
    test("should not include serviceTier key when muxProviderOptions is omitted", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(false);
    });

    test("should not include serviceTier key when muxProviderOptions.openai.serviceTier is undefined", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { serviceTier: undefined },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(false);
    });

    test("should include serviceTier: auto when explicitly set", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { serviceTier: "auto" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(true);
      expect(openai!.serviceTier).toBe("auto");
    });

    test("should include explicit non-auto serviceTier", () => {
      const result = buildProviderOptions("openai:gpt-5", "medium", undefined, undefined, {
        openai: { serviceTier: "flex" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect("serviceTier" in openai!).toBe(true);
      expect(openai!.serviceTier).toBe("flex");
    });
  });

  describe("promptCacheKey derivation", () => {
    test("should prefer promptCacheScope over workspaceId for promptCacheKey", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "workspace-abc123",
        undefined,
        undefined,
        undefined,
        "my-project-deadbeef"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-my-project-deadbeef");
      expect(openai!.truncation).toBe("disabled");
    });

    test("should fall back to workspaceId when projectName is not provided", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "abc123"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-abc123");
      expect(openai!.truncation).toBe("disabled");
    });

    test("should allow auto truncation when explicitly enabled", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "compaction-workspace",
        "auto"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBe("auto");
    });
    test("should derive promptCacheKey for gateway OpenAI model with promptCacheScope", () => {
      const result = buildProviderOptions(
        "mux-gateway:openai/gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "workspace-xyz",
        undefined,
        undefined,
        undefined,
        "gateway-project-cafebabe"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.promptCacheKey).toBe("mux-v1-gateway-project-cafebabe");
      expect(openai!.truncation).toBe("disabled");
    });
  });

  describe("route provider format selection", () => {
    test("uses the transforming route provider format for gateway-routed OpenAI models", () => {
      const result = buildProviderOptions(
        "mux-gateway:openai/gpt-5.2",
        "medium",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "openrouter"
      );

      expect(result).toEqual({
        openrouter: {
          reasoning: {
            enabled: true,
            effort: "medium",
            exclude: false,
          },
        },
      });
    });

    test("falls back to the canonical origin provider format when routeProvider is absent", () => {
      const result = buildProviderOptions("mux-gateway:openai/gpt-5.2", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect("openrouter" in result).toBe(false);
    });

    test("uses the resolved gateway namespace for Copilot-routed OpenAI reasoning controls", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "medium",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "github-copilot"
      );

      expect(result).toEqual({
        "github-copilot": {
          reasoningEffort: "medium",
        },
      });
    });

    test("returns no Copilot-routed OpenAI provider options when thinking is off", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "github-copilot"
      );

      expect(result).toEqual({});
    });

    test("omits Responses-only OpenAI fields for Copilot-routed OpenAI models", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "medium",
        undefined,
        undefined,
        undefined,
        "workspace-copilot",
        "auto",
        undefined,
        "github-copilot"
      ) as Record<string, unknown>;
      const copilotOptions = result["github-copilot"] as Record<string, unknown> | undefined;

      expect(copilotOptions).toEqual({ reasoningEffort: "medium" });
      expect(copilotOptions?.truncation).toBeUndefined();
      expect(copilotOptions?.reasoningSummary).toBeUndefined();
      expect(copilotOptions?.include).toBeUndefined();
      expect(copilotOptions?.promptCacheKey).toBeUndefined();
    });
  });

  describe("reasoning summary compatibility", () => {
    test("should include reasoningSummary for supported OpenAI reasoning models", () => {
      const result = buildProviderOptions("openai:gpt-5.2", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect(openai!.reasoningSummary).toBe("detailed");
      expect(openai!.include).toEqual(["reasoning.encrypted_content"]);
    });

    test("should omit reasoningSummary for gpt-5.3-codex-spark", () => {
      const result = buildProviderOptions("openai:gpt-5.3-codex-spark", "medium");
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect(openai!.reasoningSummary).toBeUndefined();
      expect(openai!.include).toEqual(["reasoning.encrypted_content"]);
    });
  });

  describe("OpenAI conversation state management", () => {
    test("does not reuse previousResponseId when Mux already sends explicit GPT-5.5 history", () => {
      const messages = [
        createMuxMessage("assistant-1", "assistant", "", {
          model: "mux-gateway:openai/gpt-5.5",
          providerMetadata: { openai: { responseId: "resp_123" } },
        }),
      ];
      const result = buildProviderOptions("mux-gateway:openai/gpt-5.5", "medium", messages);
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.previousResponseId).toBeUndefined();
    });
  });
  describe("wireFormat gating", () => {
    test("includes Responses-only fields by default when wireFormat is unset", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        undefined,
        "workspace-default"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBe("disabled");
      expect(openai!.promptCacheKey).toBe("mux-v1-workspace-default");
    });

    test("includes Responses-only fields when wireFormat is responses", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        {
          openai: { wireFormat: "responses" },
        },
        "workspace-responses"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBe("disabled");
      expect(openai!.promptCacheKey).toBe("mux-v1-workspace-responses");
    });

    test("omits Responses-only truncation and promptCacheKey when wireFormat is chatCompletions", () => {
      const result = buildProviderOptions(
        "openai:gpt-5.2",
        "off",
        undefined,
        undefined,
        {
          openai: { wireFormat: "chatCompletions" },
        },
        "workspace-chat"
      );
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.truncation).toBeUndefined();
      expect(openai!.promptCacheKey).toBeUndefined();
    });

    test("omits previousResponseId when wireFormat is chatCompletions", () => {
      const messages = [
        createMuxMessage("assistant-1", "assistant", "", {
          model: "openai:gpt-5.2",
          providerMetadata: { openai: { responseId: "resp_chat_123" } },
        }),
      ];
      const result = buildProviderOptions("openai:gpt-5.2", "medium", messages, undefined, {
        openai: { wireFormat: "chatCompletions" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.previousResponseId).toBeUndefined();
    });

    test("omits Responses-only reasoning fields but keeps reasoningEffort when wireFormat is chatCompletions", () => {
      const result = buildProviderOptions("openai:gpt-5.2", "medium", undefined, undefined, {
        openai: { wireFormat: "chatCompletions" },
      });
      const openai = getOpenAIOptions(result);

      expect(openai).toBeDefined();
      expect(openai!.reasoningEffort).toBe("medium");
      expect(openai!.reasoningSummary).toBeUndefined();
      expect(openai!.include).toBeUndefined();
    });
  });
});

describe("buildProviderOptions - Google", () => {
  test("maps Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps gateway Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("mux-gateway:google/gemini-3.5-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps namespaced Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:models/gemini-3.5-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps versioned Gemini 3.5 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash-001", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps Gemini 3.5 Flash medium to thinkingLevel medium with thoughts", () => {
    expect(buildProviderOptions("mux-gateway:google/gemini-3.5-flash", "medium")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "medium",
        },
      },
    });
  });

  test("uses mapped model capabilities for custom Gemini 3.5 Flash aliases", () => {
    const providersConfig = createMockProvidersConfig({
      "google:custom-flash": "google:gemini-3.5-flash",
    });

    expect(
      buildProviderOptions(
        "google:custom-flash",
        "off",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        providersConfig
      )
    ).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps non-preview Gemini 3 Flash off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3-flash", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps Gemini 3 Flash Preview off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3-flash-preview", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("maps versioned Gemini 3 Flash Preview off to minimal thinking without thoughts", () => {
    expect(buildProviderOptions("google:gemini-3-flash-preview-latest", "off")).toEqual({
      google: {
        thinkingConfig: {
          thinkingLevel: "minimal",
        },
      },
    });
  });

  test("defensively maps unsupported Gemini 3.5 Flash xhigh to high", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash", "xhigh")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    });
  });

  test("passes Gemini 3.1 Pro low through as thinkingLevel low with thoughts", () => {
    expect(buildProviderOptions("google:gemini-3.1-pro-preview", "low")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "low",
        },
      },
    });
  });

  test("defensively maps unsupported Gemini 3.5 Flash max to high", () => {
    expect(buildProviderOptions("google:gemini-3.5-flash", "max")).toEqual({
      google: {
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      },
    });
  });

  test("keeps Gemini 3.1 Pro off without provider thinking config", () => {
    expect(buildProviderOptions("google:gemini-3.1-pro-preview", "off")).toEqual({
      google: {
        thinkingConfig: undefined,
      },
    });
  });
});

describe("buildRequestHeaders", () => {
  for (const { name, model, options, expected } of [
    {
      name: "should return anthropic-beta header for beta-only Sonnet models with use1MContext",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
    {
      name: "should return anthropic-beta header for gateway-routed beta Anthropic model",
      model: "mux-gateway:anthropic/claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
    {
      name: "should return undefined for native 1M Anthropic models even when use1MContext is set",
      model: "anthropic:claude-opus-4-6",
      options: { anthropic: { use1MContext: true } },
      expected: undefined,
    },
    {
      name: "should return undefined when disableBetaFeatures is true even with use1MContext",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true, disableBetaFeatures: true } },
      expected: undefined,
    },
    {
      name: "should still return header when disableBetaFeatures is false",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: true, disableBetaFeatures: false } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
    {
      name: "should return undefined for non-Anthropic model",
      model: "openai:gpt-5.2",
      options: { anthropic: { use1MContext: true } },
      expected: undefined,
    },
    {
      name: "should return undefined when use1MContext is false",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContext: false } },
      expected: undefined,
    },
    {
      name: "should return undefined for unsupported model even with use1MContext",
      model: "anthropic:claude-opus-4-1",
      options: { anthropic: { use1MContext: true } },
      expected: undefined,
    },
    {
      name: "should return header when model is in use1MContextModels list",
      model: "anthropic:claude-sonnet-4-5",
      options: { anthropic: { use1MContextModels: ["anthropic:claude-sonnet-4-5"] } },
      expected: { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER },
    },
  ] as const) {
    test(name, () => {
      expect(
        buildRequestHeaders(model, options as Parameters<typeof buildRequestHeaders>[1])
      ).toEqual(expected);
    });
  }

  describe("Opus 4.7 xhigh effort override", () => {
    for (const { name, model, routeProvider, thinkingLevel, expected } of [
      {
        name: "emits override header when thinkingLevel=xhigh for Opus 4.7",
        model: "anthropic:claude-opus-4-7",
        routeProvider: undefined,
        thinkingLevel: "xhigh",
        expected: { [MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER]: "xhigh" },
      },
      {
        name: "emits override header for gateway-routed Opus 4.7 with xhigh (passthrough)",
        model: "mux-gateway:anthropic/claude-opus-4-7",
        routeProvider: "mux-gateway",
        thinkingLevel: "xhigh",
        expected: { [MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER]: "xhigh" },
      },
      {
        name: "emits override header for hypothetical Opus 4.8",
        // Detection should match future versions so xhigh doesn't silently collapse to max.
        model: "anthropic:claude-opus-4-8",
        routeProvider: undefined,
        thinkingLevel: "xhigh",
        expected: { [MUX_ANTHROPIC_EFFORT_OVERRIDE_HEADER]: "xhigh" },
      },
      {
        name: "does not emit override header for Opus 4.7 with thinkingLevel=max",
        model: "anthropic:claude-opus-4-7",
        routeProvider: undefined,
        thinkingLevel: "max",
        expected: undefined,
      },
      {
        name: "does not emit override header for Opus 4.6 with xhigh",
        // Opus 4.6 maps xhigh -> "max" effort; SDK accepts "max" so no wire rewrite needed.
        model: "anthropic:claude-opus-4-6",
        routeProvider: undefined,
        thinkingLevel: "xhigh",
        expected: undefined,
      },
      {
        name: "does not emit override header for non-passthrough gateway (openrouter)",
        // Non-passthrough gateways must not receive this Mux-internal header.
        model: "anthropic:claude-opus-4-7",
        routeProvider: "openrouter",
        thinkingLevel: "xhigh",
        expected: undefined,
      },
    ] as const) {
      test(name, () => {
        expect(
          buildRequestHeaders(model, undefined, undefined, undefined, routeProvider, thinkingLevel)
        ).toEqual(expected);
      });
    }
  });

  for (const { name, model, options, workspaceId, expected } of [
    {
      name: "should include X-Mux-Workspace-Id for non-Anthropic provider when workspaceId provided",
      model: "openai:gpt-5.2",
      options: undefined,
      workspaceId: "a1b2c3d4e5",
      expected: { [MUX_WORKSPACE_ID_HEADER]: "a1b2c3d4e5" },
    },
    {
      name: "should encode non-header-safe workspace IDs before attaching request header",
      model: "openai:gpt-5.2",
      options: undefined,
      workspaceId: "workspace-😀",
      expected: {
        [MUX_WORKSPACE_ID_HEADER]: `b64:${Buffer.from("workspace-😀", "utf8").toString("base64url")}`,
      },
    },
    {
      name: "should include both X-Mux-Workspace-Id and anthropic-beta when both apply",
      model: "anthropic:claude-sonnet-4-20250514",
      options: { anthropic: { use1MContext: true } },
      workspaceId: "a1b2c3d4e5",
      expected: {
        [MUX_WORKSPACE_ID_HEADER]: "a1b2c3d4e5",
        "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER,
      },
    },
    {
      name: "should include X-Mux-Workspace-Id but not anthropic-beta for Anthropic without beta 1M intent",
      model: "anthropic:claude-sonnet-4-20250514",
      options: undefined,
      workspaceId: "deadbeef00",
      expected: { [MUX_WORKSPACE_ID_HEADER]: "deadbeef00" },
    },
  ] as const) {
    test(name, () => {
      expect(buildRequestHeaders(model, options, workspaceId)).toEqual(expected);
    });
  }

  test("should return undefined when no workspaceId and no provider-specific headers apply", () => {
    expect(buildRequestHeaders("openai:gpt-5.2")).toBeUndefined();
  });

  test("should return undefined when no muxProviderOptions provided", () => {
    expect(buildRequestHeaders("anthropic:claude-sonnet-4-5")).toBeUndefined();
  });
});
