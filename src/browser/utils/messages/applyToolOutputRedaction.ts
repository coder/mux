/**
 * Strip UI-only tool output before sending to providers.
 * Produces a cloned array safe for sending to providers without touching persisted history/UI.
 */
import type { MuxMessage } from "@/common/types/message";
import { stripImageToolOutputForModel } from "@/common/utils/imageGenerationToolResult";
import { stripToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

export function applyToolOutputRedaction(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const newParts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") return part;
      if (part.state !== "output-available") return part;

      const outputWithoutUiOnly = stripToolOutputUiOnly(part.output);
      const nestedCalls = part.nestedCalls?.map((nestedCall) => {
        if (nestedCall.state !== "output-available") {
          return nestedCall;
        }
        return {
          ...nestedCall,
          output: stripImageToolOutputForModel(stripToolOutputUiOnly(nestedCall.output)),
        };
      });
      return {
        ...part,
        ...(nestedCalls ? { nestedCalls } : {}),
        output: stripImageToolOutputForModel(outputWithoutUiOnly),
      };
    });

    return {
      ...msg,
      parts: newParts,
    } satisfies MuxMessage;
  });
}
