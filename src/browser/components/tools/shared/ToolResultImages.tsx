import React, { useState } from "react";
import { Dialog, DialogContent, DialogTitle, VisuallyHidden } from "@/browser/components/ui/dialog";

/**
 * Image content from MCP tool results (transformed from MCP's image type to AI SDK's media type)
 */
interface MediaContent {
  type: "media";
  data: string; // base64
  mediaType: string;
}

/**
 * Structure of transformed MCP results that contain images
 */
interface ContentResult {
  type: "content";
  value: Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
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
 * Validate base64 string contains only valid characters.
 * Prevents injection of malicious content through invalid base64.
 */
function isValidBase64(str: string): boolean {
  // Base64 should only contain alphanumeric, +, /, and = for padding
  // Also allow reasonable length (up to ~10MB decoded = ~13MB base64)
  if (str.length > 15_000_000) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(str);
}

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
  if (!isValidBase64(data)) {
    return null;
  }

  return `data:${normalizedType};base64,${data}`;
}

/**
 * Extract images from a tool result.
 * Handles the transformed MCP result format: { type: "content", value: [...] }
 */
export function extractImagesFromToolResult(result: unknown): MediaContent[] {
  if (typeof result !== "object" || result === null) return [];

  const contentResult = result as ContentResult;
  if (contentResult.type !== "content" || !Array.isArray(contentResult.value)) return [];

  return contentResult.value.filter(
    (item): item is MediaContent =>
      item.type === "media" && typeof item.data === "string" && typeof item.mediaType === "string"
  );
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
          <button
            key={index}
            onClick={() => setSelectedImage(dataUrl)}
            className="border-border-light bg-dark block cursor-pointer overflow-hidden rounded border p-0 transition-opacity hover:opacity-80"
            title="Click to view full size"
          >
            <img
              src={dataUrl}
              alt={`Tool result image ${index + 1}`}
              className="max-h-48 max-w-full object-contain"
            />
          </button>
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
