import * as fs from "fs/promises";

import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { ImageModelV2 } from "@ai-sdk/provider";

import type { ImageGenerateToolResult } from "@/common/types/tools";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createImageGenerateTool } from "./image_generate";
import { TestTempDir, createTestToolConfig } from "./testHelpers";
import { Err, Ok } from "@/common/types/result";

const testPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVR4nGNgYPj/nzLMMGoAw2gYMIyGwf9hEAYAMqb+ENPK2kcAAAAASUVORK5CYII=";

function createMockImageModel(doGenerate: ImageModelV2["doGenerate"]): ImageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-image-model",
    maxImagesPerCall: 1,
    doGenerate,
  };
}

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

  test("reports OpenAI image token usage through the tool usage path", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    const reportedUsage: Array<{
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    }> = [];
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      reportModelUsage: (event) => {
        reportedUsage.push(event.usage);
      },
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [testPngBase64],
                  warnings: [],
                  response: { timestamp: new Date(), modelId: "test-image-model", headers: {} },
                  providerMetadata: {
                    openai: {
                      images: [{ textTokens: 7, imageTokens: 11 }],
                    },
                  },
                })
              )
            )
          ),
      },
    });

    const result = (await tool.execute!(
      { prompt: "A tiny square", n: 1 },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    expect(result.success).toBe(true);
    expect(reportedUsage).toEqual([{ inputTokens: 7, outputTokens: 11, totalTokens: 18 }]);
  });

  test("omits thumbnails from model-visible tool output", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => Promise.reject(new Error("not used")),
      },
    });

    const modelOutput = await tool.toModelOutput!({
      toolCallId: "image-tool-call",
      input: {},
      output: {
        success: true,
        model: "openai:gpt-image-1.5",
        prompt: "square",
        requestedCount: 1,
        images: [
          {
            path: "/tmp/image.png",
            filename: "image.png",
            mediaType: "image/png",
            thumbnail: {
              data: "large-base64",
              mediaType: "image/webp",
              width: 512,
              height: 512,
            },
          },
        ],
      },
    });

    expect(modelOutput).toEqual({
      type: "json",
      value: {
        success: true,
        model: "openai:gpt-image-1.5",
        prompt: "square",
        requestedCount: 1,
        images: [
          {
            path: "/tmp/image.png",
            filename: "image.png",
            mediaType: "image/png",
          },
        ],
      },
    });
  });

  test("rejects blank prompts before creating an image model", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    let createImageModelCalled = false;
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model for blank prompts"));
        },
      },
    });

    const result = (await tool.execute!(
      { prompt: "   " },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected blank prompt to fail");
    }
    expect(result.error).toContain("prompt is required");
    expect(createImageModelCalled).toBe(false);
  });

  test("returns actionable setup failures from image model creation", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      imageGenerationRuntime: {
        modelString: "google:imagen-test",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(Err({ type: "provider_not_supported", provider: "google" })),
      },
    });

    const result = (await tool.execute!(
      { prompt: "A small square" },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected provider setup failure");
    }
    expect(result.error).toContain("only supports OpenAI");
    expect(result.setupHint).toContain("openai:gpt-image-1.5");
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
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [testPngBase64],
                  warnings: [],
                  response: { timestamp: new Date(), modelId: "test-image-model", headers: {} },
                  providerMetadata: {},
                })
              )
            )
          ),
      },
    });

    const result = (await tool.execute!(
      { prompt: "A tiny square", n: 1, outputFormat: "jpeg" },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    if (!result.success) {
      throw new Error(`Expected image_generate to succeed, got ${result.error}`);
    }
    expect(result).toMatchObject({
      success: true,
      model: "openai:gpt-image-1.5",
      prompt: "A tiny square",
      requestedCount: 1,
    });
    expect(result.images).toHaveLength(1);
    const image = result.images[0];
    expect(image).toBeDefined();
    if (!image) {
      throw new Error("Expected a generated image result");
    }
    expect(image.path).toContain("generated_images/test-workspace/image-tool-call");
    expect(image.path).not.toContain("imagegen/image-tool-call");
    expect(image.filename).toBe("image-1.png");
    expect(image.mediaType).toBe("image/png");
    expect(image.thumbnail).toMatchObject({ mediaType: "image/webp", width: 16, height: 16 });
    const artifactStats = await fs.stat(image.path);
    expect(artifactStats.isFile()).toBe(true);
  });

  test("returns a setup hint when the provider image request fails", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(createMockImageModel(() => Promise.reject(new Error("rate limit exceeded"))))
          ),
      },
    });

    const result = (await tool.execute!(
      { prompt: "A tiny square", n: 1 },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected provider failure");
    }
    expect(result.error).toContain("rate limit exceeded");
    expect(result.setupHint).toContain("credentials, billing, rate limits, and content policy");
  });

  test("aborts artifact writes instead of closing partial files after write failures", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    let closeCalled = false;
    let abortCalled = false;

    class FailingWriteRuntime extends LocalRuntime {
      override writeFile(): WritableStream<Uint8Array> {
        return {
          getWriter: () => ({
            closed: Promise.resolve(undefined),
            desiredSize: 1,
            ready: Promise.resolve(undefined),
            write: () => Promise.reject(new Error("disk full")),
            close: () => {
              closeCalled = true;
              return Promise.resolve();
            },
            abort: () => {
              abortCalled = true;
              return Promise.resolve();
            },
            releaseLock: () => undefined,
          }),
        } as unknown as WritableStream<Uint8Array>;
      }
    }

    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path, {
        runtime: new FailingWriteRuntime(workspaceDir.path),
      }),
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [testPngBase64],
                  warnings: [],
                  response: { timestamp: new Date(), modelId: "test-image-model", headers: {} },
                  providerMetadata: {},
                })
              )
            )
          ),
      },
    });

    const result = (await tool.execute!(
      { prompt: "A tiny square", n: 1 },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    expect(result.success).toBe(false);
    expect(closeCalled).toBe(false);
    expect(abortCalled).toBe(true);
  });

  test("returns a setup hint when the AI SDK rejects a zero-image provider response", async () => {
    using workspaceDir = new TestTempDir("image-generate-workspace");
    const tool = createImageGenerateTool({
      ...createTestToolConfig(workspaceDir.path),
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [],
                  warnings: [],
                  response: { timestamp: new Date(), modelId: "test-image-model", headers: {} },
                  providerMetadata: {},
                })
              )
            )
          ),
      },
    });

    const result = (await tool.execute!(
      { prompt: "A tiny square", n: 1 },
      mockToolCallOptions
    )) as ImageGenerateToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected zero-image provider response to fail");
    }
    expect(result.error).toContain("No image generated");
    expect(result.setupHint).toContain("credentials, billing, rate limits, and content policy");
  });
});
