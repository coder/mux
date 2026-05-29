import assert from "@/common/utils/assert";

export const DEFAULT_IMAGE_GENERATION_MODEL = "openai:gpt-image-2";
export const PINNED_IMAGE_GENERATION_MODEL = "openai:gpt-image-2-2026-04-21";
export const DEFAULT_IMAGE_GENERATION_MAX_IMAGES = 4;
export const MIN_IMAGE_GENERATION_MAX_IMAGES = 1;
export const MAX_IMAGE_GENERATION_MAX_IMAGES = 10;

export const IMAGE_GENERATION_QUALITY_VALUES = ["low", "medium", "high", "auto"] as const;
export type ImageGenerationQuality = (typeof IMAGE_GENERATION_QUALITY_VALUES)[number];

export const IMAGE_GENERATION_OUTPUT_FORMAT_VALUES = ["png", "jpeg", "webp"] as const;
export type ImageGenerationOutputFormat = (typeof IMAGE_GENERATION_OUTPUT_FORMAT_VALUES)[number];

export interface ImageGenerationConfig {
  modelString: string;
  maxImagesPerCall: number;
  allowImageUploadsForEditing: boolean;
}

export function clampImageGenerationMaxImages(value: number): number {
  assert(Number.isFinite(value), "image generation maxImagesPerCall must be finite");
  return Math.min(
    MAX_IMAGE_GENERATION_MAX_IMAGES,
    Math.max(MIN_IMAGE_GENERATION_MAX_IMAGES, Math.trunc(value))
  );
}

export function normalizeImageGenerationConfig(value: unknown): ImageGenerationConfig {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

  const rawModelString = record.modelString;
  const modelString =
    typeof rawModelString === "string" && rawModelString.trim().length > 0
      ? rawModelString.trim()
      : DEFAULT_IMAGE_GENERATION_MODEL;

  const rawMaxImagesPerCall = record.maxImagesPerCall;
  const maxImagesPerCall =
    typeof rawMaxImagesPerCall === "number" && Number.isFinite(rawMaxImagesPerCall)
      ? clampImageGenerationMaxImages(rawMaxImagesPerCall)
      : DEFAULT_IMAGE_GENERATION_MAX_IMAGES;

  const allowImageUploadsForEditing = record.allowImageUploadsForEditing === true;

  return { modelString, maxImagesPerCall, allowImageUploadsForEditing };
}
