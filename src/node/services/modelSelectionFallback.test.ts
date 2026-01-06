/**
 * Unit tests for name generation model selection fallback.
 *
 * Tests verify that:
 * 1. When preferred models aren't available, we try OpenRouter variants
 * 2. When OpenRouter variants aren't available, we fallback to any configured model
 * 3. Model selection properly prioritizes the preference order
 */

import { selectModelForNameGeneration } from "@/node/services/workspaceTitleGenerator";
import type { AIService } from "@/node/services/aiService";
import { Ok, Err, type Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import type { LanguageModel } from "ai";

// Helper to create a mock AI service that only "succeeds" for specific models
function createMockAiService(availableModels: Set<string>): Pick<AIService, "createModel"> {
  return {
    createModel: jest.fn((modelId: string): Promise<Result<LanguageModel, SendMessageError>> => {
      if (availableModels.has(modelId)) {
        // Return a mock LanguageModel (we just need success status)
        return Promise.resolve(Ok({ modelId } as unknown as LanguageModel));
      }
      return Promise.resolve(Err({ type: "api_key_not_found", provider: modelId.split(":")[0] }));
    }),
  };
}

describe("selectModelForNameGeneration", () => {
  it("returns first available preferred model when configured", async () => {
    const mockService = createMockAiService(
      new Set(["anthropic:claude-haiku-4-5", "openai:gpt-5.1-codex-mini"])
    );

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5.1-codex-mini",
    ]);

    expect(result).toBe("anthropic:claude-haiku-4-5");
  });

  it("skips unavailable preferred models and tries next in list", async () => {
    // Only OpenAI is available
    const mockService = createMockAiService(new Set(["openai:gpt-5.1-codex-mini"]));

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5.1-codex-mini",
    ]);

    expect(result).toBe("openai:gpt-5.1-codex-mini");
  });

  it("tries OpenRouter variants when direct models aren't available", async () => {
    // Only OpenRouter variants are available
    const mockService = createMockAiService(
      new Set(["openrouter:anthropic/claude-haiku-4-5", "openrouter:openai/gpt-5.1-codex-mini"])
    );

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5.1-codex-mini",
    ]);

    // Should find OpenRouter variant of the first model
    expect(result).toBe("openrouter:anthropic/claude-haiku-4-5");
  });

  it("falls back to any available model when none of preferred are available", async () => {
    // Only Google is available, but preferred models are Anthropic/OpenAI
    const mockService = createMockAiService(new Set(["google:gemini-3-flash-preview"]));

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5.1-codex-mini",
    ]);

    // Should fallback to the available Google model
    expect(result).toBe("google:gemini-3-flash-preview");
  });

  it("returns null when no models are available at all", async () => {
    const mockService = createMockAiService(new Set()); // No models available

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5.1-codex-mini",
    ]);

    expect(result).toBeNull();
  });

  it("prefers direct provider over OpenRouter when both available", async () => {
    // Both direct Anthropic and OpenRouter are available
    const mockService = createMockAiService(
      new Set(["anthropic:claude-haiku-4-5", "openrouter:anthropic/claude-haiku-4-5"])
    );

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
    ]);

    // Direct provider should be preferred (it's first in the list)
    expect(result).toBe("anthropic:claude-haiku-4-5");
  });

  it("converts model IDs to OpenRouter format correctly", async () => {
    // Only OpenRouter is available
    const mockService = createMockAiService(new Set(["openrouter:anthropic/claude-haiku-4-5"]));

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
    ]);

    // Model ID should be converted: anthropic:claude-haiku-4-5 -> openrouter:anthropic/claude-haiku-4-5
    expect(result).toBe("openrouter:anthropic/claude-haiku-4-5");
  });

  it("tries Mux Gateway variants when direct models aren't available", async () => {
    // Only Mux Gateway is available (user has coupon but no direct API keys)
    const mockService = createMockAiService(new Set(["mux-gateway:anthropic/claude-haiku-4-5"]));

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5.1-codex-mini",
    ]);

    // Should find Mux Gateway variant
    expect(result).toBe("mux-gateway:anthropic/claude-haiku-4-5");
  });

  it("prefers Mux Gateway over OpenRouter when both available", async () => {
    // Both Mux Gateway and OpenRouter are available
    const mockService = createMockAiService(
      new Set(["mux-gateway:anthropic/claude-haiku-4-5", "openrouter:anthropic/claude-haiku-4-5"])
    );

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
    ]);

    // Mux Gateway should be preferred (tried before OpenRouter)
    expect(result).toBe("mux-gateway:anthropic/claude-haiku-4-5");
  });

  it("falls back to any known model when all preferred and gateway variants fail", async () => {
    // Only Grok is available
    const mockService = createMockAiService(new Set(["xai:grok-4-1-fast"]));

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
    ]);

    // Should fallback to the available Grok model
    expect(result).toBe("xai:grok-4-1-fast");
  });

  it("falls back to gateway variant of known model when direct is unavailable", async () => {
    // User has Mux Gateway configured but not direct Grok API key
    // Preferred models (Haiku, GPT-Mini) are also unavailable
    const mockService = createMockAiService(new Set(["mux-gateway:xai/grok-4-1-fast"]));

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
      "openai:gpt-5.1-codex-mini",
    ]);

    // Should fallback to Mux Gateway variant of Grok
    expect(result).toBe("mux-gateway:xai/grok-4-1-fast");
  });

  it("falls back to OpenRouter variant of known model when direct and gateway unavailable", async () => {
    // User only has OpenRouter configured
    const mockService = createMockAiService(new Set(["openrouter:xai/grok-4-1-fast"]));

    const result = await selectModelForNameGeneration(mockService as AIService, [
      "anthropic:claude-haiku-4-5",
    ]);

    // Should fallback to OpenRouter variant of Grok
    expect(result).toBe("openrouter:xai/grok-4-1-fast");
  });
});
