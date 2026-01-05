import { describe, it, expect } from "bun:test";
import { findAvailableModel } from "./workspaceTitleGenerator";
import type { AIService } from "./aiService";
import type { LanguageModel } from "ai";
import type { Result } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";

type CreateModelResult = Result<LanguageModel, SendMessageError>;

// Helper to create a mock AIService that succeeds for specific models
function createMockAIService(availableModels: string[]): AIService {
  const service: Partial<AIService> = {
    createModel: (modelString: string): Promise<CreateModelResult> => {
      if (availableModels.includes(modelString)) {
        const result: CreateModelResult = { success: true, data: null as never };
        return Promise.resolve(result);
      }
      const err: CreateModelResult = {
        success: false,
        error: { type: "api_key_not_found", provider: "test" },
      };
      return Promise.resolve(err);
    },
  };
  return service as AIService;
}

describe("workspaceTitleGenerator", () => {
  describe("findAvailableModel", () => {
    it("returns null when no models available", async () => {
      const aiService = createMockAIService([]);
      expect(await findAvailableModel(aiService, ["model-a", "model-b"])).toBeNull();
    });

    it("returns null for empty models list", async () => {
      const aiService = createMockAIService(["any-model"]);
      expect(await findAvailableModel(aiService, [])).toBeNull();
    });

    it("returns first available model", async () => {
      const aiService = createMockAIService(["model-b", "model-c"]);
      const model = await findAvailableModel(aiService, ["model-a", "model-b", "model-c"]);
      expect(model).toBe("model-b");
    });

    it("tries models in order", async () => {
      const aiService = createMockAIService(["model-a", "model-b"]);
      const model = await findAvailableModel(aiService, ["model-a", "model-b"]);
      expect(model).toBe("model-a");
    });

    it("works with gateway-format models", async () => {
      const aiService = createMockAIService(["mux-gateway:anthropic/claude-haiku-4-5"]);
      const model = await findAvailableModel(aiService, [
        "anthropic:claude-haiku-4-5", // direct - unavailable
        "mux-gateway:anthropic/claude-haiku-4-5", // gateway - available
      ]);
      expect(model).toBe("mux-gateway:anthropic/claude-haiku-4-5");
    });
  });
});
