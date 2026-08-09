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
 * MCP CallToolResult content types (MCP spec wire shapes)
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

interface MCPAudioContent {
  type: "audio";
  data: string; // base64
  mimeType: string;
}

interface MCPResourceContent {
  type: "resource";
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}

type MCPContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

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
 * Format byte size as human-readable string (KB or MB).
 * Uses decimal (SI) units (1000-based) — intentionally different from the shared
 * binary-unit formatBytes in @/common/utils/formatBytes which uses 1024-based thresholds.
 */
function formatBytesSI(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1000)} KB`;
}

/** Binary media guard shared by image/audio content and blob resources. */
function toGuardedMediaPart(
  kind: string,
  data: string | undefined,
  mediaType: string
): AISDKContentPart {
  const dataLength = data?.length ?? 0;
  if (dataLength > MAX_IMAGE_DATA_BYTES) {
    log.warn(`[MCP] ${kind} data too large, omitting from context`, {
      mediaType,
      dataLength,
      maxAllowed: MAX_IMAGE_DATA_BYTES,
    });
    return {
      type: "text",
      text: `[${kind} omitted: ${formatBytesSI(dataLength)} exceeds per-${kind.toLowerCase()} guard of ${formatBytesSI(MAX_IMAGE_DATA_BYTES)}. Reduce resolution or quality and retry.]`,
    };
  }
  return { type: "media", data: data ?? "", mediaType };
}

/**
 * Transform MCP tool result to AI SDK format.
 * Converts MCP binary content (image, audio, embedded blob resources) to AI
 * SDK "media" parts — the single conversion layer for MCP media (mixed
 * text+binary results included). Truncates large payloads to prevent context
 * overflow.
 */
export function transformMCPResult(result: unknown): unknown {
  if (!result || typeof result !== "object") {
    return result;
  }

  const typed = result as MCPCallToolResult;

  // If it has toolResult (non-standard result shape), pass through as-is
  if (typed.toolResult !== undefined) {
    return result;
  }

  // If no content array, pass through
  if (!typed.content || !Array.isArray(typed.content)) {
    return result;
  }

  // Only rewrite results carrying binary payloads; text-only results
  // (including text-only errors) pass through in MCP shape (converted by the
  // tool's toModelOutput, which keeps the isError flag visible to the model).
  const hasBinaryContent = typed.content.some(
    (c) =>
      c.type === "image" ||
      c.type === "audio" ||
      (c.type === "resource" && typeof c.resource?.blob === "string")
  );
  if (!hasBinaryContent) {
    return result;
  }

  // Debug: log what we received from MCP
  log.debug("[MCP] transformMCPResult input", {
    contentTypes: typed.content.map((c) => c.type),
  });

  // Transform to AI SDK content format
  const transformedContent: AISDKContentPart[] = typed.content.map((item) => {
    if (item.type === "text") {
      return { type: "text" as const, text: item.text };
    }
    if (item.type === "image") {
      // Ensure mediaType is present - default to image/png if missing
      return toGuardedMediaPart("Image", item.data, item.mimeType || "image/png");
    }
    if (item.type === "audio") {
      return toGuardedMediaPart("Audio", item.data, item.mimeType || "audio/wav");
    }
    if (item.type === "resource") {
      if (typeof item.resource.blob === "string") {
        return toGuardedMediaPart(
          "Resource",
          item.resource.blob,
          item.resource.mimeType ?? "application/octet-stream"
        );
      }
      // Text resources: surface the text (or the URI as a reference).
      return { type: "text" as const, text: item.resource.text ?? item.resource.uri };
    }
    // Fallback: stringify unknown content
    return { type: "text" as const, text: JSON.stringify(item) };
  });

  // The model-output "content" shape has no error flag, so error results
  // carrying binary payloads get an explicit text marker instead of bypassing
  // the media conversion (and its size guard).
  if (typed.isError) {
    transformedContent.unshift({ type: "text", text: "[Tool reported an error]" });
  }

  return { type: "content", value: transformedContent };
}
