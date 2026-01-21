import type { MuxMessage } from "../../../src/common/types/message";

export interface SharedConversationMetadata {
  workspaceId?: string;
  projectName?: string;
  model?: string;
  exportedAt: number;
  totalTokens?: number;
  sharedBy?: string;
}

/**
 * Conversation format stored in mux.md (client-side encrypted).
 *
 * NOTE: This intentionally stores raw MuxMessage[] so that mux.md can render
 * conversations using the same transformation + UI components as Mux.
 */
export interface SharedConversation {
  version: 1;
  messages: MuxMessage[];
  metadata: SharedConversationMetadata;
}
