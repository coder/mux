import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";

import type { ImageGenerateToolResult } from "@/common/types/tools";
import { createImageGenerateTool } from "./image_generate";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

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
        modelString: "openai:gpt-image-2",
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
});
