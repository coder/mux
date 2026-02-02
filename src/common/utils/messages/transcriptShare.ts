import type { MuxMessage, MuxToolPart } from "@/common/types/message";
import type { NestedToolCall } from "@/common/orpc/schemas/message";

export interface BuildChatJsonlForSharingOptions {
  /** Defaults to true */
  includeToolOutput?: boolean;
  /** Optional workspace context to match on-disk chat.jsonl entries */
  workspaceId?: string;
}

interface ChatJsonlEntry extends MuxMessage {
  workspaceId?: string;
}

function stripNestedToolCallOutput(call: NestedToolCall): NestedToolCall {
  if (call.state !== "output-available") {
    return call;
  }

  const { output: _output, ...rest } = call;
  return {
    ...rest,
    state: "input-available",
  };
}

function stripToolPartOutput(part: MuxToolPart): MuxToolPart {
  const nestedCalls = part.nestedCalls?.map(stripNestedToolCallOutput);

  if (part.state !== "output-available") {
    return nestedCalls ? { ...part, nestedCalls } : part;
  }

  const { output: _output, ...rest } = part;
  return {
    ...rest,
    state: "input-available",
    nestedCalls,
  };
}

function stripToolOutputsForSharing(messages: MuxMessage[]): MuxMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") {
      return msg;
    }

    const parts = msg.parts.map((part) => {
      if (part.type !== "dynamic-tool") {
        return part;
      }
      return stripToolPartOutput(part);
    });

    return {
      ...msg,
      parts,
    };
  });
}

/**
 * Build a JSONL transcript (one message per line, trailing newline) suitable for sharing.
 *
 * NOTE: This is intentionally not the same as the UI-rendered transcript.
 * It preserves raw message structure from chat.jsonl, with an option to strip tool outputs.
 */
export function buildChatJsonlForSharing(
  messages: MuxMessage[],
  options: BuildChatJsonlForSharingOptions = {}
): string {
  if (messages.length === 0) return "";

  const includeToolOutput = options.includeToolOutput ?? true;
  const sanitized = includeToolOutput ? messages : stripToolOutputsForSharing(messages);

  return (
    sanitized
      .map((msg): ChatJsonlEntry => {
        if (options.workspaceId === undefined) {
          return msg;
        }
        return {
          ...msg,
          workspaceId: options.workspaceId,
        };
      })
      .map((msg) => JSON.stringify(msg))
      .join("\n") + "\n"
  );
}
