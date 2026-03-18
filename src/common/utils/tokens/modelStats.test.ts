import { describe, expect, test } from "bun:test";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { getModelStats, getModelStatsResolved, type ModelStats } from "./modelStats";

function expectStats(modelString: string): ModelStats {
  const stats = getModelStats(modelString);
  expect(stats).not.toBeNull();
  return stats!;
}

describe("getModelStats", () => {
  test("resolves representative known models by canonical id", () => {
    expect(expectStats(KNOWN_MODELS.OPUS.id).max_input_tokens).toBeGreaterThan(0);
    expect(expectStats(KNOWN_MODELS.GPT.id).max_input_tokens).toBeGreaterThan(0);
  });

  test("prefers models-extra overrides over models.json when both sources define a model", () => {
    // gpt-5.2-codex exists in both sources; the 272k context proves the override won.
    expect(expectStats("openai:gpt-5.2-codex").max_input_tokens).toBe(272000);
  });

  test.each([
    ["openai:gpt-5.4-2026-03-05", "openai:gpt-5.4"],
    ["mux-gateway:openai/gpt-5.4-pro-2026-03-05", "openai:gpt-5.4-pro"],
    ["mux-gateway:openai/gpt-5.4-mini-2026-03-11", "openai:gpt-5.4-mini"],
    ["mux-gateway:openai/gpt-5.4-nano-2026-03-17", "openai:gpt-5.4-nano"],
  ])("falls back from %s to the published %s family entry", (datedModel, canonicalModel) => {
    expect(expectStats(datedModel)).toEqual(expectStats(canonicalModel));
  });

  test("resolves GPT-5.4 nano with the published limits and pricing", () => {
    const stats = expectStats(KNOWN_MODELS.GPT_54_NANO.id);
    expect(stats.max_input_tokens).toBe(400000);
    expect(stats.max_output_tokens).toBe(128000);
    expect(stats.input_cost_per_token).toBe(0.0000002);
    expect(stats.cache_read_input_token_cost).toBe(0.00000002);
    expect(stats.output_cost_per_token).toBe(0.00000125);
    expect(stats.tiered_pricing_threshold_tokens).toBeUndefined();
  });

  test("defaults tiered pricing threshold to 200K when metadata only ships *_above_200k rates", () => {
    const stats = expectStats("google:gemini-3.1-pro-preview");
    expect(stats.tiered_pricing_threshold_tokens).toBe(200000);
    expect(stats.input_cost_per_token_above_200k_tokens).toBe(0.000004);
    expect(stats.output_cost_per_token_above_200k_tokens).toBe(0.000018);
  });

  test("normalizes mux-gateway provider/model ids before lookup", () => {
    expect(expectStats("mux-gateway:anthropic/claude-sonnet-4-5")).toEqual(
      expectStats("anthropic:claude-sonnet-4-5")
    );
  });

  test("supports bare model ids without a provider prefix", () => {
    expect(expectStats("gpt-5.2")).toEqual(expectStats("openai:gpt-5.2"));
  });

  test("resolves size-suffixed Ollama models via base/cloud fallback keys", () => {
    expect(expectStats("ollama:gpt-oss:20b").max_input_tokens).toBeGreaterThan(0);
  });

  test("uses provider-specific GitHub Copilot metadata and defaults missing costs to zero", () => {
    const stats = expectStats("github-copilot:gpt-4.1");
    expect(stats.input_cost_per_token).toBe(0);
    expect(stats.output_cost_per_token).toBe(0);
  });

  test("preserves cache fields only when metadata provides them", () => {
    const cached = expectStats(KNOWN_MODELS.OPUS.id);
    expect(cached.cache_creation_input_token_cost).toBeDefined();
    expect(cached.cache_read_input_token_cost).toBeDefined();

    const uncached = expectStats("ollama:llama3.1");
    expect(uncached.cache_creation_input_token_cost).toBeUndefined();
    expect(uncached.cache_read_input_token_cost).toBeUndefined();
  });

  test("returns null for unknown models across direct and gateway forms", () => {
    expect(getModelStats("unknown:fake-model-9000")).toBeNull();
    expect(getModelStats("ollama:this-model-does-not-exist")).toBeNull();
    expect(getModelStats("mux-gateway:anthropic/unknown-model-xyz")).toBeNull();
  });
});

describe("getModelStatsResolved", () => {
  test("returns mapped model stats when mapping exists", () => {
    const config: ProvidersConfigMap = {
      ollama: {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        models: [{ id: "custom", mappedToModel: KNOWN_MODELS.SONNET.id }],
      },
    };

    expect(getModelStatsResolved("ollama:custom", config)).toEqual(
      expectStats(KNOWN_MODELS.SONNET.id)
    );
  });

  test("returns null for unmapped unknown models", () => {
    expect(getModelStatsResolved("ollama:custom", null)).toBeNull();
  });
});
