/**
 * Shared type definitions for AI tools
 * These types are used by both the tool implementations and UI components
 */

import type { z } from "zod";
import type { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

// Bash Tool Types
export interface BashToolArgs {
  script: string;
  timeout_secs?: number; // Optional: defaults to 3 seconds for interactivity
  run_in_background?: boolean; // Run without blocking (for long-running processes)
  display_name: string; // Required - used as process identifier if sent to background
}

interface CommonBashFields {
  // wall_duration_ms is provided to give the agent a sense of how long a command takes which
  // should inform future timeouts.
  wall_duration_ms: number;
}

export type BashToolResult =
  | (CommonBashFields & {
      success: true;
      output: string;
      exitCode: 0;
      note?: string; // Agent-only message (not displayed in UI)
      truncated?: {
        reason: string;
        totalLines: number;
      };
    })
  | (CommonBashFields & {
      success: true;
      output: string;
      exitCode: 0;
      backgroundProcessId: string; // Background spawn succeeded
    })
  | (CommonBashFields & {
      success: false;
      output?: string;
      exitCode: number;
      error: string;
      note?: string; // Agent-only message (not displayed in UI)
      truncated?: {
        reason: string;
        totalLines: number;
      };
    });

// File Read Tool Types
export interface FileReadToolArgs {
  filePath: string;
  offset?: number; // 1-based starting line number (optional)
  limit?: number; // number of lines to return from offset (optional)
}

export type FileReadToolResult =
  | {
      success: true;
      file_size: number;
      modifiedTime: string;
      lines_read: number;
      content: string;
      warning?: string;
    }
  | {
      success: false;
      error: string;
    };

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

export type FileEditInsertToolResult = FileEditDiffSuccessBase | FileEditErrorResult;

export interface FileEditReplaceStringToolArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_count?: number;
}

export type FileEditReplaceStringToolResult =
  | (FileEditDiffSuccessBase & {
      edits_applied: number;
    })
  | FileEditErrorResult;

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

export type FileEditToolArgs =
  | FileEditReplaceStringToolArgs
  | FileEditReplaceLinesToolArgs
  | FileEditInsertToolArgs;

// Propose Plan Tool Types
// Args derived from schema
export type ProposePlanToolArgs = z.infer<typeof TOOL_DEFINITIONS.propose_plan.schema>;

// Result type for new file-based propose_plan tool
export interface ProposePlanToolResult {
  success: true;
  planPath: string;
  planContent: string;
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
  timeout_secs: number;
}

export type BashOutputToolResult =
  | {
      success: true;
      status: "running" | "exited" | "killed" | "failed";
      output: string;
      exitCode?: number;
      note?: string; // Agent-only message (not displayed in UI)
      // Time spent waiting for output (helps agent detect/avoid busy loops)
      elapsed_ms: number;
    }
  | { success: false; error: string };

// Bash Background Tool Types
export interface BashBackgroundTerminateArgs {
  process_id: string;
}

export type BashBackgroundTerminateResult =
  | { success: true; message: string; display_name?: string }
  | { success: false; error: string };

// Bash Background List Tool Types
export type BashBackgroundListArgs = Record<string, never>;

export interface BashBackgroundListProcess {
  process_id: string;
  status: "running" | "exited" | "killed" | "failed";
  script: string;
  uptime_ms: number;
  exitCode?: number;
  display_name?: string; // Human-readable name (e.g., "Dev Server")
}

export type BashBackgroundListResult =
  | { success: true; processes: BashBackgroundListProcess[] }
  | { success: false; error: string };

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

export type WebFetchToolResult =
  | {
      success: true;
      title: string;
      content: string;
      url: string;
      byline?: string;
      length: number;
    }
  | {
      success: false;
      error: string;
      /** Parsed error response body (e.g., from HTTP 4xx/5xx pages) */
      content?: string;
    };
