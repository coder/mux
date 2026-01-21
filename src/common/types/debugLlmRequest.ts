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

  model: string;
  providerName: string;
  thinkingLevel: string;

  mode?: string;
  agentId?: string;
  maxOutputTokens?: number;

  systemMessage: string;
  /** Final ModelMessage[] after transforms, stored as unknown for IPC safety */
  messages: unknown[];
}
