import React from "react";

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

  if (images.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image, index) => {
        const dataUrl = `data:${image.mediaType};base64,${image.data}`;
        return (
          <a
            key={index}
            href={dataUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="border-border-light bg-dark group block overflow-hidden rounded border transition-opacity hover:opacity-80"
            title="Click to open full size"
          >
            <img
              src={dataUrl}
              alt={`Tool result image ${index + 1}`}
              className="max-h-48 max-w-full object-contain"
            />
          </a>
        );
      })}
    </div>
  );
};
