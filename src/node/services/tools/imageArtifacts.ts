import path from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
import type { LanguageModelV2Usage } from "@ai-sdk/provider";

import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { DEFAULT_IMAGE_GENERATION_MODEL } from "@/common/types/imageGeneration";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import { log } from "@/node/services/log";
import { getRasterImageDimensionsFromMetadata } from "@/node/utils/attachments/resizeRasterImageAttachment";

const THUMBNAIL_MAX_DIMENSION = 512;
const THUMBNAIL_QUALITY = 75;
const THUMBNAIL_MEDIA_TYPE = "image/webp";

type ImageModelOperation = "generation" | "editing";
type ImageToolName = "image_generate" | "image_edit";

/**
 * Convert image-model setup failures from provider/model policy into tool errors.
 * Expected inputs are Mux error records like `{ type: string; message?: string; raw?: string }`.
 */
export function formatImageModelError(
  error: unknown,
  operation: ImageModelOperation
): { error: string; setupHint?: string } {
  if (typeof error !== "object" || error === null) {
    return { error: getErrorMessage(error) };
  }

  const record = error as Record<string, unknown>;
  switch (record.type) {
    case "api_key_not_found":
      return {
        error: `Image ${operation} requires an OpenAI API key.`,
        setupHint:
          "Configure an OpenAI API key in Settings > Providers or set OPENAI_API_KEY; Codex OAuth does not currently provide image credentials.",
      };
    case "provider_disabled":
      return {
        error: "The OpenAI provider is disabled.",
        setupHint: `Enable OpenAI in Settings > Providers to use image ${operation}.`,
      };
    case "provider_not_supported":
      return {
        error: `Image ${operation} v1 only supports OpenAI image models.`,
        setupHint: `Choose ${DEFAULT_IMAGE_GENERATION_MODEL} in Settings > Experiments > Image Tools.`,
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
            : `Image ${operation} is denied by policy.`,
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

export interface ImageDimensions {
  width: number;
  height: number;
}

function sanitizePathSegment(value: string, fallback: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 0 ? sanitized : fallback;
}

export function getExtension(mediaType: string, outputFormat: string | null | undefined): string {
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

export async function writeRuntimeFile(
  config: ToolConfiguration,
  filePath: string,
  data: Uint8Array,
  logName: string
): Promise<void> {
  assert(data.length > 0, "image artifact data must not be empty");
  const writer = config.runtime.writeFile(filePath).getWriter();
  try {
    await writer.write(data);
    await writer.close();
  } catch (error) {
    try {
      await writer.abort(error);
    } catch (abortError) {
      log.debug(`${logName}: failed to abort artifact write`, {
        error: getErrorMessage(abortError),
      });
    }
    throw error;
  }
}

export async function createThumbnail(data: Uint8Array): Promise<{
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

export const getImageDimensionsFromMetadata = getRasterImageDimensionsFromMetadata;

export async function getImageDimensions(data: Uint8Array): Promise<ImageDimensions> {
  const dimensions = getImageDimensionsFromMetadata(await sharp(Buffer.from(data)).metadata());
  assert(dimensions != null, "image dimensions must be readable");
  return dimensions;
}

// OpenAI returns per-image diagnostics (revised prompts, token counts) under
// `providerMetadata.openai.images`. Both revised-prompt and usage extraction need
// the same narrowed array, so the walk lives in one helper.
function getOpenAIImageInfos(providerMetadata: unknown): unknown[] | undefined {
  if (typeof providerMetadata !== "object" || providerMetadata === null) {
    return undefined;
  }
  const openai = (providerMetadata as { openai?: unknown }).openai;
  if (typeof openai !== "object" || openai === null) {
    return undefined;
  }
  const images = (openai as { images?: unknown }).images;
  return Array.isArray(images) ? images : undefined;
}

export function getRevisedPrompt(providerMetadata: unknown, index: number): string | undefined {
  const images = getOpenAIImageInfos(providerMetadata);
  if (!images) {
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
  const images = getOpenAIImageInfos(providerMetadata);
  if (!images) {
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

export function getLanguageModelUsageForImageResult(
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

export function reportImageToolUsage(
  config: ToolConfiguration,
  toolName: ImageToolName,
  modelString: string,
  usage: unknown,
  providerMetadata: unknown,
  toolCallId?: string
): void {
  const usageForModelAccounting = getLanguageModelUsageForImageResult(usage, providerMetadata);
  if (config.reportModelUsage == null || usageForModelAccounting == null) {
    return;
  }

  try {
    config.reportModelUsage({
      source: "tool",
      toolName,
      model: modelString,
      usage: usageForModelAccounting,
      providerMetadata: providerMetadata as Record<string, unknown> | undefined,
      toolCallId,
      timestamp: Date.now(),
    });
  } catch (error) {
    log.debug(`${toolName}: failed to report model usage`, {
      error: getErrorMessage(error),
    });
  }
}

interface ProviderImageArtifact {
  mediaType?: string | undefined;
  uint8Array: Uint8Array;
}

interface ProcessImageArtifactsOptions<Extra extends object> {
  config: ToolConfiguration;
  outputDir: string;
  toolName: ImageToolName;
  outputFormat?: string | null;
  providerMetadata: unknown;
  images: Iterable<ProviderImageArtifact>;
  getExtraFields: (
    bytes: Uint8Array,
    index: number,
    filename: string
  ) => Promise<{ success: true; fields: Extra } | { success: false; error: string }>;
}

export interface ImageToolArtifactBase {
  path: string;
  filename: string;
  mediaType: string;
  thumbnail?: {
    data: string;
    mediaType: string;
    width: number;
    height: number;
  };
  revisedPrompt?: string;
}

async function cleanupWrittenArtifacts(
  config: ToolConfiguration,
  toolName: ImageToolName,
  paths: readonly string[]
): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  try {
    const cleanup = await config.runtime.exec(`rm -f -- ${paths.map(shellQuote).join(" ")}`, {
      cwd: config.cwd,
      timeout: 5,
    });
    const exitCode = await cleanup.exitCode;
    if (exitCode !== 0) {
      log.debug(`${toolName}: partial image artifact cleanup exited non-zero`, { exitCode });
    }
  } catch (error) {
    log.debug(`${toolName}: failed to clean up partial image artifacts`, {
      error: getErrorMessage(error),
    });
  }
}

export async function processImageArtifacts<Extra extends object = Record<never, never>>(
  options: ProcessImageArtifactsOptions<Extra>
): Promise<
  | { success: true; images: Array<ImageToolArtifactBase & Extra>; warnings: string[] }
  | { success: false; error: string }
> {
  const images: Array<ImageToolArtifactBase & Extra> = [];
  const warnings: string[] = [];
  const writtenPaths: string[] = [];

  try {
    for (const [index, image] of Array.from(options.images).entries()) {
      const mediaType = image.mediaType ?? `image/${options.outputFormat ?? "png"}`;
      const extension = getExtension(mediaType, options.outputFormat);
      const filename = `image-${index + 1}.${extension}`;
      const artifactPath = options.config.runtime.normalizePath(filename, options.outputDir);
      const bytes = image.uint8Array;

      const extraResult = await options.getExtraFields(bytes, index, filename);
      if (!extraResult.success) {
        await cleanupWrittenArtifacts(options.config, options.toolName, writtenPaths);
        return extraResult;
      }

      await writeRuntimeFile(options.config, artifactPath, bytes, options.toolName);
      writtenPaths.push(artifactPath);

      let thumbnail;
      try {
        thumbnail = await createThumbnail(bytes);
      } catch (error) {
        warnings.push(`Thumbnail generation failed for ${filename}: ${getErrorMessage(error)}`);
      }

      const revisedPrompt = getRevisedPrompt(options.providerMetadata, index);
      images.push({
        path: artifactPath,
        filename,
        mediaType,
        ...extraResult.fields,
        ...(thumbnail ? { thumbnail } : {}),
        ...(revisedPrompt ? { revisedPrompt } : {}),
      });
    }
  } catch (error) {
    await cleanupWrittenArtifacts(options.config, options.toolName, writtenPaths);
    throw error;
  }

  return { success: true, images, warnings };
}

export async function getImageOutputDir(
  config: ToolConfiguration,
  artifactRoot: "generated_images" | "edited_images",
  fallbackToolName: string,
  toolCallId?: string
): Promise<string> {
  const muxHome = await config.runtime.resolvePath(config.runtime.getMuxHome());
  const workspaceSegment = sanitizePathSegment(config.workspaceId ?? "workspace", "workspace");
  const callSegment = sanitizePathSegment(
    toolCallId ?? `${fallbackToolName}_${Date.now()}`,
    fallbackToolName
  );
  const outputDir = config.runtime.normalizePath(
    path.posix.join(artifactRoot, workspaceSegment, callSegment),
    muxHome
  );
  await config.runtime.ensureDir(outputDir);
  return outputDir;
}
