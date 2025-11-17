import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { ToolMessage } from "./ToolMessage";
import { ReasoningMessage } from "./ReasoningMessage";
import { StreamErrorMessage } from "./StreamErrorMessage";
import { HistoryHiddenMessage } from "./HistoryHiddenMessage";
import { InitMessage } from "./InitMessage";

interface MessageRendererProps {
  message: DisplayedMessage;
  className?: string;
  onEditUserMessage?: (messageId: string, content: string) => void;
  onEditQueuedMessage?: () => void;
  workspaceId?: string;
  isCompacting?: boolean;
}

// Memoized to prevent unnecessary re-renders when parent (AIView) updates
export const MessageRenderer = React.memo<MessageRendererProps>(
  ({ message, className, onEditUserMessage, workspaceId, isCompacting }) => {
    // Route based on message type
    switch (message.type) {
      case "user":
        return (
          <UserMessage
            message={message}
            className={className}
            onEdit={onEditUserMessage}
            isCompacting={isCompacting}
          />
        );
      case "assistant":
        return (
          <AssistantMessage
            message={message}
            className={className}
            workspaceId={workspaceId}
            isCompacting={isCompacting}
          />
        );
      case "tool":
        return <ToolMessage message={message} className={className} workspaceId={workspaceId} />;
      case "reasoning":
        return <ReasoningMessage message={message} className={className} />;
      case "stream-error":
        return <StreamErrorMessage message={message} className={className} />;
      case "history-hidden":
        return <HistoryHiddenMessage message={message} className={className} />;
      case "workspace-init":
        return <InitMessage message={message} className={className} />;
      default:
        console.error("don't know how to render message", message);
        return null;
    }
  }
);

MessageRenderer.displayName = "MessageRenderer";
