import type { JSONValue, ModelMessage, ToolResultPart } from "ai";

// Extract the output type from ToolResultPart to ensure type compatibility with ai@6
type ToolResultOutput = ToolResultPart["output"];

/**
 * Request-only rewrite for *internal* streamText steps.
 *
 * streamText() can make multiple LLM calls (steps) when tools are enabled.
 * Tool results produced during the stream are included in subsequent step prompts.
 *
 * Some MCP tools return images as base64 inside tool results (output.type === "content" with
 * media parts, or output.type === "json" containing a nested "content" container).
 * Providers can treat that as plain text/JSON and blow up context.
 *
 * This helper rewrites tool-result outputs to replace base64 media with small text placeholders,
 * and inserts a synthetic user message containing the extracted images as multimodal image parts.
 */
export function extractToolMediaAsUserMessagesFromModelMessages(
  messages: ModelMessage[]
): ModelMessage[] {
  let didChange = false;
  const result: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== "assistant" && msg.role !== "tool") {
      result.push(msg);
      continue;
    }

    let extractedImages: Array<{ data: string; mediaType: string }> = [];
    let changedMessage = false;

    if (msg.role === "tool") {
      // Tool messages contain an array of tool-result parts (and potentially tool-approval-responses).
      const newContent = msg.content.map((part) => {
        // Skip non-result parts (e.g., ToolApprovalResponse)
        if (part.type !== "tool-result") return part;

        const extracted = extractImagesFromToolOutput(part.output);
        if (!extracted) return part;

        didChange = true;
        changedMessage = true;
        extractedImages = [...extractedImages, ...extracted.images];

        return {
          ...part,
          output: extracted.newOutput,
        };
      });

      result.push(changedMessage ? { ...msg, content: newContent } : msg);

      if (extractedImages.length > 0) {
        result.push(createSyntheticUserMessage(extractedImages));
      }

      continue;
    }

    // Assistant messages *can* contain tool-result parts (depending on provider), so handle those too.
    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map((part) => {
        if (part.type !== "tool-result") return part;

        const extracted = extractImagesFromToolOutput(part.output);
        if (!extracted) return part;

        didChange = true;
        changedMessage = true;
        extractedImages = [...extractedImages, ...extracted.images];

        return {
          ...part,
          output: extracted.newOutput,
        };
      });

      result.push(changedMessage ? { ...msg, content: newContent } : msg);

      if (extractedImages.length > 0) {
        result.push(createSyntheticUserMessage(extractedImages));
      }

      continue;
    }

    result.push(msg);
  }

  return didChange ? result : messages;
}

function createSyntheticUserMessage(
  extractedImages: Array<{ data: string; mediaType: string }>
): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[Attached ${extractedImages.length} image(s) from tool output]`,
      },
      ...extractedImages.map((image) => ({
        type: "image" as const,
        image: image.data,
        mediaType: image.mediaType,
      })),
    ],
  };
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

// SDK v6 content parts include more types (file-data, reasoning, etc.) - use flexible union
type AISDKContent = AISDKMediaPart | AISDKTextPart | { type: string; [key: string]: unknown };

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

function extractImagesFromToolOutput(output: ToolResultOutput): {
  newOutput: ToolResultOutput;
  images: Array<{ data: string; mediaType: string }>;
} | null {
  if (output.type === "json") {
    const extracted = extractImagesFromJsonValue(output.value);
    if (!extracted) return null;

    return {
      newOutput: { type: "json", value: extracted.newValue },
      images: extracted.images,
    };
  }

  if (output.type !== "content") {
    return null;
  }

  const extracted = extractImagesFromContentItems(output.value);
  if (!extracted) return null;

  // Cast needed because we're constructing a partial content array (media → text placeholders)
  // SDK v6 content parts include more types than our AISDKContent union
  const newOutput: ToolResultOutput = { type: "content", value: extracted.newValue as never };
  return { newOutput, images: extracted.images };
}

function extractImagesFromJsonValue(
  value: JSONValue
): { newValue: JSONValue; images: Array<{ data: string; mediaType: string }> } | null {
  // Some tools wrap the content container in an extra { type: "json" } layer.
  if (isJsonContainer(value)) {
    const extracted = extractImagesFromJsonValue(value.value as JSONValue);
    if (!extracted) return null;

    return {
      newValue: { type: "json", value: extracted.newValue } as unknown as JSONValue,
      images: extracted.images,
    };
  }

  if (!isContentContainer(value)) {
    return null;
  }

  const extracted = extractImagesFromContentItems(value.value);
  if (!extracted) return null;

  return {
    newValue: { type: "content", value: extracted.newValue } as unknown as JSONValue,
    images: extracted.images,
  };
}

function extractImagesFromContentItems(value: AISDKContentContainer["value"]): {
  newValue: AISDKContent[];
  images: Array<{ data: string; mediaType: string }>;
} | null {
  const images: Array<{ data: string; mediaType: string }> = [];
  const newValue: AISDKContent[] = [];

  for (const item of value) {
    if (isMediaPart(item)) {
      images.push({ data: item.data, mediaType: item.mediaType });

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
    newValue,
    images,
  };
}
