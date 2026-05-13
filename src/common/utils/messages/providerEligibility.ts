import type { MuxMessage } from "@/common/types/message";

export function hasProviderReplayableContent(
  message: MuxMessage,
  options: { preserveReasoningOnly?: boolean } = {}
): boolean {
  if (message.role === "system") {
    return true;
  }

  if (message.role === "user") {
    return message.parts.some((part) =>
      part.type === "text" ? part.text.trim().length > 0 : true
    );
  }

  if (message.role !== "assistant") {
    return false;
  }

  if (message.parts.length === 0) {
    return false;
  }

  const hasContent = message.parts.some((part) => {
    if (part.type === "text") {
      return part.text.trim().length > 0;
    }

    if (part.type === "reasoning") {
      return false;
    }

    if (part.type === "dynamic-tool") {
      return part.state === "output-available";
    }

    return true;
  });

  if (hasContent) {
    return true;
  }

  return options.preserveReasoningOnly === true
    ? message.parts.some((part) => part.type === "reasoning")
    : false;
}
