import * as fs from "node:fs/promises";
import assert from "node:assert/strict";
import type { JSONValue } from "@ai-sdk/provider";
import { generateImage, tool } from "ai";
import sharp from "sharp";

import type { ImageEditToolResult } from "@/common/types/tools";
import { stripImageToolOutputForModel } from "@/common/utils/imageGenerationToolResult";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { LocalBaseRuntime } from "@/node/runtime/LocalBaseRuntime";
import { streamToUint8Array } from "@/node/runtime/streamUtils";
import type { ImageDimensions } from "./imageArtifacts";
import {
  formatImageModelError,
  getImageDimensions,
  getImageDimensionsFromMetadata,
  getImageOutputDir,
  processImageArtifacts,
  reportImageToolUsage,
} from "./imageArtifacts";

const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_SOURCE_FORMATS = new Set(["png", "jpeg", "webp"]);

function getSupportedMediaType(format: string | undefined): string | null {
  if (!format || !SUPPORTED_SOURCE_FORMATS.has(format)) {
    return null;
  }
  return format === "jpeg" ? "image/jpeg" : `image/${format}`;
}

export const createImageEditTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.image_edit.description,
    inputSchema: TOOL_DEFINITIONS.image_edit.schema,
    toModelOutput: ({ output }) => ({
      type: "json",
      value: stripImageToolOutputForModel(output) as JSONValue,
    }),
    execute: async (
      { sourcePath, prompt, n, quality, outputFormat },
      { abortSignal, toolCallId }
    ) => {
      const runtime = config.imageGenerationRuntime;
      assert(runtime, "imageGenerationRuntime must be set when image_edit is registered");
      const modelString = runtime.modelString.trim();
      assert(modelString.length > 0, "image editing modelString must be non-empty");
      assert(
        Number.isInteger(runtime.maxImagesPerCall) && runtime.maxImagesPerCall > 0,
        "image editing maxImagesPerCall must be a positive integer"
      );

      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) {
        return { success: false, error: "Image edit prompt is required." };
      }

      const requestedCount = n ?? 1;
      if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
        return { success: false, error: "Image edit count must be a positive integer." };
      }
      if (requestedCount > runtime.maxImagesPerCall) {
        return {
          success: false,
          error: `Requested ${requestedCount} edited images, but Image Tools is configured for a maximum of ${runtime.maxImagesPerCall}.`,
          setupHint: "Adjust Settings > Experiments > Image Tools or request fewer images.",
        };
      }

      const requestedSourcePath = sourcePath.trim();
      if (!requestedSourcePath) {
        return { success: false, error: "Source image path is required." };
      }

      const normalizedSourcePath = config.runtime.normalizePath(requestedSourcePath, config.cwd);
      let resolvedSourcePath: string;
      let sourceSizeBytes: number;
      let sourceBytes: Uint8Array;
      let sourceDimensions: { width: number; height: number };
      try {
        const stat = await config.runtime.stat(normalizedSourcePath, abortSignal);
        if (stat.isDirectory) {
          return { success: false, error: `Source image is a directory: ${requestedSourcePath}` };
        }
        sourceSizeBytes = stat.size;
        if (sourceSizeBytes > MAX_SOURCE_IMAGE_BYTES) {
          return {
            success: false,
            error: `Source image is ${sourceSizeBytes} bytes, which exceeds the 50 MB Image Edit Tool limit.`,
          };
        }

        const runtimeResolvedSourcePath = await config.runtime.resolvePath(normalizedSourcePath);
        // Host realpath is only valid for runtimes backed by the local filesystem.
        if (config.runtime instanceof LocalBaseRuntime) {
          try {
            resolvedSourcePath = await fs.realpath(runtimeResolvedSourcePath);
          } catch {
            resolvedSourcePath = runtimeResolvedSourcePath;
          }
        } else {
          resolvedSourcePath = runtimeResolvedSourcePath;
        }
        sourceBytes = await streamToUint8Array(
          config.runtime.readFile(resolvedSourcePath, abortSignal),
          MAX_SOURCE_IMAGE_BYTES
        );
        if (sourceBytes.length !== sourceSizeBytes) {
          return {
            success: false,
            error:
              "Source image was modified between reading its size and reading its content. Try again.",
          } satisfies ImageEditToolResult;
        }
      } catch (error) {
        return {
          success: false,
          error: `Failed to read source image: ${getErrorMessage(error)}`,
        };
      }

      try {
        const metadata = await sharp(Buffer.from(sourceBytes)).metadata();
        if (getSupportedMediaType(metadata.format) == null) {
          return {
            success: false,
            error: "Source image must be a decodable PNG, JPEG, or WebP file.",
          };
        }
        const dimensions = getImageDimensionsFromMetadata(metadata);
        if (dimensions == null) {
          return { success: false, error: "Source image has no readable pixel dimensions." };
        }
        sourceDimensions = dimensions;
      } catch {
        return {
          success: false,
          error: "Source image must be a decodable PNG, JPEG, or WebP file.",
        };
      }

      const imageModelResult = await runtime.createImageModel(modelString);
      if (!imageModelResult.success) {
        return {
          success: false,
          ...formatImageModelError(imageModelResult.error, "editing"),
        } satisfies ImageEditToolResult;
      }

      try {
        const result = await generateImage({
          model: imageModelResult.data,
          prompt: { text: trimmedPrompt, images: [sourceBytes] },
          n: requestedCount,
          abortSignal,
          providerOptions: {
            openai: {
              ...(quality != null ? { quality } : {}),
              output_format: outputFormat ?? "png",
            },
          },
        });

        reportImageToolUsage(
          config,
          "image_edit",
          modelString,
          result.usage,
          result.providerMetadata,
          toolCallId
        );

        const outputDir = await getImageOutputDir(
          config,
          "edited_images",
          "image_edit",
          toolCallId
        );
        const artifacts = await processImageArtifacts<{ outputDimensions: ImageDimensions }>({
          config,
          outputDir,
          toolName: "image_edit",
          outputFormat,
          providerMetadata: result.providerMetadata,
          images: result.images,
          getExtraFields: async (bytes) => {
            try {
              return {
                success: true,
                fields: { outputDimensions: await getImageDimensions(bytes) },
              };
            } catch (error) {
              return {
                success: false,
                error: `Edited image dimensions could not be read: ${getErrorMessage(error)}`,
              };
            }
          },
        });
        if (!artifacts.success) {
          return {
            success: false,
            error: artifacts.error,
          } satisfies ImageEditToolResult;
        }

        return {
          success: true,
          model: modelString,
          prompt: trimmedPrompt,
          requestedCount,
          source: {
            path: requestedSourcePath,
            resolvedPath: resolvedSourcePath,
            sizeBytes: sourceSizeBytes,
            dimensions: sourceDimensions,
          },
          images: artifacts.images,
          ...(artifacts.warnings.length > 0 ? { warnings: artifacts.warnings } : {}),
        } satisfies ImageEditToolResult;
      } catch (error) {
        return {
          success: false,
          error: `Image editing failed: ${getErrorMessage(error)}`,
          setupHint: "Check OpenAI provider credentials, billing, rate limits, and content policy.",
        } satisfies ImageEditToolResult;
      }
    },
  });
};
