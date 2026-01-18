import React, { createContext, useContext } from "react";

interface MessageListContextValue {
  workspaceId: string;
  latestMessageId: string | null;
}

const MessageListContext = createContext<MessageListContextValue | null>(null);

interface MessageListProviderProps {
  value: MessageListContextValue;
  children: React.ReactNode;
}

export const MessageListProvider: React.FC<MessageListProviderProps> = (props) => {
  return (
    <MessageListContext.Provider value={props.value}>{props.children}</MessageListContext.Provider>
  );
};

export function useOptionalMessageListContext(): MessageListContextValue | null {
  return useContext(MessageListContext);
}

export function useMessageListContext(): MessageListContextValue {
  const context = useContext(MessageListContext);
  if (!context) {
    throw new Error("useMessageListContext must be used within MessageListProvider");
  }
  return context;
}
