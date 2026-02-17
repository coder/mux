import type { CompletedMessagePart } from "@/common/types/stream";
import type { MessageSource, MuxMessage } from "@/common/types/message";

export const CRITIC_DONE_SENTINEL = "/done";

const FALLBACK_USER_CONTENT = "[CONTINUE]";

const BASE_CRITIC_INSTRUCTIONS = [
  "You are the Critic in an actor-critic loop.",
  "Review the actor's latest response for correctness, completeness, edge cases, and risks.",
  "When revisions are required, provide concise actionable feedback for the actor.",
  `Stop only when your entire response is exactly ${CRITIC_DONE_SENTINEL}.`,
].join("\n");

function getMessageSource(message: MuxMessage): MessageSource {
  return message.metadata?.messageSource === "critic" ? "critic" : "actor";
}

function cloneMessage(message: MuxMessage): MuxMessage {
  return {
    ...message,
    metadata: message.metadata ? { ...message.metadata } : undefined,
    parts: message.parts.map((part) => {
      if (part.type === "dynamic-tool") {
        return {
          ...part,
          ...(part.nestedCalls
            ? { nestedCalls: part.nestedCalls.map((call) => ({ ...call })) }
            : {}),
        };
      }
      return { ...part };
    }),
  };
}

function serializeMessageParts(message: MuxMessage): string {
  const serializedParts = message.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }

      if (part.type === "reasoning") {
        return `[reasoning]\n${part.text}`;
      }

      if (part.type === "file") {
        const filename = part.filename?.trim() ? part.filename : "unnamed";
        return `[file]\n${filename} (${part.mediaType})`;
      }

      const toolPayload: Record<string, unknown> = {
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        state: part.state,
        input: part.input,
      };

      if (part.state === "output-available") {
        toolPayload.output = part.output;
      }

      if (part.state === "output-redacted") {
        toolPayload.failed = part.failed === true;
      }

      if (part.nestedCalls && part.nestedCalls.length > 0) {
        toolPayload.nestedCalls = part.nestedCalls;
      }

      return `[tool]\n${JSON.stringify(toolPayload, null, 2)}`;
    })
    .filter((chunk) => chunk.trim().length > 0);

  return serializedParts.join("\n\n").trim();
}

function buildTextMessage(
  original: MuxMessage,
  role: "assistant" | "user",
  text: string
): MuxMessage {
  const content = text.trim().length > 0 ? text : FALLBACK_USER_CONTENT;
  return {
    id: original.id,
    role,
    metadata: {
      timestamp: original.metadata?.timestamp,
      synthetic: true,
    },
    parts: [
      {
        type: "text",
        text: content,
      },
    ],
  };
}

export function buildCriticAdditionalInstructions(args: {
  actorAdditionalInstructions?: string;
  criticPrompt?: string | null;
}): string {
  const sections: string[] = [BASE_CRITIC_INSTRUCTIONS];

  const actorAdditional = args.actorAdditionalInstructions?.trim();
  if (actorAdditional && actorAdditional.length > 0) {
    sections.push(`Actor additional instructions (context only):\n${actorAdditional}`);
  }

  const criticPrompt = args.criticPrompt?.trim();
  if (criticPrompt && criticPrompt.length > 0) {
    sections.push(`User Critic Prompt:\n${criticPrompt}`);
  }

  return sections.join("\n\n");
}

/**
 * Build a role-flipped request history for critic turns.
 *
 * - User messages become assistant context
 * - Actor assistant messages become user feedback targets
 * - Critic assistant messages stay assistant (critic's own prior context)
 * - Tool calls are serialized into JSON text blocks
 */
export function buildCriticRequestHistory(history: MuxMessage[]): MuxMessage[] {
  return history.map((message) => {
    if (message.role === "assistant") {
      const source = getMessageSource(message);
      const flippedRole = source === "critic" ? "assistant" : "user";
      return buildTextMessage(message, flippedRole, serializeMessageParts(message));
    }

    if (message.role === "user") {
      return buildTextMessage(message, "assistant", serializeMessageParts(message));
    }

    return cloneMessage(message);
  });
}

/**
 * Build actor request history from persisted interwoven actor+critic messages.
 *
 * Critic assistant messages are transformed into user feedback messages so the actor can
 * treat them as actionable critique without mutating persisted chat history.
 */
function getCriticDoneCandidateText(parts: Array<{ type: string; text?: string }>): string | null {
  if (parts.length === 0) {
    return null;
  }

  // Thinking-enabled critics may emit reasoning parts alongside visible text.
  // Treat reasoning as non-user-visible metadata when checking the /done sentinel.
  if (parts.some((part) => part.type !== "text" && part.type !== "reasoning")) {
    return null;
  }

  const textParts = parts.filter((part): part is { type: "text"; text: string } => {
    return part.type === "text" && typeof part.text === "string";
  });
  if (textParts.length === 0) {
    return null;
  }

  return textParts
    .map((part) => part.text)
    .join("")
    .trim();
}

export function buildActorRequestHistoryWithCriticFeedback(history: MuxMessage[]): MuxMessage[] {
  const transformed: MuxMessage[] = [];

  for (const message of history) {
    if (message.role !== "assistant" || getMessageSource(message) !== "critic") {
      transformed.push(cloneMessage(message));
      continue;
    }

    if (getCriticDoneCandidateText(message.parts) === CRITIC_DONE_SENTINEL) {
      continue;
    }

    const serialized = serializeMessageParts(message);
    transformed.push(buildTextMessage(message, "user", serialized));
  }

  return transformed;
}

export function isCriticDoneResponse(parts: CompletedMessagePart[]): boolean {
  return getCriticDoneCandidateText(parts) === CRITIC_DONE_SENTINEL;
}
