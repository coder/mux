import * as fs from "fs/promises";
import * as path from "path";

import { describe, expect, test } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import type { ImageModelV2 } from "@ai-sdk/provider";

import type { ImageEditToolResult } from "@/common/types/tools";
import { Err, Ok } from "@/common/types/result";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { createImageEditTool } from "./image_edit";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const testPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVR4nGNgYPj/nzLMMGoAw2gYMIyGwf9hEAYAMqb+ENPK2kcAAAAASUVORK5CYII=";
const sharpInvalidPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lKrL7wAAAABJRU5ErkJggg==";
const testGifBytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const testPngBytes = Buffer.from(testPngBase64, "base64");

function createMockImageModel(doGenerate: ImageModelV2["doGenerate"]): ImageModelV2 {
  return {
    specificationVersion: "v2",
    provider: "test",
    modelId: "test-image-model",
    maxImagesPerCall: 10,
    doGenerate,
  };
}

class ImageEditTestRuntime extends LocalRuntime {
  constructor(
    projectPath: string,
    private readonly muxHome: string
  ) {
    super(projectPath);
  }

  override getMuxHome(): string {
    return this.muxHome;
  }
}

function createImageEditTestConfig(
  workspacePath: string,
  options?: Parameters<typeof createTestToolConfig>[1]
) {
  return createTestToolConfig(workspacePath, {
    ...options,
    runtime: options?.runtime ?? new ImageEditTestRuntime(workspacePath, workspacePath),
  });
}

let nextToolCallId = 0;
function createMockToolCallOptions(): ToolExecutionOptions {
  nextToolCallId += 1;
  return {
    toolCallId: `image-edit-call-${nextToolCallId}`,
    messages: [],
  };
}

describe("image_edit tool", () => {
  test("rejects blank prompts before reading source files or creating an image model", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
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
      { sourcePath: "missing.png", prompt: "   " },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected blank prompt to fail");
    }
    expect(result.error).toContain("prompt is required");
    expect(createImageModelCalled).toBe(false);
  });

  test("rejects requests above the configured maximum before reading source files", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model when count exceeds limit"));
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath: "missing.png", prompt: "Make variants", n: 3 },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected image_edit to fail when n exceeds configured maximum");
    }
    expect(result.error).toContain("configured for a maximum of 2");
    expect(createImageModelCalled).toBe(false);
  });

  test("rejects source directories before provider calls", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source-dir");
    await fs.mkdir(sourcePath);
    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model for directories"));
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected directory source to fail");
    }
    expect(result.error).toContain("Source image is a directory");
    expect(createImageModelCalled).toBe(false);
  });

  test("rejects oversized sources before reading file content", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);

    class OversizedStatRuntime extends LocalRuntime {
      override async stat(filePath: string, abortSignal?: AbortSignal) {
        const stat = await super.stat(filePath, abortSignal);
        return filePath === sourcePath ? { ...stat, size: 51 * 1024 * 1024 } : stat;
      }
    }

    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path, {
        runtime: new OversizedStatRuntime(workspaceDir.path),
      }),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model for oversized sources"));
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected oversized source to fail");
    }
    expect(result.error).toContain("exceeds the 50 MB");
    expect(createImageModelCalled).toBe(false);
  });

  test("returns a read error for missing source files before provider calls", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "missing.png");
    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model for missing sources"));
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected missing source to fail");
    }
    expect(result.error).toContain("Failed to read source image");
    expect(createImageModelCalled).toBe(false);
  });

  test("rejects decodable but unsupported image formats before provider calls", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "unsupported.gif");
    await fs.writeFile(sourcePath, testGifBytes);
    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model for unsupported formats"));
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected unsupported source image to fail");
    }
    expect(result.error).toContain("PNG, JPEG, or WebP");
    expect(createImageModelCalled).toBe(false);
  });

  test("rejects files that are not decodable supported images before provider calls", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "not-an-image.png");
    await fs.writeFile(sourcePath, "this is not image data");
    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model for invalid source images"));
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make the square blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid source image to fail");
    }
    expect(result.error).toContain("Source image");
    expect(createImageModelCalled).toBe(false);
  });

  test("returns a user-facing error when source size changes during read", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);

    class StaleStatRuntime extends LocalRuntime {
      override async stat(filePath: string, abortSignal?: AbortSignal) {
        const stat = await super.stat(filePath, abortSignal);
        return filePath === sourcePath ? { ...stat, size: stat.size + 1 } : stat;
      }
    }

    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path, {
        runtime: new StaleStatRuntime(workspaceDir.path),
      }),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(new Error("should not create a model for stale source reads"));
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make the square blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected stale source read to fail");
    }
    expect(result.error).toContain("Source image was modified");
    expect(createImageModelCalled).toBe(false);
  });

  test("returns actionable setup failures from image model creation", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "google:imagen-test",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(Err({ type: "provider_not_supported", provider: "google" })),
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected provider setup failure");
    }
    expect(result.error).toContain("only supports OpenAI");
  });

  test("returns provider errors when image editing generation fails", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(createMockImageModel(() => Promise.reject(new Error("provider exploded"))))
          ),
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected provider generation failure");
    }
    expect(result.error).toContain("Image editing failed");
    expect(result.error).toContain("provider exploded");
  });

  test("does not write edited artifacts when output dimensions cannot be read", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [Buffer.from("not an image").toString("base64")],
                  warnings: [],
                  response: { timestamp: new Date(), modelId: "test-image-model", headers: {} },
                  providerMetadata: {},
                })
              )
            )
          ),
      },
    });

    const toolCallOptions = createMockToolCallOptions();
    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      toolCallOptions
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid provider image to fail");
    }
    expect(result.error).toContain("Edited image dimensions could not be read");
    let artifactExists = true;
    try {
      await fs.access(
        path.join(
          workspaceDir.path,
          `edited_images/test-workspace/${toolCallOptions.toolCallId}/image-1.png`
        )
      );
    } catch {
      artifactExists = false;
    }
    expect(artifactExists).toBe(false);
  });

  test("stops reading sources that exceed the upload limit despite a stale stat", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);

    let readCanceled = false;
    class UnboundedReadRuntime extends LocalRuntime {
      override async stat(filePath: string, abortSignal?: AbortSignal) {
        const stat = await super.stat(filePath, abortSignal);
        return filePath === sourcePath ? { ...stat, size: 0 } : stat;
      }

      override readFile(filePath: string, abortSignal?: AbortSignal): ReadableStream<Uint8Array> {
        if (filePath !== sourcePath) {
          return super.readFile(filePath, abortSignal);
        }

        let emittedBytes = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (abortSignal?.aborted) {
              controller.error(new Error("aborted"));
              return;
            }
            emittedBytes += 1024 * 1024;
            controller.enqueue(new Uint8Array(1024 * 1024));
            if (emittedBytes > 51 * 1024 * 1024) {
              controller.close();
            }
          },
          cancel() {
            readCanceled = true;
          },
        });
      }
    }

    let createImageModelCalled = false;
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path, {
        runtime: new UnboundedReadRuntime(workspaceDir.path),
      }),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => {
          createImageModelCalled = true;
          return Promise.reject(
            new Error("should not create a model for oversized source streams")
          );
        },
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected oversized source stream to fail");
    }
    expect(result.error).toContain("Stream exceeded");
    expect(readCanceled).toBe(true);
    expect(createImageModelCalled).toBe(false);
  });

  test("cleans up earlier edited artifacts when a later output image is invalid", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [testPngBase64, Buffer.from("not an image").toString("base64")],
                  warnings: [],
                  response: { timestamp: new Date(), modelId: "test-image-model", headers: {} },
                  providerMetadata: {},
                })
              )
            )
          ),
      },
    });

    const toolCallOptions = createMockToolCallOptions();
    const result = (await tool.execute!(
      { sourcePath, prompt: "Make it blue", n: 2 },
      toolCallOptions
    )) as ImageEditToolResult;

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected invalid second provider image to fail");
    }
    expect(result.error).toContain("Edited image dimensions could not be read");
    let firstArtifactExists = true;
    try {
      await fs.access(
        path.join(
          workspaceDir.path,
          `edited_images/test-workspace/${toolCallOptions.toolCallId}/image-1.png`
        )
      );
    } catch {
      firstArtifactExists = false;
    }
    expect(firstArtifactExists).toBe(false);
  });

  test("writes multiple edited artifacts with per-image thumbnails", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 4,
        createImageModel: () =>
          Promise.resolve(
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [testPngBase64, testPngBase64],
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
      { sourcePath, prompt: "Two tiny squares", n: 2 },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    if (!result.success) {
      throw new Error(`Expected image_edit to succeed, got ${result.error}`);
    }
    expect(result.requestedCount).toBe(2);
    expect(result.images).toHaveLength(2);
    expect(result.images.map((image) => image.filename)).toEqual(["image-1.png", "image-2.png"]);
    expect(result.images.map((image) => image.outputDimensions)).toEqual([
      { width: 16, height: 16 },
      { width: 16, height: 16 },
    ]);
    expect(result.images.every((image) => image.thumbnail?.mediaType === "image/webp")).toBe(true);
    await Promise.all(result.images.map((image) => fs.stat(image.path)));
  });

  test("keeps edited image results when thumbnail creation fails", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source.png");
    await fs.writeFile(sourcePath, testPngBytes);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () =>
          Promise.resolve(
            Ok(
              createMockImageModel(() =>
                Promise.resolve({
                  images: [sharpInvalidPngBase64],
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
      { sourcePath, prompt: "Make it blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    if (!result.success) {
      throw new Error(`Expected image_edit to succeed, got ${result.error}`);
    }
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.outputDimensions).toEqual({ width: 1, height: 1 });
    expect(result.images[0]?.thumbnail).toBeUndefined();
    expect(result.warnings?.[0]).toContain("Thumbnail generation failed for image-1.png");
  });

  test("writes edited artifacts with source and output metadata", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const sourcePath = path.join(workspaceDir.path, "source-with-wrong-extension.txt");
    await fs.writeFile(sourcePath, testPngBytes);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
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
                      images: [{ revisedPrompt: "Make the small square blue" }],
                    },
                  },
                })
              )
            )
          ),
      },
    });

    const result = (await tool.execute!(
      { sourcePath, prompt: "Make the square blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    if (!result.success) {
      throw new Error(`Expected image_edit to succeed, got ${result.error}`);
    }
    expect(result.source).toMatchObject({
      path: sourcePath,
      resolvedPath: sourcePath,
      sizeBytes: testPngBytes.length,
      dimensions: { width: 16, height: 16 },
    });
    expect(result.images).toHaveLength(1);
    const image = result.images[0];
    expect(image).toMatchObject({
      filename: "image-1.png",
      mediaType: "image/png",
      outputDimensions: { width: 16, height: 16 },
      revisedPrompt: "Make the small square blue",
    });
    expect(image?.path).toContain("edited_images/test-workspace/image-edit-call");
    expect(image?.thumbnail).toMatchObject({ mediaType: "image/webp" });
    if (!image) {
      throw new Error("Expected an edited image result");
    }
    await fs.stat(image.path);
  });

  test("records requested and resolved paths for symlinked sources", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const realSourcePath = path.join(workspaceDir.path, "real-source.png");
    const symlinkPath = path.join(workspaceDir.path, "linked-source.png");
    await fs.writeFile(realSourcePath, testPngBytes);
    await fs.symlink(realSourcePath, symlinkPath);
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
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
      { sourcePath: symlinkPath, prompt: "Make the square blue" },
      createMockToolCallOptions()
    )) as ImageEditToolResult;

    if (!result.success) {
      throw new Error(`Expected image_edit to succeed, got ${result.error}`);
    }
    expect(result.source.path).toBe(symlinkPath);
    expect(result.source.resolvedPath).toBe(realSourcePath);
  });

  test("omits thumbnails from model-visible image_edit output", async () => {
    using workspaceDir = new TestTempDir("image-edit-workspace");
    const tool = createImageEditTool({
      ...createImageEditTestConfig(workspaceDir.path),
      imageEditingEnabled: true,
      imageGenerationRuntime: {
        modelString: "openai:gpt-image-1.5",
        maxImagesPerCall: 2,
        createImageModel: () => Promise.reject(new Error("not used")),
      },
    });

    const modelOutput = await tool.toModelOutput!({
      toolCallId: "image-edit-call",
      input: {},
      output: {
        success: true,
        model: "openai:gpt-image-1.5",
        prompt: "edit",
        requestedCount: 1,
        source: {
          path: "/tmp/source.png",
          resolvedPath: "/tmp/source.png",
          sizeBytes: 10,
          dimensions: { width: 16, height: 16 },
        },
        images: [
          {
            path: "/tmp/image.png",
            filename: "image.png",
            mediaType: "image/png",
            outputDimensions: { width: 16, height: 16 },
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
        prompt: "edit",
        requestedCount: 1,
        source: {
          path: "/tmp/source.png",
          sizeBytes: 10,
          dimensions: { width: 16, height: 16 },
        },
        images: [
          {
            path: "/tmp/image.png",
            filename: "image.png",
            mediaType: "image/png",
            outputDimensions: { width: 16, height: 16 },
          },
        ],
      },
    });
  });
});
