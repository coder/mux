/**
 * Strip UI-only tool output before sending to providers.
 * Produces a cloned array safe for sending to providers without touching persisted history/UI.
 */
import type { MuxMessage } from "@/common/types/message";
import { stripToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

export function applyToolOutputRedaction(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const newParts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") return part;
      if (part.state !== "output-available") return part;

      return {
        ...part,
        output: stripToolOutputUiOnly(part.output),
      };
    });

    return {
      ...msg,
      parts: newParts,
    } satisfies MuxMessage;
  });
}
