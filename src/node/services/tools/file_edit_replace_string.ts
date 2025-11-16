import { tool } from "ai";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { executeFileEditOperation } from "./file_edit_operation";
import { handleStringReplace, type StringReplaceArgs } from "./file_edit_replace_shared";

export interface FileEditReplaceStringResult {
  success: true;
  diff: string;
  edits_applied: number;
}

export interface FileEditReplaceStringError {
  success: false;
  error: string;
}

export type FileEditReplaceStringToolResult =
  | FileEditReplaceStringResult
  | FileEditReplaceStringError;

/**
 * String-based file edit replace tool factory
 */
export const createFileEditReplaceStringTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.file_edit_replace_string.description,
    inputSchema: TOOL_DEFINITIONS.file_edit_replace_string.schema,
    execute: async (
      args: StringReplaceArgs,
      { abortSignal }
    ): Promise<FileEditReplaceStringToolResult> => {
      return executeFileEditOperation({
        config,
        filePath: args.file_path,
        operation: (originalContent) => handleStringReplace(args, originalContent),
        abortSignal,
      });
    },
  });
};
