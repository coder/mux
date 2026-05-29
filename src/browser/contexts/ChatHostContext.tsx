import React, { createContext, useContext } from "react";

import type { FilePart } from "@/common/orpc/types";
import {
  CHAT_UI_FEATURE_IDS,
  type ChatUiFeatureId,
  type ChatUiSupport,
} from "@/common/constants/chatUiFeatures";
import type { ReviewNoteData } from "@/common/types/review";

export interface ChatHostActions {
  editUserMessage?: (messageId: string, content: string, fileParts?: FilePart[]) => void;
  addReviewNote?: (data: ReviewNoteData) => void;
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
}): JSX.Element {
  return <ChatHostContext.Provider value={props.value}>{props.children}</ChatHostContext.Provider>;
}

export function useChatHostContext(): ChatHostContextValue {
  return useContext(ChatHostContext);
}
