import { MAX_IMAGE_DIMENSION } from "@/common/constants/imageAttachments";

export interface ResizeDimensions {
  width: number;
  height: number;
}

export interface ResizeResult {
  dataUrl: string;
  mediaType: string;
  resized: boolean;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
}

function getOutputMediaType(mediaType: string): "image/jpeg" | "image/png" {
  const normalizedMediaType = mediaType.toLowerCase().trim().split(";")[0];
  return normalizedMediaType === "image/jpeg" || normalizedMediaType === "image/jpg"
    ? "image/jpeg"
    : "image/png";
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load image for resizing"));
    image.src = dataUrl;
  });
}

export function computeResizedDimensions(
  width: number,
  height: number,
  maxDimension: number
): ResizeDimensions | null {
  if (width <= maxDimension && height <= maxDimension) {
    return null;
  }

  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function resizeImageIfNeeded(
  dataUrl: string,
  mediaType: string,
  maxDimension: number = MAX_IMAGE_DIMENSION
): Promise<ResizeResult> {
  const image = await loadImage(dataUrl);
  const originalWidth = image.naturalWidth;
  const originalHeight = image.naturalHeight;

  if (originalWidth <= 0 || originalHeight <= 0) {
    throw new Error("Failed to read image dimensions");
  }

  const resizedDimensions = computeResizedDimensions(originalWidth, originalHeight, maxDimension);
  if (!resizedDimensions) {
    return {
      dataUrl,
      mediaType,
      resized: false,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = resizedDimensions.width;
  canvas.height = resizedDimensions.height;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Failed to create canvas context for image resize");
  }

  context.drawImage(image, 0, 0, resizedDimensions.width, resizedDimensions.height);

  const outputMediaType = getOutputMediaType(mediaType);
  const resizedDataUrl =
    outputMediaType === "image/jpeg"
      ? canvas.toDataURL(outputMediaType, 0.9)
      : canvas.toDataURL(outputMediaType);

  return {
    dataUrl: resizedDataUrl,
    mediaType: outputMediaType,
    resized: true,
    originalWidth,
    originalHeight,
    width: resizedDimensions.width,
    height: resizedDimensions.height,
  };
}
