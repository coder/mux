import React from "react";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolStatus } from "./toolUtils";
import { GenericToolCall } from "../GenericToolCall";
import { BashToolCall } from "../BashToolCall";
import { FileEditToolCall } from "../FileEditToolCall";
import { FileReadToolCall } from "../FileReadToolCall";
import { WebFetchToolCall } from "../WebFetchToolCall";
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
} from "@/common/types/tools";

interface NestedToolRendererProps {
  toolName: string;
  input: unknown;
  output?: unknown;
  status: ToolStatus;
}

/**
 * Strip "mux." prefix from tool names.
 * PTC bridge exposes tools as mux.bash, mux.file_read, etc.
 */
function normalizeToolName(toolName: string): string {
  return toolName.startsWith("mux.") ? toolName.slice(4) : toolName;
}

// Type guards - reuse schemas from TOOL_DEFINITIONS for validation
function isBashTool(toolName: string, args: unknown): args is BashToolArgs {
  if (normalizeToolName(toolName) !== "bash") return false;
  return TOOL_DEFINITIONS.bash.schema.safeParse(args).success;
}

function isFileReadTool(toolName: string, args: unknown): args is FileReadToolArgs {
  if (normalizeToolName(toolName) !== "file_read") return false;
  return TOOL_DEFINITIONS.file_read.schema.safeParse(args).success;
}

function isFileEditReplaceStringTool(
  toolName: string,
  args: unknown
): args is FileEditReplaceStringToolArgs {
  if (normalizeToolName(toolName) !== "file_edit_replace_string") return false;
  return TOOL_DEFINITIONS.file_edit_replace_string.schema.safeParse(args).success;
}

function isFileEditInsertTool(toolName: string, args: unknown): args is FileEditInsertToolArgs {
  if (normalizeToolName(toolName) !== "file_edit_insert") return false;
  return TOOL_DEFINITIONS.file_edit_insert.schema.safeParse(args).success;
}

function isWebFetchTool(toolName: string, args: unknown): args is WebFetchToolArgs {
  if (normalizeToolName(toolName) !== "web_fetch") return false;
  return TOOL_DEFINITIONS.web_fetch.schema.safeParse(args).success;
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
  const normalizedName = normalizeToolName(toolName);

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

  // Fallback for MCP tools and other unsupported tools - use normalized name for display
  return <GenericToolCall toolName={normalizedName} args={input} result={output} status={status} />;
};
