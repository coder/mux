/**
 * Shared type definitions for AI tools
 * These types are used by both the tool implementations and UI components
 */

import type { z } from "zod";
import type {
  AgentReportToolResultSchema,
  AskUserQuestionOptionSchema,
  AskUserQuestionQuestionSchema,
  AskUserQuestionToolResultSchema,
  BashBackgroundListResultSchema,
  BashBackgroundTerminateResultSchema,
  BashOutputToolResultSchema,
  BashToolResultSchema,
  FileEditInsertToolResultSchema,
  FileEditReplaceStringToolResultSchema,
  FileReadToolResultSchema,
  TaskToolResultSchema,
  TOOL_DEFINITIONS,
  WebFetchToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";

// Bash Tool Types
export interface BashToolArgs {
  script: string;
  timeout_secs: number; // Required - defaults should be applied by producers
  run_in_background?: boolean; // Run without blocking (for long-running processes)
  display_name: string; // Required - used as process identifier if sent to background
}

// BashToolResult derived from Zod schema (single source of truth)
export type BashToolResult = z.infer<typeof BashToolResultSchema>;

// File Read Tool Types
export interface FileReadToolArgs {
  filePath: string;
  offset?: number; // 1-based starting line number (optional)
  limit?: number; // number of lines to return from offset (optional)
}

// FileReadToolResult derived from Zod schema (single source of truth)
export type FileReadToolResult = z.infer<typeof FileReadToolResultSchema>;

export interface FileEditDiffSuccessBase {
  success: true;
  diff: string;
  warning?: string;
}

export interface FileEditErrorResult {
  success: false;
  error: string;
  note?: string; // Agent-only message (not displayed in UI)
}

export interface FileEditInsertToolArgs {
  file_path: string;
  content: string;
  /** Optional substring that must appear immediately before the insertion point */
  before?: string;
  /** Optional substring that must appear immediately after the insertion point */
  after?: string;
}

// FileEditInsertToolResult derived from Zod schema (single source of truth)
export type FileEditInsertToolResult = z.infer<typeof FileEditInsertToolResultSchema>;

export interface FileEditReplaceStringToolArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_count?: number;
}

// FileEditReplaceStringToolResult derived from Zod schema (single source of truth)
export type FileEditReplaceStringToolResult = z.infer<typeof FileEditReplaceStringToolResultSchema>;

export interface FileEditReplaceLinesToolArgs {
  file_path: string;
  start_line: number;
  end_line: number;
  new_lines: string[];
  expected_lines?: string[];
}

export type FileEditReplaceLinesToolResult =
  | (FileEditDiffSuccessBase & {
      edits_applied: number;
      lines_replaced: number;
      line_delta: number;
    })
  | FileEditErrorResult;

export type FileEditSharedToolResult =
  | FileEditReplaceStringToolResult
  | FileEditReplaceLinesToolResult
  | FileEditInsertToolResult;

export const FILE_EDIT_TOOL_NAMES = [
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
] as const;

export type FileEditToolName = (typeof FILE_EDIT_TOOL_NAMES)[number];

/**
 * Prefix for file write denial error messages.
 * This consistent prefix helps both the UI and models detect when writes fail.
 */
export const WRITE_DENIED_PREFIX = "WRITE DENIED, FILE UNMODIFIED:";

/**
 * Prefix for edit failure notes (agent-only messages).
 * This prefix signals to the agent that the file was not modified.
 */
export const EDIT_FAILED_NOTE_PREFIX = "EDIT FAILED - file was NOT modified.";

/**
 * Common note fragments for DRY error messages
 */
export const NOTE_READ_FILE_RETRY = "Read the file to get current content, then retry.";
export const NOTE_READ_FILE_FIRST_RETRY =
  "Read the file first to get the exact current content, then retry.";
export const NOTE_READ_FILE_AGAIN_RETRY = "Read the file again and retry.";

/**
 * Tool description warning for file edit tools
 */
export const TOOL_EDIT_WARNING =
  "Always check the tool result before proceeding with other operations.";

// Generic tool error shape emitted via streamManager on tool-error parts.
export interface ToolErrorResult {
  success: false;
  error: string;
}
export type FileEditToolArgs =
  | FileEditReplaceStringToolArgs
  | FileEditReplaceLinesToolArgs
  | FileEditInsertToolArgs;

// Ask User Question Tool Types
// Args derived from schema (avoid drift)
export type AskUserQuestionToolArgs = z.infer<typeof TOOL_DEFINITIONS.ask_user_question.schema>;

export type AskUserQuestionOption = z.infer<typeof AskUserQuestionOptionSchema>;
export type AskUserQuestionQuestion = z.infer<typeof AskUserQuestionQuestionSchema>;

export type AskUserQuestionToolSuccessResult = z.infer<typeof AskUserQuestionToolResultSchema>;

export type AskUserQuestionToolResult = AskUserQuestionToolSuccessResult | ToolErrorResult;

// Task Tool Types
export type TaskToolArgs = z.infer<typeof TOOL_DEFINITIONS.task.schema>;

export type TaskToolSuccessResult = z.infer<typeof TaskToolResultSchema>;

export type TaskToolResult = TaskToolSuccessResult | ToolErrorResult;

// Agent Report Tool Types
export type AgentReportToolArgs = z.infer<typeof TOOL_DEFINITIONS.agent_report.schema>;

export type AgentReportToolResult = z.infer<typeof AgentReportToolResultSchema> | ToolErrorResult;

// Propose Plan Tool Types
// Args derived from schema
export type ProposePlanToolArgs = z.infer<typeof TOOL_DEFINITIONS.propose_plan.schema>;

// Result type for file-based propose_plan tool
// Note: planContent is NOT included to save context - plan is visible via file_edit_* diffs
// and will be included in mode transition message when switching to exec mode
export interface ProposePlanToolResult {
  success: true;
  planPath: string;
  message: string;
}

// Error result when plan file not found
export interface ProposePlanToolError {
  success: false;
  error: string;
}

/**
 * @deprecated Legacy args type for backwards compatibility with old propose_plan tool calls.
 * Old sessions may have tool calls with title + plan args stored in chat history.
 */
export interface LegacyProposePlanToolArgs {
  title: string;
  plan: string;
}

/**
 * @deprecated Legacy result type for backwards compatibility.
 */
export interface LegacyProposePlanToolResult {
  success: true;
  title: string;
  plan: string;
  message: string;
}

// Todo Tool Types
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface TodoWriteToolArgs {
  todos: TodoItem[];
}

export interface TodoWriteToolResult {
  success: true;
  count: number;
}

// Status Set Tool Types
export interface StatusSetToolArgs {
  emoji: string;
  message: string;
  url?: string;
}

// Bash Output Tool Types (read incremental output from background processes)
export interface BashOutputToolArgs {
  process_id: string;
  filter?: string;
  filter_exclude?: boolean;
  timeout_secs: number;
}

// BashOutputToolResult derived from Zod schema (single source of truth)
export type BashOutputToolResult = z.infer<typeof BashOutputToolResultSchema>;

// Bash Background Tool Types
export interface BashBackgroundTerminateArgs {
  process_id: string;
}

// BashBackgroundTerminateResult derived from Zod schema (single source of truth)
export type BashBackgroundTerminateResult = z.infer<typeof BashBackgroundTerminateResultSchema>;

// Bash Background List Tool Types
export type BashBackgroundListArgs = Record<string, never>;

// BashBackgroundListResult derived from Zod schema (single source of truth)
export type BashBackgroundListResult = z.infer<typeof BashBackgroundListResultSchema>;

// BashBackgroundListProcess extracted from result type for convenience
export type BashBackgroundListProcess = Extract<
  BashBackgroundListResult,
  { success: true }
>["processes"][number];

export type StatusSetToolResult =
  | {
      success: true;
      emoji: string;
      message: string;
      url?: string;
    }
  | {
      success: false;
      error: string;
    };

// Web Fetch Tool Types
export interface WebFetchToolArgs {
  url: string;
}

// WebFetchToolResult derived from Zod schema (single source of truth)
export type WebFetchToolResult = z.infer<typeof WebFetchToolResultSchema>;
