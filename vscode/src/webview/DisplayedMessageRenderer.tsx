import React from "react";

import type { DisplayedMessage } from "mux/common/types/message";

import { AssistantMessage } from "mux/browser/components/Messages/AssistantMessage";
import { HistoryHiddenMessage } from "mux/browser/components/Messages/HistoryHiddenMessage";
import { InitMessage } from "mux/browser/components/Messages/InitMessage";
import { MarkdownRenderer } from "mux/browser/components/Messages/MarkdownRenderer";
import { MessageWindow } from "mux/browser/components/Messages/MessageWindow";
import { ReasoningMessage } from "mux/browser/components/Messages/ReasoningMessage";
import { StreamErrorMessage } from "mux/browser/components/Messages/StreamErrorMessage";
import { ToolMessage } from "mux/browser/components/Messages/ToolMessage";
import { UserMessage } from "mux/browser/components/Messages/UserMessage";

export function DisplayedMessageRenderer(props: {
  message: DisplayedMessage;
  workspaceId: string | null;
}): JSX.Element | null {
  const message = props.message;

  switch (message.type) {
    case "user":
      return <UserMessage message={message} />;

    case "assistant":
      return <AssistantMessage message={message} workspaceId={props.workspaceId ?? undefined} />;

    case "reasoning":
      return <ReasoningMessage message={message} />;

    case "stream-error":
      return <StreamErrorMessage message={message} />;

    case "history-hidden":
      return <HistoryHiddenMessage message={message} />;

    case "workspace-init":
      return <InitMessage message={message} />;

    case "plan-display": {
      // Ephemeral plan output (e.g. /plan). Render it as an assistant-style markdown block.
      return (
        <MessageWindow label={null} variant="assistant" message={message}>
          <MarkdownRenderer content={message.content} />
        </MessageWindow>
      );
    }

    case "tool":
      return <ToolMessage message={message} workspaceId={props.workspaceId ?? undefined} />;

    default: {
      const _exhaustive: never = message;
      console.error("mux webview: unknown displayed message", _exhaustive);
      return null;
    }
  }
}
