import type { MuxFilePart, MuxMessage } from "@/common/types/message";

/**
 * Provider-request-only rewrite to avoid sending huge base64 blobs inside tool-result JSON.
 *
 * Some MCP tools (e.g. Chrome DevTools screenshot) return images as base64 in the tool output.
 * If that base64 is sent as a tool-result payload, providers can treat it as *text* (or a huge
 * JSON blob), quickly exceeding context limits.
 *
 * This helper:
 * - detects tool outputs shaped like { type: "content", value: [{ type: "media", data, mediaType }, ...] }
 * - replaces media items in the tool output with small text placeholders
 * - emits a synthetic *user* message immediately after the assistant message, attaching the images
 *   as proper multimodal file parts (MuxFilePart)
 *
 * NOTE: This is request-only: it should be applied to the in-memory message list right before
 * convertToModelMessages(...). Persisted history and UI still keep the original tool output.
 */
export function extractToolMediaAsUserMessages(messages: MuxMessage[]): MuxMessage[] {
  const result: MuxMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }

    let extractedImages: MuxFilePart[] = [];
    let changed = false;

    const newParts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") return part;
      if (part.state !== "output-available") return part;

      const extracted = extractImagesFromToolOutput(part.output);
      if (!extracted) return part;

      changed = true;
      extractedImages = [...extractedImages, ...extracted.images];

      return {
        ...part,
        output: extracted.newOutput,
      };
    });

    const rewrittenMsg = changed ? ({ ...msg, parts: newParts } satisfies MuxMessage) : msg;
    result.push(rewrittenMsg);

    if (extractedImages.length > 0) {
      const timestamp = msg.metadata?.timestamp ?? Date.now();
      result.push({
        id: `tool-media-${msg.id}`,
        role: "user",
        parts: [
          {
            type: "text",
            text: `[Attached ${extractedImages.length} image(s) from tool output]`,
          },
          ...extractedImages,
        ],
        metadata: {
          timestamp,
          synthetic: true,
        },
      });
    }
  }

  return result;
}

interface AISDKMediaPart {
  type: "media";
  data: string;
  mediaType: string;
}

interface AISDKTextPart {
  type: "text";
  text: string;
}

type AISDKContent = AISDKMediaPart | AISDKTextPart;

interface AISDKContentContainer {
  type: "content";
  value: AISDKContent[];
}

interface JsonContainer {
  type: "json";
  value: unknown;
}

function isJsonContainer(v: unknown): v is JsonContainer {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).type === "json" &&
    "value" in (v as Record<string, unknown>)
  );
}

function isContentContainer(v: unknown): v is AISDKContentContainer {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).type === "content" &&
    Array.isArray((v as Record<string, unknown>).value)
  );
}

function isMediaPart(v: unknown): v is AISDKMediaPart {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<string, unknown>).type === "media" &&
    typeof (v as Record<string, unknown>).data === "string" &&
    typeof (v as Record<string, unknown>).mediaType === "string"
  );
}

function extractImagesFromToolOutput(
  output: unknown
): { newOutput: unknown; images: MuxFilePart[] } | null {
  if (isJsonContainer(output)) {
    const inner = extractImagesFromToolOutput(output.value);
    if (!inner) return null;
    return {
      newOutput: { type: "json", value: inner.newOutput },
      images: inner.images,
    };
  }

  if (!isContentContainer(output)) {
    return null;
  }

  const images: MuxFilePart[] = [];
  const newValue: AISDKContent[] = [];

  for (const item of output.value) {
    if (isMediaPart(item)) {
      images.push({
        type: "file",
        mediaType: item.mediaType,
        url: `data:${item.mediaType};base64,${item.data}`,
      });

      newValue.push({
        type: "text",
        text: `[Image attached: ${item.mediaType} (base64 len=${item.data.length})]`,
      });
      continue;
    }

    newValue.push(item);
  }

  if (images.length === 0) {
    return null;
  }

  return {
    newOutput: { type: "content", value: newValue },
    images,
  };
}
