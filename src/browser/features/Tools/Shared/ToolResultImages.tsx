import React, { useState } from "react";
import { isValidBase64AttachmentData } from "@/common/utils/attachments/base64";
import { isToolContentResult } from "@/common/utils/tools/toolContentResult";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  VisuallyHidden,
} from "@/browser/components/Dialog/Dialog";

/**
 * Image content from MCP tool results (transformed from MCP's image type to AI SDK's media type)
 */
interface MediaContent {
  type: "media";
  data: string; // base64
  mediaType: string;
}

function isMediaContent(value: unknown): value is MediaContent {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "media" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string"
  );
}

/**
 * Allowed image MIME types for display.
 * Excludes SVG (can contain scripts) and other potentially dangerous formats.
 */
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/**
 * Sanitize and validate image data from MCP tool results.
 * Returns a safe data URL or null if validation fails.
 */
export function sanitizeImageData(mediaType: string, data: string): string | null {
  // Normalize and validate media type
  const normalizedType = mediaType.toLowerCase().trim();
  if (!ALLOWED_IMAGE_TYPES.has(normalizedType)) {
    return null;
  }

  // Validate base64 data
  if (!isValidBase64AttachmentData(data)) {
    return null;
  }

  return `data:${normalizedType};base64,${data}`;
}

/**
 * Extract images from a tool result.
 * Handles the transformed MCP result format: { type: "content", value: [...] }
 */
export function extractImagesFromToolResult(result: unknown): MediaContent[] {
  if (!isToolContentResult(result)) return [];

  return result.value.filter(isMediaContent);
}

interface ToolResultImagesProps {
  result: unknown;
}

/**
 * Display images extracted from MCP tool results (e.g., Chrome DevTools screenshots)
 */
export const ToolResultImages: React.FC<ToolResultImagesProps> = ({ result }) => {
  const images = extractImagesFromToolResult(result);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);

  // Sanitize all images upfront, filtering out any that fail validation
  const safeImages = images
    .map((image) => sanitizeImageData(image.mediaType, image.data))
    .filter((url): url is string => url !== null);

  if (safeImages.length === 0) return null;

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-2">
        {safeImages.map((dataUrl, index) => (
          <TooltipIfPresent key={index} tooltip="Click to view full size" side="top">
            <button
              onClick={() => setSelectedImage(dataUrl)}
              className="border-border-light bg-dark block cursor-pointer overflow-hidden rounded border p-0 transition-opacity hover:opacity-80"
            >
              <img
                src={dataUrl}
                alt={`Tool result image ${index + 1}`}
                className="max-h-48 max-w-full object-contain"
              />
            </button>
          </TooltipIfPresent>
        ))}
      </div>

      {/* Lightbox modal for full-size image viewing */}
      <Dialog open={selectedImage !== null} onOpenChange={() => setSelectedImage(null)}>
        <DialogContent
          maxWidth="90vw"
          maxHeight="90vh"
          className="flex items-center justify-center bg-black/90 p-2"
        >
          <VisuallyHidden>
            <DialogTitle>Image Preview</DialogTitle>
          </VisuallyHidden>
          {selectedImage && (
            <img
              src={selectedImage}
              alt="Full size preview"
              className="max-h-[85vh] max-w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
