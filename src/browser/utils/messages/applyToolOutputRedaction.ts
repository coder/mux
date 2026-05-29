/**
 * Strip UI-only tool output before sending to providers.
 * Produces a cloned array safe for sending to providers without touching persisted history/UI.
 */
import type { MuxMessage } from "@/common/types/message";
import { stripImageToolOutputForModel } from "@/common/utils/imageGenerationToolResult";
import { sanitizeUnknownForProviderOutput } from "@/common/utils/providerOutputSanitization";
import { stripToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

export function applyToolOutputRedaction(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;

    const newParts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") return part;
      if (part.state !== "output-available") return part;

      const outputWithoutUiOnly = stripToolOutputUiOnly(part.output);
      const sanitizedOutput = sanitizeUnknownForProviderOutput(
        stripImageToolOutputForModel(outputWithoutUiOnly)
      );
      const nestedCalls = part.nestedCalls?.map((nestedCall) => {
        if (nestedCall.state !== "output-available") {
          return nestedCall;
        }
        const nestedOutputWithoutUiOnly = stripToolOutputUiOnly(nestedCall.output);
        return {
          ...nestedCall,
          output: sanitizeUnknownForProviderOutput(
            stripImageToolOutputForModel(nestedOutputWithoutUiOnly)
          ),
        };
      });
      return {
        ...part,
        ...(nestedCalls ? { nestedCalls } : {}),
        output: sanitizedOutput,
      };
    });

    return {
      ...msg,
      parts: newParts,
    } satisfies MuxMessage;
  });
}
