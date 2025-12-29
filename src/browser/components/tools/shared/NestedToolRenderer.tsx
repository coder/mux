import React from "react";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolStatus } from "./toolUtils";
import { GenericToolCall } from "../GenericToolCall";
import { BashToolCall } from "../BashToolCall";
import { FileEditToolCall } from "../FileEditToolCall";
import { FileReadToolCall } from "../FileReadToolCall";
import { WebFetchToolCall } from "../WebFetchToolCall";
import {
  TaskToolCall,
  TaskAwaitToolCall,
  TaskListToolCall,
  TaskTerminateToolCall,
} from "../TaskToolCall";
import type {
  BashToolArgs,
  BashToolResult,
  FileReadToolArgs,
  FileReadToolResult,
  FileEditReplaceStringToolArgs,
  FileEditReplaceStringToolResult,
  FileEditInsertToolArgs,
  FileEditInsertToolResult,
  WebFetchToolArgs,
  WebFetchToolResult,
  TaskToolArgs,
  TaskToolSuccessResult,
  TaskAwaitToolArgs,
  TaskAwaitToolSuccessResult,
  TaskListToolArgs,
  TaskListToolSuccessResult,
  TaskTerminateToolArgs,
  TaskTerminateToolSuccessResult,
} from "@/common/types/tools";

interface NestedToolRendererProps {
  toolName: string;
  input: unknown;
  output?: unknown;
  status: ToolStatus;
}

// Type guards - reuse schemas from TOOL_DEFINITIONS for validation
function isBashTool(toolName: string, args: unknown): args is BashToolArgs {
  return toolName === "bash" && TOOL_DEFINITIONS.bash.schema.safeParse(args).success;
}

function isFileReadTool(toolName: string, args: unknown): args is FileReadToolArgs {
  return toolName === "file_read" && TOOL_DEFINITIONS.file_read.schema.safeParse(args).success;
}

function isFileEditReplaceStringTool(
  toolName: string,
  args: unknown
): args is FileEditReplaceStringToolArgs {
  return (
    toolName === "file_edit_replace_string" &&
    TOOL_DEFINITIONS.file_edit_replace_string.schema.safeParse(args).success
  );
}

function isFileEditInsertTool(toolName: string, args: unknown): args is FileEditInsertToolArgs {
  return (
    toolName === "file_edit_insert" &&
    TOOL_DEFINITIONS.file_edit_insert.schema.safeParse(args).success
  );
}

function isWebFetchTool(toolName: string, args: unknown): args is WebFetchToolArgs {
  return toolName === "web_fetch" && TOOL_DEFINITIONS.web_fetch.schema.safeParse(args).success;
}

function isTaskTool(toolName: string, args: unknown): args is TaskToolArgs {
  return toolName === "task" && TOOL_DEFINITIONS.task.schema.safeParse(args).success;
}

function isTaskAwaitTool(toolName: string, args: unknown): args is TaskAwaitToolArgs {
  return toolName === "task_await" && TOOL_DEFINITIONS.task_await.schema.safeParse(args).success;
}

function isTaskListTool(toolName: string, args: unknown): args is TaskListToolArgs {
  return toolName === "task_list" && TOOL_DEFINITIONS.task_list.schema.safeParse(args).success;
}

function isTaskTerminateTool(toolName: string, args: unknown): args is TaskTerminateToolArgs {
  return (
    toolName === "task_terminate" && TOOL_DEFINITIONS.task_terminate.schema.safeParse(args).success
  );
}

/**
 * Routes nested tool calls to their specialized components.
 * Similar to ToolMessage.tsx but for nested PTC calls with simpler props.
 */
export const NestedToolRenderer: React.FC<NestedToolRendererProps> = ({
  toolName,
  input,
  output,
  status,
}) => {
  // Bash - full styling with icons
  if (isBashTool(toolName, input)) {
    return (
      <BashToolCall args={input} result={output as BashToolResult | undefined} status={status} />
    );
  }

  // File read - shows file icon and content preview
  if (isFileReadTool(toolName, input)) {
    return (
      <FileReadToolCall
        args={input}
        result={output as FileReadToolResult | undefined}
        status={status}
      />
    );
  }

  // File edit (replace string) - shows diff with icons
  if (isFileEditReplaceStringTool(toolName, input)) {
    return (
      <FileEditToolCall
        toolName="file_edit_replace_string"
        args={input}
        result={output as FileEditReplaceStringToolResult | undefined}
        status={status}
      />
    );
  }

  // File edit (insert) - shows diff with icons
  if (isFileEditInsertTool(toolName, input)) {
    return (
      <FileEditToolCall
        toolName="file_edit_insert"
        args={input}
        result={output as FileEditInsertToolResult | undefined}
        status={status}
      />
    );
  }

  // Web fetch - shows URL and content
  if (isWebFetchTool(toolName, input)) {
    return (
      <WebFetchToolCall
        args={input}
        result={output as WebFetchToolResult | undefined}
        status={status}
      />
    );
  }

  // Task tools - for spawning/managing subagents from within code_execution
  if (isTaskTool(toolName, input)) {
    return (
      <TaskToolCall
        args={input}
        result={output as TaskToolSuccessResult | undefined}
        status={status}
      />
    );
  }

  if (isTaskAwaitTool(toolName, input)) {
    return (
      <TaskAwaitToolCall
        args={input}
        result={output as TaskAwaitToolSuccessResult | undefined}
        status={status}
      />
    );
  }

  if (isTaskListTool(toolName, input)) {
    return (
      <TaskListToolCall
        args={input}
        result={output as TaskListToolSuccessResult | undefined}
        status={status}
      />
    );
  }

  if (isTaskTerminateTool(toolName, input)) {
    return (
      <TaskTerminateToolCall
        args={input}
        result={output as TaskTerminateToolSuccessResult | undefined}
        status={status}
      />
    );
  }

  // Fallback for MCP tools and other unsupported tools
  return <GenericToolCall toolName={toolName} args={input} result={output} status={status} />;
};
