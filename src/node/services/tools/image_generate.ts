import assert from "node:assert/strict";
import type { JSONValue } from "@ai-sdk/provider";
import { generateImage, tool } from "ai";

import type { ImageGenerateToolResult } from "@/common/types/tools";
import { stripImageToolOutputForModel } from "@/common/utils/imageGenerationToolResult";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolFactory } from "@/common/utils/tools/tools";
import {
  formatImageModelError,
  getImageOutputDir,
  processImageArtifacts,
  reportImageToolUsage,
} from "./imageArtifacts";

export const createImageGenerateTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.image_generate.description,
    inputSchema: TOOL_DEFINITIONS.image_generate.schema,
    toModelOutput: ({ output }) => ({
      type: "json",
      value: stripImageToolOutputForModel(output) as JSONValue,
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
          error: `Requested ${requestedCount} images, but Image Tools is configured for a maximum of ${runtime.maxImagesPerCall}.`,
          setupHint: "Adjust Settings > Experiments > Image Tools or request fewer images.",
        };
      }

      const imageModelResult = await runtime.createImageModel(modelString);
      if (!imageModelResult.success) {
        return {
          success: false,
          ...formatImageModelError(imageModelResult.error, "generation"),
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

        reportImageToolUsage(
          config,
          "image_generate",
          modelString,
          result.usage,
          result.providerMetadata,
          toolCallId
        );

        const outputDir = await getImageOutputDir(
          config,
          "generated_images",
          "image_generate",
          toolCallId
        );

        const artifacts = await processImageArtifacts({
          config,
          outputDir,
          toolName: "image_generate",
          outputFormat,
          providerMetadata: result.providerMetadata,
          images: result.images,
          getExtraFields: () => Promise.resolve({ success: true, fields: {} }),
        });
        if (!artifacts.success) {
          return {
            success: false,
            error: artifacts.error,
          } satisfies ImageGenerateToolResult;
        }

        return {
          success: true,
          model: modelString,
          prompt: trimmedPrompt,
          requestedCount,
          images: artifacts.images,
          ...(artifacts.warnings.length > 0 ? { warnings: artifacts.warnings } : {}),
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
