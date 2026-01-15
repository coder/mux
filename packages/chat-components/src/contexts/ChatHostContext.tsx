import React, { createContext, useContext } from "react";

/**
 * Feature support levels for chat UI capabilities.
 * - "supported": Feature works normally
 * - "disabled": Feature hidden/unavailable
 * - "readonly": Feature visible but non-interactive
 */
export type ChatUiSupport = "supported" | "disabled" | "readonly";

/** Chat UI feature identifiers */
export type ChatUiFeatureId =
  | "messageEditing"
  | "toolInteraction"
  | "jsonRawView"
  | "copyToClipboard"
  | "reviewNotes"
  | "commandPalette";

export const CHAT_UI_FEATURE_IDS: ChatUiFeatureId[] = [
  "messageEditing",
  "toolInteraction",
  "jsonRawView",
  "copyToClipboard",
  "reviewNotes",
  "commandPalette",
];

export interface ChatHostActions {
  editUserMessage?: (messageId: string, content: string) => void;
  addReviewNote?: (data: unknown) => void;
  sendBashToBackground?: (toolCallId: string) => void;
  openCommandPalette?: () => void;
}

export interface ChatHostContextValue {
  uiSupport: Record<ChatUiFeatureId, ChatUiSupport>;
  actions: ChatHostActions;
}

const DEFAULT_CHAT_UI_SUPPORT: Record<ChatUiFeatureId, ChatUiSupport> = CHAT_UI_FEATURE_IDS.reduce(
  (acc, featureId) => {
    acc[featureId] = "supported";
    return acc;
  },
  {} as Record<ChatUiFeatureId, ChatUiSupport>
);

const ChatHostContext = createContext<ChatHostContextValue>({
  uiSupport: DEFAULT_CHAT_UI_SUPPORT,
  actions: {},
});

export function ChatHostContextProvider(props: {
  value: ChatHostContextValue;
  children: React.ReactNode;
}): React.JSX.Element {
  return <ChatHostContext.Provider value={props.value}>{props.children}</ChatHostContext.Provider>;
}

export function useChatHostContext(): ChatHostContextValue {
  return useContext(ChatHostContext);
}

/**
 * Create a read-only context for static conversation viewing.
 * All interactive features are disabled.
 */
export function createReadOnlyContext(): ChatHostContextValue {
  const uiSupport: Record<ChatUiFeatureId, ChatUiSupport> = {
    messageEditing: "disabled",
    toolInteraction: "readonly",
    jsonRawView: "supported", // Allow raw JSON view
    copyToClipboard: "supported", // Allow copy
    reviewNotes: "disabled",
    commandPalette: "disabled",
  };

  return {
    uiSupport,
    actions: {}, // No-op actions for read-only mode
  };
}
