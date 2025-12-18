import { describe, expect, test, it } from "bun:test";
import { getModelStats } from "./modelStats";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

describe("getModelStats", () => {
  describe("direct model lookups", () => {
    test("should find anthropic models by direct name", () => {
      const stats = getModelStats(KNOWN_MODELS.OPUS.id);
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
      expect(stats?.input_cost_per_token).toBeGreaterThan(0);
    });

    test("should find openai models by direct name", () => {
      const stats = getModelStats(KNOWN_MODELS.GPT.id);
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });

    test("should find models in models-extra.ts", () => {
      const stats = getModelStats("openai:gpt-5-pro");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBe(400000);
      expect(stats?.input_cost_per_token).toBe(0.000015);
    });

    test("models-extra.ts should override models.json", () => {
      // gpt-5.2 exists in both files - models-extra.ts has correct 272k, models.json has incorrect 400k
      const stats = getModelStats("openai:gpt-5.2");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBe(272000); // models-extra.ts override
    });
  });

  describe("ollama model lookups with cloud suffix", () => {
    test("should find ollama gpt-oss:20b with cloud suffix", () => {
      const stats = getModelStats("ollama:gpt-oss:20b");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBe(131072);
      expect(stats?.input_cost_per_token).toBe(0); // Local models are free
      expect(stats?.output_cost_per_token).toBe(0);
    });

    test("should find ollama gpt-oss:120b with cloud suffix", () => {
      const stats = getModelStats("ollama:gpt-oss:120b");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBe(131072);
    });

    test("should find ollama deepseek-v3.1:671b with cloud suffix", () => {
      const stats = getModelStats("ollama:deepseek-v3.1:671b");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });
  });

  describe("ollama model lookups without cloud suffix", () => {
    test("should find ollama llama3.1 directly", () => {
      const stats = getModelStats("ollama:llama3.1");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });

    test("should find ollama llama3:8b with size variant", () => {
      const stats = getModelStats("ollama:llama3:8b");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });

    test("should find ollama codellama", () => {
      const stats = getModelStats("ollama:codellama");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });
  });

  describe("provider-prefixed lookups", () => {
    test("should find models with provider/ prefix", () => {
      // Some models in models.json use provider/ prefix
      const stats = getModelStats("ollama:llama2");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });
  });

  describe("unknown models", () => {
    test("should return null for completely unknown model", () => {
      const stats = getModelStats("unknown:fake-model-9000");
      expect(stats).toBeNull();
    });

    test("should return null for known provider but unknown model", () => {
      const stats = getModelStats("ollama:this-model-does-not-exist");
      expect(stats).toBeNull();
    });
  });

  describe("mux-gateway models", () => {
    test("should handle mux-gateway:anthropic/model format", () => {
      const stats = getModelStats("mux-gateway:anthropic/claude-sonnet-4-5");
      expect(stats).not.toBeNull();
      expect(stats?.input_cost_per_token).toBe(0.000003);
      expect(stats?.output_cost_per_token).toBe(0.000015);
    });

    test("should handle mux-gateway:openai/model format", () => {
      const stats = getModelStats("mux-gateway:openai/gpt-4o");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });

    test("should return null for mux-gateway with unknown model", () => {
      const stats = getModelStats("mux-gateway:anthropic/unknown-model-xyz");
      expect(stats).toBeNull();
    });
  });

  describe("model without provider prefix", () => {
    test("should handle model string without provider", () => {
      const stats = getModelStats("gpt-5.2");
      expect(stats).not.toBeNull();
      expect(stats?.max_input_tokens).toBeGreaterThan(0);
    });
  });

  describe("existing test cases", () => {
    it("should return model stats for claude-sonnet-4-5", () => {
      const stats = getModelStats(KNOWN_MODELS.SONNET.id);

      expect(stats).not.toBeNull();
      expect(stats?.input_cost_per_token).toBe(0.000003);
      expect(stats?.output_cost_per_token).toBe(0.000015);
      expect(stats?.max_input_tokens).toBe(200000);
    });

    it("should handle model without provider prefix", () => {
      const stats = getModelStats("claude-sonnet-4-5");

      expect(stats).not.toBeNull();
      expect(stats?.input_cost_per_token).toBe(0.000003);
    });

    it("should return cache pricing when available", () => {
      const stats = getModelStats(KNOWN_MODELS.SONNET.id);

      expect(stats?.cache_creation_input_token_cost).toBe(0.00000375);
      expect(stats?.cache_read_input_token_cost).toBe(3e-7);
    });

    it("should return null for unknown models", () => {
      const stats = getModelStats("unknown:model");

      expect(stats).toBeNull();
    });
  });

  describe("model data validation", () => {
    test("should include cache costs when available", () => {
      const stats = getModelStats(KNOWN_MODELS.OPUS.id);
      // Anthropic models have cache costs
      if (stats) {
        expect(stats.cache_creation_input_token_cost).toBeDefined();
        expect(stats.cache_read_input_token_cost).toBeDefined();
      }
    });

    test("should not include cache costs when unavailable", () => {
      const stats = getModelStats("ollama:llama3.1");
      // Ollama models don't have cache costs in models.json
      if (stats) {
        expect(stats.cache_creation_input_token_cost).toBeUndefined();
        expect(stats.cache_read_input_token_cost).toBeUndefined();
      }
    });
  });
});
