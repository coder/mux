import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { ImageGenerateToolResult } from "@/common/types/tools";
import { createImageGenerateTool } from "./image_generate";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { Ok } from "@/common/types/result";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "image-tool-call",
  messages: [],
};

describe("image_generate tool", () => {
  test("rejects requests above the configured maximum image count", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    let createImageModelCalled = false;
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(
            new Error("should not create a provider model when count exceeds limit")
          );
        },
      },
    });

    const result = (await tool.execute!(
      { prompt: "A small blue square", n: 3 },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected image_generate to fail when n exceeds configured maximum");
    }
    expect(result.error).toContain("configured for a maximum of 2");
    expect(createImageModelCalled).toBe(false);
  });

  test("writes generated artifacts outside the stream temp directory", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok({
              specificationVersion: "v2",
              provider: "test",
              modelId: "test-image-model",
              maxImagesPerCall: 1,
              doGenerate: () =>
                Promise.resolve({
                  images: [
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lKrL7wAAAABJRU5ErkJggg==",
                  ],
                  warnings: [],
                  response: { timestamp: new Date(), modelId: "test-image-model", headers: {} },
                  providerMetadata: {},
                }),
            } as never)
          ),
      },
    });

    const result = (await tool.execute!(
      { prompt: "A tiny square", n: 1 },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    if (!result.success) {
      throw new Error(`Expected image_generate to succeed, got ${result.error}`);
    }
    expect(result.success).toBe(true);
    expect(result.images[0]?.path).toContain("generated_images/test-workspace/image-tool-call");
    expect(result.images[0]?.path).not.toContain("imagegen/image-tool-call");
  });
});
