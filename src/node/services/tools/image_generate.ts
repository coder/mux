import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { JSONValue, LanguageModelV2Usage } from "@ai-sdk/provider";
import { generateImage, tool } from "ai";

import type { ImageGenerateToolResult } from "@/common/types/tools";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "@/common/types/imageGeneration";
import { stripImageGenerateThumbnails } from "@/common/utils/imageGenerationToolResult";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { log } from "@/node/services/log";

const THUMBNAIL_MAX_DIMENSION = 512;
const THUMBNAIL_QUALITY = 75;
const THUMBNAIL_MEDIA_TYPE = "image/webp";

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : "image_generate";
}

function getExtension(mediaType: string, outputFormat: string | null | undefined): string {
  switch (mediaType.toLowerCase().trim()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
      return "png";
  }

  if (outputFormat === "jpeg" || outputFormat === "png" || outputFormat === "webp") {
    return outputFormat === "jpeg" ? "jpg" : outputFormat;
  }

  return "png";
}

async function writeRuntimeFile(
  config: ToolConfiguration,
  filePath: string,
  data: Uint8Array
): Promise<void> {
  assert(data.length > 0, "image artifact data must not be empty");
  const writer = config.runtime.writeFile(filePath).getWriter();
  try {
    await writer.write(data);
  } finally {
    await writer.close();
  }
}

async function createThumbnail(data: Uint8Array): Promise<{
  data: string;
  mediaType: string;
  width: number;
  height: number;
}> {
  const resized = sharp(Buffer.from(data)).resize({
    width: THUMBNAIL_MAX_DIMENSION,
    height: THUMBNAIL_MAX_DIMENSION,
    fit: "inside",
    withoutEnlargement: true,
  });
  const buffer = await resized.webp({ quality: THUMBNAIL_QUALITY }).toBuffer();
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  assert(width != null && width > 0, "thumbnail width must be positive");
  assert(height != null && height > 0, "thumbnail height must be positive");
  return {
    data: buffer.toString("base64"),
    mediaType: THUMBNAIL_MEDIA_TYPE,
    width,
    height,
  };
}

function getRevisedPrompt(providerMetadata: unknown, index: number): string | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return undefined;
  }
  const openai = (providerMetadata as { openai?: unknown }).openai;
  if (typeof openai !== "object" || openai === null) {
    return undefined;
  }
  const images = (openai as { images?: unknown }).images;
  if (!Array.isArray(images)) {
    return undefined;
  }
  const image: unknown = images[index];
  if (typeof image !== "object" || image === null) {
    return undefined;
  }
  const revisedPrompt = (image as { revisedPrompt?: unknown }).revisedPrompt;
  return typeof revisedPrompt === "string" && revisedPrompt.trim().length > 0
    ? revisedPrompt
    : undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getOpenAIImageTokenUsage(providerMetadata: unknown): LanguageModelV2Usage | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return undefined;
  }
  const openai = (providerMetadata as { openai?: unknown }).openai;
  if (typeof openai !== "object" || openai === null) {
    return undefined;
  }
  const images = (openai as { images?: unknown }).images;
  if (!Array.isArray(images)) {
    return undefined;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  for (const image of images) {
    if (typeof image !== "object" || image === null) {
      continue;
    }
    inputTokens += numberOrZero((image as { textTokens?: unknown }).textTokens);
    outputTokens += numberOrZero((image as { imageTokens?: unknown }).imageTokens);
  }

  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function getLanguageModelUsageForImageResult(
  usage: unknown,
  providerMetadata: unknown
): LanguageModelV2Usage | undefined {
  if (usage != null && typeof usage === "object") {
    const candidate = usage as {
      inputTokens?: unknown;
      outputTokens?: unknown;
      totalTokens?: unknown;
      cachedInputTokens?: unknown;
      reasoningTokens?: unknown;
    };
    const hasTokenUsage =
      typeof candidate.inputTokens === "number" ||
      typeof candidate.outputTokens === "number" ||
      typeof candidate.totalTokens === "number";
    if (hasTokenUsage) {
      return {
        inputTokens: typeof candidate.inputTokens === "number" ? candidate.inputTokens : undefined,
        outputTokens:
          typeof candidate.outputTokens === "number" ? candidate.outputTokens : undefined,
        totalTokens: typeof candidate.totalTokens === "number" ? candidate.totalTokens : undefined,
        cachedInputTokens:
          typeof candidate.cachedInputTokens === "number" ? candidate.cachedInputTokens : undefined,
        reasoningTokens:
          typeof candidate.reasoningTokens === "number" ? candidate.reasoningTokens : undefined,
      };
    }
  }

  return getOpenAIImageTokenUsage(providerMetadata);
}

function formatImageModelError(error: unknown): { error: string; setupHint?: string } {
  if (typeof error !== "object" || error === null) {
    return { error: getErrorMessage(error) };
  }

  const record = error as Record<string, unknown>;
  switch (record.type) {
    case "api_key_not_found":
      return {
        error: "Image generation requires an OpenAI API key.",
        setupHint:
          "Configure an OpenAI API key in Settings > Providers or set OPENAI_API_KEY; Codex OAuth does not currently provide image-generation credentials.",
      };
    case "provider_disabled":
      return {
        error: "The OpenAI provider is disabled.",
        setupHint: "Enable OpenAI in Settings → Providers to use image generation.",
      };
    case "provider_not_supported":
      return {
        error: "Image generation v1 only supports OpenAI image models.",
        setupHint: `Choose ${DEFAULT_IMAGE_GENERATION_MODEL} in Settings > Experiments > Image Generation Tool.`,
      };
    case "invalid_model_string":
      return {
        error: typeof record.message === "string" ? record.message : "Invalid image model string.",
        setupHint: `Use the provider:model-id format, for example ${DEFAULT_IMAGE_GENERATION_MODEL}.`,
      };
    case "policy_denied":
      return {
        error:
          typeof record.message === "string"
            ? record.message
            : "Image generation is denied by policy.",
      };
    case "unknown":
      return {
        error: typeof record.raw === "string" ? record.raw : getErrorMessage(error),
        setupHint: "Check OpenAI provider credentials, billing, rate limits, and content policy.",
      };
    default:
      return {
        error: getErrorMessage(error),
        setupHint: "Check OpenAI provider credentials, billing, rate limits, and content policy.",
      };
  }
}

export const createImageGenerateTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.image_generate.description,
    inputSchema: TOOL_DEFINITIONS.image_generate.schema,
    toModelOutput: ({ output }) => ({
      type: "json",
      value: stripImageGenerateThumbnails(output) as JSONValue,
    }),
    execute: async ({ prompt, n, quality, outputFormat }, { abortSignal, toolCallId }) => {
      const runtime = config.imageGenerationRuntime;
      assert(runtime, "imageGenerationRuntime must be set when image_generate is registered");
      const modelString = runtime.modelString.trim();
      assert(modelString.length > 0, "image generation modelString must be non-empty");
      assert(
        Number.isInteger(runtime.maxImagesPerCall) && runtime.maxImagesPerCall > 0,
        "image generation maxImagesPerCall must be a positive integer"
      );

      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) {
        return { success: false, error: "Image generation prompt is required." };
      }

      const requestedCount = n ?? 1;
      if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
        return { success: false, error: "Image count must be a positive integer." };
      }
      if (requestedCount > runtime.maxImagesPerCall) {
        return {
          success: false,
          error: `Requested ${requestedCount} images, but Image Generation Tool is configured for a maximum of ${runtime.maxImagesPerCall}.`,
          setupHint:
            "Adjust Settings > Experiments > Image Generation Tool or request fewer images.",
        };
      }

      const imageModelResult = await runtime.createImageModel(modelString);
      if (!imageModelResult.success) {
        return {
          success: false,
          ...formatImageModelError(imageModelResult.error),
        } satisfies ImageGenerateToolResult;
      }

      try {
        const result = await generateImage({
          model: imageModelResult.data,
          prompt: trimmedPrompt,
          n: requestedCount,
          abortSignal,
          providerOptions: {
            openai: {
              ...(quality != null ? { quality } : {}),
              output_format: outputFormat ?? "png",
            },
          },
        });

        const usageForModelAccounting = getLanguageModelUsageForImageResult(
          result.usage,
          result.providerMetadata
        );
        if (config.reportModelUsage != null && usageForModelAccounting != null) {
          try {
            config.reportModelUsage({
              source: "tool",
              toolName: "image_generate",
              model: modelString,
              usage: usageForModelAccounting,
              providerMetadata: result.providerMetadata as Record<string, unknown> | undefined,
              toolCallId,
              timestamp: Date.now(),
            });
          } catch (error) {
            log.debug("image_generate: failed to report model usage", {
              error: getErrorMessage(error),
            });
          }
        }

        if (result.images.length === 0) {
          return {
            success: false,
            error: "Image generation failed: provider returned no images.",
            setupHint:
              "Try again or choose a different OpenAI image model in Settings > Experiments > Image Generation Tool.",
          } satisfies ImageGenerateToolResult;
        }

        const muxHome = await config.runtime.resolvePath(config.runtime.getMuxHome());
        const workspaceSegment = sanitizePathSegment(config.workspaceId ?? "workspace");
        const callSegment = sanitizePathSegment(toolCallId ?? `image_${Date.now()}`);
        const outputDir = config.runtime.normalizePath(
          path.posix.join("generated_images", workspaceSegment, callSegment),
          muxHome
        );
        await config.runtime.ensureDir(outputDir);

        const images: Extract<ImageGenerateToolResult, { success: true }>["images"] = [];
        const warnings: string[] = [];
        for (const [index, image] of result.images.entries()) {
          const mediaType = image.mediaType || `image/${outputFormat ?? "png"}`;
          const extension = getExtension(mediaType, outputFormat);
          const filename = `image-${index + 1}.${extension}`;
          const artifactPath = config.runtime.normalizePath(filename, outputDir);
          const bytes = image.uint8Array;
          await writeRuntimeFile(config, artifactPath, bytes);

          let thumbnail;
          try {
            thumbnail = await createThumbnail(bytes);
          } catch (error) {
            warnings.push(`Thumbnail generation failed for ${filename}: ${getErrorMessage(error)}`);
          }

          const revisedPrompt = getRevisedPrompt(result.providerMetadata, index);
          images.push({
            path: artifactPath,
            filename,
            mediaType,
            ...(thumbnail ? { thumbnail } : {}),
            ...(revisedPrompt ? { revisedPrompt } : {}),
          });
        }

        return {
          success: true,
          model: modelString,
          prompt: trimmedPrompt,
          requestedCount,
          images,
          ...(warnings.length > 0 ? { warnings } : {}),
        } satisfies ImageGenerateToolResult;
      } catch (error) {
        return {
          success: false,
          error: `Image generation failed: ${getErrorMessage(error)}`,
          setupHint: "Check OpenAI provider credentials, billing, rate limits, and content policy.",
        } satisfies ImageGenerateToolResult;
      }
    },
  });
};
