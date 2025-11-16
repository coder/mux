import assert from "@/common/utils/assert";
import type { MuxReasoningPart, MuxTextPart, MuxToolPart } from "@/common/types/message";

export function extractAssistantText(parts: unknown): string {
  if (!Array.isArray(parts)) {
    return "";
  }

  const textParts = (parts as MuxTextPart[]).filter(
    (part): part is MuxTextPart => part.type === "text"
  );
  return textParts
    .map((part) => {
      assert(typeof part.text === "string", "Text part must include text");
      return part.text;
    })
    .join("");
}

export function extractReasoning(parts: unknown): string[] {
  if (!Array.isArray(parts)) {
    return [];
  }

  const reasoningParts = (parts as MuxReasoningPart[]).filter(
    (part): part is MuxReasoningPart => part.type === "reasoning"
  );
  return reasoningParts.map((part) => {
    assert(typeof part.text === "string", "Reasoning part must include text");
    return part.text;
  });
}

export function extractToolCalls(parts: unknown): MuxToolPart[] {
  if (!Array.isArray(parts)) {
    return [];
  }

  return (parts as MuxToolPart[]).filter(
    (part): part is MuxToolPart => part.type === "dynamic-tool"
  );
}
