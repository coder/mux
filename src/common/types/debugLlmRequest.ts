import type { CompletedMessagePart, StreamEndEvent } from "./stream";

/**
 * Captured snapshot of the exact LLM request payload for debugging.
 *
 * IMPORTANT:
 * - Must be structured-clone safe (safe to send over MessagePort/IPC)
 * - Must not include tool implementations, Zod schemas, or functions
 */
export interface DebugLlmRequestSnapshot {
  capturedAt: number;
  workspaceId: string;

  /**
   * Message ID used for the assistant placeholder / stream.
   *
   * Used to associate the request snapshot with the eventual stream-end response.
   */
  messageId?: string;

  model: string;
  providerName: string;
  thinkingLevel: string;

  mode?: string;
  agentId?: string;
  maxOutputTokens?: number;

  systemMessage: string;
  /** Final ModelMessage[] after transforms, stored as unknown for IPC safety */
  messages: unknown[];

  /** Provider-agnostic response capture from stream-end (parts + metadata). */
  response?: {
    capturedAt: number;
    metadata: StreamEndEvent["metadata"];
    parts: CompletedMessagePart[];
  };
}
