import React from "react";

import type { DisplayedMessage } from "mux/common/types/message";
import { TOOL_DEFINITIONS } from "mux/common/utils/tools/toolDefinitions";

import { AssistantMessage } from "mux/browser/components/Messages/AssistantMessage";
import { HistoryHiddenMessage } from "mux/browser/components/Messages/HistoryHiddenMessage";
import { InitMessage } from "mux/browser/components/Messages/InitMessage";
import { MarkdownRenderer } from "mux/browser/components/Messages/MarkdownRenderer";
import { MessageWindow } from "mux/browser/components/Messages/MessageWindow";
import { ReasoningMessage } from "mux/browser/components/Messages/ReasoningMessage";
import { StreamErrorMessage } from "mux/browser/components/Messages/StreamErrorMessage";
import { UserMessage } from "mux/browser/components/Messages/UserMessage";

import { CodeExecutionToolCall } from "mux/browser/components/tools/CodeExecutionToolCall";
import { FileEditToolCall } from "mux/browser/components/tools/FileEditToolCall";
import { FileReadToolCall } from "mux/browser/components/tools/FileReadToolCall";
import { GenericToolCall } from "mux/browser/components/tools/GenericToolCall";
import { StatusSetToolCall } from "mux/browser/components/tools/StatusSetToolCall";
import { TodoToolCall } from "mux/browser/components/tools/TodoToolCall";
import { WebFetchToolCall } from "mux/browser/components/tools/WebFetchToolCall";

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

    case "tool": {
      const status = message.status;
      const toolName = message.toolName;
      const args = message.args;
      const result = message.result;

      if (toolName === "file_read") {
        const parsed = TOOL_DEFINITIONS.file_read.schema.safeParse(args);
        if (parsed.success) {
          return <FileReadToolCall args={parsed.data} result={result as any} status={status} />;
        }
      }

      if (
        toolName === "file_edit_replace_string" ||
        toolName === "file_edit_replace_lines" ||
        toolName === "file_edit_insert"
      ) {
        const schema = TOOL_DEFINITIONS[toolName].schema;
        const parsed = schema.safeParse(args);
        if (parsed.success) {
          return (
            <FileEditToolCall
              toolName={toolName}
              args={parsed.data as any}
              result={result as any}
              status={status}
            />
          );
        }
      }

      if (toolName === "todo_write") {
        const parsed = TOOL_DEFINITIONS.todo_write.schema.safeParse(args);
        if (parsed.success) {
          return <TodoToolCall args={parsed.data} result={result as any} status={status} />;
        }
      }

      if (toolName === "status_set") {
        const parsed = TOOL_DEFINITIONS.status_set.schema.safeParse(args);
        if (parsed.success) {
          return <StatusSetToolCall args={parsed.data} result={result as any} status={status} />;
        }
      }

      if (toolName === "web_fetch") {
        const parsed = TOOL_DEFINITIONS.web_fetch.schema.safeParse(args);
        if (parsed.success) {
          return <WebFetchToolCall args={parsed.data} result={result as any} status={status} />;
        }
      }

      if (toolName === "code_execution") {
        const parsed = TOOL_DEFINITIONS.code_execution.schema.safeParse(args);
        if (parsed.success) {
          return (
            <CodeExecutionToolCall
              args={parsed.data as any}
              result={result as any}
              status={status}
              nestedCalls={message.nestedCalls as any}
            />
          );
        }
      }

      return <GenericToolCall toolName={toolName} args={args} result={result} status={status} />;
    }

    default:
      console.error("mux webview: unknown displayed message", message);
      return null;
  }
}
