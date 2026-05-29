import { MAX_IMAGE_DIMENSION } from "@/common/constants/imageAttachments";
import assert from "@/common/utils/assert";

export interface ResizeDimensions {
  width: number;
  height: number;
}

export function getResizedRasterOutputMediaType(mediaType: string): "image/jpeg" | "image/png" {
  const normalizedMediaType = mediaType.toLowerCase().trim().split(";")[0];
  return normalizedMediaType === "image/jpeg" || normalizedMediaType === "image/jpg"
    ? "image/jpeg"
    : "image/png";
}

export function computeResizedDimensions(
  width: number,
  height: number,
  maxDimension: number = MAX_IMAGE_DIMENSION
): ResizeDimensions | null {
  assert(Number.isFinite(width) && width > 0, `Expected a positive image width, got ${width}`);
  assert(Number.isFinite(height) && height > 0, `Expected a positive image height, got ${height}`);
  assert(
    Number.isFinite(maxDimension) && maxDimension > 0,
    `Expected a positive max image dimension, got ${maxDimension}`
  );

  if (width <= maxDimension && height <= maxDimension) {
    return null;
  }

  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
