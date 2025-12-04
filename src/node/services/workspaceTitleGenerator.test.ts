import { describe, it, expect } from "bun:test";
import { getPreferredNameModel } from "./workspaceTitleGenerator";
import type { AIService } from "./aiService";
import { getKnownModel } from "@/common/constants/knownModels";

// Helper to create a mock AIService that succeeds for specific models
function createMockAIService(availableModels: string[]): AIService {
  return {
    createModel: async (modelString: string) => {
      if (availableModels.includes(modelString)) {
        return { success: true, data: {} as never };
      }
      return { success: false, error: { type: "api_key_not_found", provider: "test" } };
    },
  } as unknown as AIService;
}

describe("workspaceTitleGenerator", () => {
  const HAIKU_ID = getKnownModel("HAIKU").id;
  const GPT_MINI_ID = getKnownModel("GPT_MINI").id;

  it("getPreferredNameModel returns null when no models available", async () => {
    const aiService = createMockAIService([]);
    expect(await getPreferredNameModel(aiService)).toBeNull();
  });

  it("getPreferredNameModel prefers Haiku when available", async () => {
    const aiService = createMockAIService([HAIKU_ID, GPT_MINI_ID]);
    const model = await getPreferredNameModel(aiService);
    expect(model).toBe(HAIKU_ID);
  });

  it("getPreferredNameModel falls back to GPT Mini when Haiku unavailable", async () => {
    const aiService = createMockAIService([GPT_MINI_ID]);
    const model = await getPreferredNameModel(aiService);
    expect(model).toBe(GPT_MINI_ID);
  });
});
