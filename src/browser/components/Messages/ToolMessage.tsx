import React from "react";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { DisplayedMessage } from "@/common/types/message";
import { GenericToolCall } from "../tools/GenericToolCall";
import { BashToolCall } from "../tools/BashToolCall";
import { FileEditToolCall } from "../tools/FileEditToolCall";
import { FileReadToolCall } from "../tools/FileReadToolCall";
import { AskUserQuestionToolCall } from "../tools/AskUserQuestionToolCall";
import { ProposePlanToolCall } from "../tools/ProposePlanToolCall";
import { TodoToolCall } from "../tools/TodoToolCall";
import { StatusSetToolCall } from "../tools/StatusSetToolCall";
import { WebFetchToolCall } from "../tools/WebFetchToolCall";
import { BashBackgroundListToolCall } from "../tools/BashBackgroundListToolCall";
import { BashBackgroundTerminateToolCall } from "../tools/BashBackgroundTerminateToolCall";
import { BashOutputToolCall } from "../tools/BashOutputToolCall";
import { CodeExecutionToolCall } from "../tools/CodeExecutionToolCall";
import type {
  BashToolArgs,
  BashToolResult,
  BashBackgroundListArgs,
  BashBackgroundListResult,
  BashBackgroundTerminateArgs,
  BashBackgroundTerminateResult,
  BashOutputToolArgs,
  BashOutputToolResult,
  FileReadToolArgs,
  FileReadToolResult,
  FileEditReplaceStringToolArgs,
  FileEditInsertToolArgs,
  FileEditInsertToolResult,
  FileEditReplaceStringToolResult,
  FileEditReplaceLinesToolArgs,
  FileEditReplaceLinesToolResult,
  AskUserQuestionToolArgs,
  AskUserQuestionToolResult,
  ProposePlanToolArgs,
  ProposePlanToolResult,
  TodoWriteToolArgs,
  TodoWriteToolResult,
  StatusSetToolArgs,
  StatusSetToolResult,
  WebFetchToolArgs,
  WebFetchToolResult,
} from "@/common/types/tools";
import type { ReviewNoteData } from "@/common/types/review";
import type { BashOutputGroupInfo } from "@/browser/utils/messages/messageUtils";

interface ToolMessageProps {
  message: DisplayedMessage & { type: "tool" };
  className?: string;
  workspaceId?: string;
  /** Handler for adding review notes from inline diffs */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Whether this is the latest propose_plan in the conversation */
  isLatestProposePlan?: boolean;
  /** Set of tool call IDs of foreground bashes */
  foregroundBashToolCallIds?: Set<string>;
  /** Callback to send a foreground bash to background */
  onSendBashToBackground?: (toolCallId: string) => void;
  /** Optional bash_output grouping info */
  bashOutputGroup?: BashOutputGroupInfo;
}

// Type guards using Zod schemas for single source of truth
// This ensures type guards stay in sync with tool definitions
function isBashTool(toolName: string, args: unknown): args is BashToolArgs {
  if (toolName !== "bash") return false;
  return TOOL_DEFINITIONS.bash.schema.safeParse(args).success;
}

function isFileReadTool(toolName: string, args: unknown): args is FileReadToolArgs {
  if (toolName !== "file_read") return false;
  return TOOL_DEFINITIONS.file_read.schema.safeParse(args).success;
}

function isFileEditReplaceStringTool(
  toolName: string,
  args: unknown
): args is FileEditReplaceStringToolArgs {
  if (toolName !== "file_edit_replace_string") return false;
  return TOOL_DEFINITIONS.file_edit_replace_string.schema.safeParse(args).success;
}

function isFileEditReplaceLinesTool(
  toolName: string,
  args: unknown
): args is FileEditReplaceLinesToolArgs {
  if (toolName !== "file_edit_replace_lines") return false;
  return TOOL_DEFINITIONS.file_edit_replace_lines.schema.safeParse(args).success;
}

function isFileEditInsertTool(toolName: string, args: unknown): args is FileEditInsertToolArgs {
  if (toolName !== "file_edit_insert") return false;
  return TOOL_DEFINITIONS.file_edit_insert.schema.safeParse(args).success;
}

function isAskUserQuestionTool(toolName: string, args: unknown): args is AskUserQuestionToolArgs {
  if (toolName !== "ask_user_question") return false;
  return TOOL_DEFINITIONS.ask_user_question.schema.safeParse(args).success;
}

function isProposePlanTool(toolName: string, args: unknown): args is ProposePlanToolArgs {
  if (toolName !== "propose_plan") return false;
  return TOOL_DEFINITIONS.propose_plan.schema.safeParse(args).success;
}

function isTodoWriteTool(toolName: string, args: unknown): args is TodoWriteToolArgs {
  if (toolName !== "todo_write") return false;
  return TOOL_DEFINITIONS.todo_write.schema.safeParse(args).success;
}

function isStatusSetTool(toolName: string, args: unknown): args is StatusSetToolArgs {
  if (toolName !== "status_set") return false;
  return TOOL_DEFINITIONS.status_set.schema.safeParse(args).success;
}

function isWebFetchTool(toolName: string, args: unknown): args is WebFetchToolArgs {
  if (toolName !== "web_fetch") return false;
  return TOOL_DEFINITIONS.web_fetch.schema.safeParse(args).success;
}

function isBashBackgroundListTool(toolName: string, args: unknown): args is BashBackgroundListArgs {
  if (toolName !== "bash_background_list") return false;
  return TOOL_DEFINITIONS.bash_background_list.schema.safeParse(args).success;
}

function isBashBackgroundTerminateTool(
  toolName: string,
  args: unknown
): args is BashBackgroundTerminateArgs {
  if (toolName !== "bash_background_terminate") return false;
  return TOOL_DEFINITIONS.bash_background_terminate.schema.safeParse(args).success;
}

function isBashOutputTool(toolName: string, args: unknown): args is BashOutputToolArgs {
  if (toolName !== "bash_output") return false;
  return TOOL_DEFINITIONS.bash_output.schema.safeParse(args).success;
}

interface CodeExecutionToolArgs {
  code: string;
}

function isCodeExecutionTool(toolName: string, args: unknown): args is CodeExecutionToolArgs {
  if (toolName !== "code_execution") return false;
  return TOOL_DEFINITIONS.code_execution.schema.safeParse(args).success;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  message,
  className,
  workspaceId,
  onReviewNote,
  isLatestProposePlan,
  foregroundBashToolCallIds,
  onSendBashToBackground,
  bashOutputGroup,
}) => {
  // Route to specialized components based on tool name
  if (isBashTool(message.toolName, message.args)) {
    // Only show "Background" button if this specific tool call is a foreground process
    const canSendToBackground = foregroundBashToolCallIds?.has(message.toolCallId) ?? false;
    const toolCallId = message.toolCallId;
    return (
      <div className={className}>
        <BashToolCall
          workspaceId={workspaceId}
          toolCallId={message.toolCallId}
          args={message.args}
          result={message.result as BashToolResult | undefined}
          status={message.status}
          startedAt={message.timestamp}
          canSendToBackground={canSendToBackground}
          onSendToBackground={
            onSendBashToBackground ? () => onSendBashToBackground(toolCallId) : undefined
          }
        />
      </div>
    );
  }

  if (isFileReadTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <FileReadToolCall
          args={message.args}
          result={message.result as FileReadToolResult | undefined}
          status={message.status}
        />
      </div>
    );
  }

  if (isFileEditReplaceStringTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <FileEditToolCall
          toolName="file_edit_replace_string"
          args={message.args}
          result={message.result as FileEditReplaceStringToolResult | undefined}
          status={message.status}
          onReviewNote={onReviewNote}
        />
      </div>
    );
  }

  if (isFileEditInsertTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <FileEditToolCall
          toolName="file_edit_insert"
          args={message.args}
          result={message.result as FileEditInsertToolResult | undefined}
          status={message.status}
          onReviewNote={onReviewNote}
        />
      </div>
    );
  }

  if (isFileEditReplaceLinesTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <FileEditToolCall
          toolName="file_edit_replace_lines"
          args={message.args}
          result={message.result as FileEditReplaceLinesToolResult | undefined}
          status={message.status}
          onReviewNote={onReviewNote}
        />
      </div>
    );
  }

  if (isAskUserQuestionTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <AskUserQuestionToolCall
          args={message.args}
          result={(message.result as AskUserQuestionToolResult | undefined) ?? null}
          status={message.status}
          toolCallId={message.toolCallId}
          workspaceId={workspaceId}
        />
      </div>
    );
  }

  if (isProposePlanTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <ProposePlanToolCall
          args={message.args}
          result={message.result as ProposePlanToolResult | undefined}
          status={message.status}
          workspaceId={workspaceId}
          isLatest={isLatestProposePlan}
        />
      </div>
    );
  }

  if (isTodoWriteTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <TodoToolCall
          args={message.args}
          result={message.result as TodoWriteToolResult | undefined}
          status={message.status}
        />
      </div>
    );
  }

  if (isStatusSetTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <StatusSetToolCall
          args={message.args}
          result={message.result as StatusSetToolResult | undefined}
          status={message.status}
        />
      </div>
    );
  }

  if (isWebFetchTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <WebFetchToolCall
          args={message.args}
          result={message.result as WebFetchToolResult | undefined}
          status={message.status}
        />
      </div>
    );
  }

  if (isBashBackgroundListTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <BashBackgroundListToolCall
          args={message.args}
          result={message.result as BashBackgroundListResult | undefined}
          status={message.status}
        />
      </div>
    );
  }

  if (isBashBackgroundTerminateTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <BashBackgroundTerminateToolCall
          args={message.args}
          result={message.result as BashBackgroundTerminateResult | undefined}
          status={message.status}
        />
      </div>
    );
  }

  if (isBashOutputTool(message.toolName, message.args)) {
    // Note: "middle" position items are filtered out in AIView.tsx render loop,
    // and the collapsed indicator is rendered there. ToolMessage only sees first/last.
    const groupPosition =
      bashOutputGroup?.position === "first" || bashOutputGroup?.position === "last"
        ? bashOutputGroup.position
        : undefined;

    return (
      <div className={className}>
        <BashOutputToolCall
          args={message.args}
          result={message.result as BashOutputToolResult | undefined}
          status={message.status}
          groupPosition={groupPosition}
        />
      </div>
    );
  }

  if (isCodeExecutionTool(message.toolName, message.args)) {
    return (
      <div className={className}>
        <CodeExecutionToolCall
          args={message.args}
          result={message.result as Parameters<typeof CodeExecutionToolCall>[0]["result"]}
          status={message.status}
          nestedCalls={message.nestedCalls}
        />
      </div>
    );
  }

  // Fallback to generic tool call
  return (
    <div className={className}>
      <GenericToolCall
        toolName={message.toolName}
        args={message.args}
        result={message.result}
        status={message.status}
      />
    </div>
  );
};
