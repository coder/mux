import type { CompletedMessagePart } from "@/common/types/stream";
import type { MockAssistantEvent } from "./scenarioTypes";
import type { MockAiRouterReply } from "./mockAiRouter";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

const DEFAULT_STREAM_CHUNK_CHARS = 24;
const DEFAULT_STREAM_CHUNK_DELAY_MS = 25;

function chunkText(text: string, chunkChars: number): string[] {
  if (text.length === 0) {
    return [];
  }

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) {
    chunks.push(text.slice(i, i + chunkChars));
  }
  return chunks;
}

export interface BuildMockStreamEventsOptions {
  messageId: string;
  model?: string;
  mode?: "plan" | "exec" | "compact";

  /** Chunk size for stream-delta events. */
  chunkChars?: number;
  /** Delay between chunk emissions. */
  chunkDelayMs?: number;
}

/**
 * Convert a high-level mock reply into low-level stream events.
 *
 * IMPORTANT: This is the ONLY place the mock router reply is translated into
 * stream semantics (stream-start/delta/end, usage-delta, etc).
 */
export function buildMockStreamEventsFromReply(
  reply: MockAiRouterReply,
  options: BuildMockStreamEventsOptions
): MockAssistantEvent[] {
  const model = options.model ?? KNOWN_MODELS.OPUS.id;
  const mode = options.mode ?? reply.mode;

  const chunkChars = options.chunkChars ?? DEFAULT_STREAM_CHUNK_CHARS;
  const chunkDelayMs = options.chunkDelayMs ?? DEFAULT_STREAM_CHUNK_DELAY_MS;

  const events: MockAssistantEvent[] = [];

  events.push({
    kind: "stream-start",
    delay: 0,
    messageId: options.messageId,
    model,
    ...(mode && { mode }),
  });

  if (reply.usage) {
    events.push({
      kind: "usage-delta",
      delay: 5,
      usage: reply.usage,
      cumulativeUsage: reply.usage,
    });
  }

  const chunks = chunkText(reply.assistantText, chunkChars);
  for (const [index, chunk] of chunks.entries()) {
    events.push({
      kind: "stream-delta",
      delay: 10 + index * chunkDelayMs,
      text: chunk,
    });
  }

  const parts: CompletedMessagePart[] = [{ type: "text", text: reply.assistantText }];

  events.push({
    kind: "stream-end",
    delay: 10 + chunks.length * chunkDelayMs,
    metadata: {
      model,
      systemMessageTokens: 0,
    },
    parts,
  });

  return events;
}
