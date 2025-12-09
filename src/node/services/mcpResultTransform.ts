import { log } from "@/node/services/log";

/**
 * Maximum size of base64 image data in bytes before we drop it.
 *
 * Rationale: providers already accept multi‑megabyte images, but a single
 * 20–30MB screenshot can still blow up request sizes or hit provider limits
 * (e.g., Anthropic ~32MB total request). We keep a generous per‑image guard to
 * pass normal screenshots while preventing pathological payloads.
 */
export const MAX_IMAGE_DATA_BYTES = 8 * 1024 * 1024; // 8MB guard per image

/**
 * MCP CallToolResult content types (from @ai-sdk/mcp)
 */
interface MCPTextContent {
  type: "text";
  text: string;
}

interface MCPImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

interface MCPResourceContent {
  type: "resource";
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}

type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

export interface MCPCallToolResult {
  content?: MCPContent[];
  isError?: boolean;
  toolResult?: unknown;
}

/**
 * AI SDK LanguageModelV2ToolResultOutput content types
 */
type AISDKContentPart =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string };

/**
 * Format byte size as human-readable string (KB or MB)
 */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1000)} KB`;
}

/**
 * Transform MCP tool result to AI SDK format.
 * Converts MCP's "image" content type to AI SDK's "media" type.
 * Truncates large images to prevent context overflow.
 */
export function transformMCPResult(result: MCPCallToolResult): unknown {
  // If it's an error or has toolResult, pass through as-is
  if (result.isError || result.toolResult !== undefined) {
    return result;
  }

  // If no content array, pass through
  if (!result.content || !Array.isArray(result.content)) {
    return result;
  }

  // Check if any content is an image
  const hasImage = result.content.some((c) => c.type === "image");
  if (!hasImage) {
    return result;
  }

  // Debug: log what we received from MCP
  log.debug("[MCP] transformMCPResult input", {
    contentTypes: result.content.map((c) => c.type),
    imageItems: result.content
      .filter((c): c is MCPImageContent => c.type === "image")
      .map((c) => ({ type: c.type, mimeType: c.mimeType, dataLen: c.data?.length })),
  });

  // Transform to AI SDK content format
  const transformedContent: AISDKContentPart[] = result.content.map((item) => {
    if (item.type === "text") {
      return { type: "text" as const, text: item.text };
    }
    if (item.type === "image") {
      const imageItem = item;
      // Check if image data exceeds the limit
      const dataLength = imageItem.data?.length ?? 0;
      if (dataLength > MAX_IMAGE_DATA_BYTES) {
        log.warn("[MCP] Image data too large, omitting from context", {
          mimeType: imageItem.mimeType,
          dataLength,
          maxAllowed: MAX_IMAGE_DATA_BYTES,
        });
        return {
          type: "text" as const,
          text: `[Image omitted: ${formatBytes(dataLength)} exceeds per-image guard of ${formatBytes(MAX_IMAGE_DATA_BYTES)}. Reduce resolution or quality and retry.]`,
        };
      }
      // Ensure mediaType is present - default to image/png if missing
      const mediaType = imageItem.mimeType || "image/png";
      log.debug("[MCP] Transforming image content", { mimeType: imageItem.mimeType, mediaType });
      return { type: "media" as const, data: imageItem.data, mediaType };
    }
    // For resource type, convert to text representation
    if (item.type === "resource") {
      const text = item.resource.text ?? item.resource.uri;
      return { type: "text" as const, text };
    }
    // Fallback: stringify unknown content
    return { type: "text" as const, text: JSON.stringify(item) };
  });

  return { type: "content", value: transformedContent };
}
