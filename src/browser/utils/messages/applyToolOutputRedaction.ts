/**
 * Strip UI-only tool output before sending to providers.
 * Produces a cloned array safe for sending to providers without touching persisted history/UI.
 */
import type { MuxMessage } from "@/common/types/message";
import { stripToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

function stripImageGenerateThumbnailFromImage(image: unknown): unknown {
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    return image;
  }

  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(image)) {
    if (key !== "thumbnail") {
      stripped[key] = value;
    }
  }
  return stripped;
}

function stripImageGenerateThumbnails(output: unknown): unknown {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output;
  }
  const record = output as Record<string, unknown>;
  if (record.success !== true || !Array.isArray(record.images)) {
    return output;
  }

  return {
    ...record,
    images: record.images.map(stripImageGenerateThumbnailFromImage),
  };
}

export function applyToolOutputRedaction(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const newParts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") return part;
      if (part.state !== "output-available") return part;

      const outputWithoutUiOnly = stripToolOutputUiOnly(part.output);
      return {
        ...part,
        output:
          part.toolName === "image_generate"
            ? stripImageGenerateThumbnails(outputWithoutUiOnly)
            : outputWithoutUiOnly,
      };
    });

    return {
      ...msg,
      parts: newParts,
    } satisfies MuxMessage;
  });
}
