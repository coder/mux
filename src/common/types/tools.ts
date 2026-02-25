/**
 * Shared type definitions for AI tools
 * These types are used by both the tool implementations and UI components
 */

import type { z } from "zod";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import type {
  AgentReportToolResultSchema,
  AgentSkillReadFileToolResultSchema,
  AgentSkillReadToolResultSchema,
  AskUserQuestionOptionSchema,
  AskUserQuestionQuestionSchema,
  AskUserQuestionToolResultSchema,
  BashBackgroundListResultSchema,
  BashBackgroundTerminateResultSchema,
  BashOutputToolResultSchema,
  BashToolResultSchema,
  FileEditInsertToolResultSchema,
  FileEditReplaceStringToolResultSchema,
  MuxGlobalAgentsReadToolResultSchema,
  MuxGlobalAgentsWriteToolResultSchema,
  FileReadToolResultSchema,
  TaskToolResultSchema,
  TaskAwaitToolResultSchema,
  TaskApplyGitPatchToolResultSchema,
  TaskListToolResultSchema,
  TaskTerminateToolResultSchema,
  TOOL_DEFINITIONS,
  WebFetchToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";

// Bash Tool Types — derived from schema (avoid drift)
export type BashToolArgs = z.infer<typeof TOOL_DEFINITIONS.bash.schema>;

// BashToolResult derived from Zod schema (single source of truth)
export type BashToolResult = z.infer<typeof BashToolResultSchema>;

// File Read Tool Types — derived from schema (avoid drift)
export type FileReadToolArgs = z.infer<typeof TOOL_DEFINITIONS.file_read.schema>;

// Agent Skill Tool Types
// Args derived from schema (avoid drift)
export type AgentSkillReadToolArgs = z.infer<typeof TOOL_DEFINITIONS.agent_skill_read.schema>;
export type AgentSkillReadToolResult = z.infer<typeof AgentSkillReadToolResultSchema>;

export type AgentSkillReadFileToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.agent_skill_read_file.schema
>;
export type AgentSkillReadFileToolResult = z.infer<typeof AgentSkillReadFileToolResultSchema>;

// agent_skill_list result
export type AgentSkillListToolResult =
  | { success: true; skills: AgentSkillDescriptor[] }
  | { success: false; error: string };

// agent_skill_write result
export type AgentSkillWriteToolResult =
  | { success: true; diff: string; ui_only?: { file_edit?: { diff: string } } }
  | { success: false; error: string };

// agent_skill_delete result
export type AgentSkillDeleteToolResult =
  | { success: true; deleted: "file" | "skill" }
  | { success: false; error: string };

export interface AskUserQuestionUiOnlyPayload {
  questions: AskUserQuestionQuestion[];
  answers: Record<string, string>;
}

export interface FileEditUiOnlyPayload {
  diff: string;
}

export interface NotifyUiOnlyPayload {
  notifiedVia: "electron" | "browser";
  workspaceId?: string;
}

export interface ToolOutputUiOnly {
  ask_user_question?: AskUserQuestionUiOnlyPayload;
  file_edit?: FileEditUiOnlyPayload;
  notify?: NotifyUiOnlyPayload;
}

export interface ToolOutputUiOnlyFields {
  ui_only?: ToolOutputUiOnly;
}

// FileReadToolResult derived from Zod schema (single source of truth)
export type FileReadToolResult = z.infer<typeof FileReadToolResultSchema>;

// mux_global_agents_* tool types
export type MuxGlobalAgentsReadToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.mux_global_agents_read.schema
>;
export type MuxGlobalAgentsReadToolResult = z.infer<typeof MuxGlobalAgentsReadToolResultSchema>;

export type MuxGlobalAgentsWriteToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.mux_global_agents_write.schema
>;
export type MuxGlobalAgentsWriteToolResult = z.infer<typeof MuxGlobalAgentsWriteToolResultSchema>;

export interface FileEditDiffSuccessBase extends ToolOutputUiOnlyFields {
  success: true;
  diff: string;
  warning?: string;
}

export const FILE_EDIT_DIFF_OMITTED_MESSAGE =
  "[diff omitted in context - call file_read on the target file if needed]";

export interface FileEditErrorResult extends ToolOutputUiOnlyFields {
  success: false;
  error: string;
  note?: string; // Agent-only message (not displayed in UI)
}

// FileEditInsertToolArgs derived from schema (avoid drift)
export type FileEditInsertToolArgs = z.infer<typeof TOOL_DEFINITIONS.file_edit_insert.schema>;

// FileEditInsertToolResult derived from Zod schema (single source of truth)
export type FileEditInsertToolResult = z.infer<typeof FileEditInsertToolResultSchema>;

// FileEditReplaceStringToolArgs derived from schema (avoid drift)
export type FileEditReplaceStringToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.file_edit_replace_string.schema
>;

// FileEditReplaceStringToolResult derived from Zod schema (single source of truth)
export type FileEditReplaceStringToolResult = z.infer<typeof FileEditReplaceStringToolResultSchema>;

// FileEditReplaceLinesToolArgs derived from schema (avoid drift)
export type FileEditReplaceLinesToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.file_edit_replace_lines.schema
>;

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
export interface ToolErrorResult extends ToolOutputUiOnlyFields {
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

// Task Await Tool Types
export type TaskAwaitToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_await.schema>;

export type TaskAwaitToolSuccessResult = z.infer<typeof TaskAwaitToolResultSchema>;

// Task Apply Git Patch Tool Types
export type TaskApplyGitPatchToolArgs = z.infer<
  typeof TOOL_DEFINITIONS.task_apply_git_patch.schema
>;

export type TaskApplyGitPatchToolSuccessResult = z.infer<typeof TaskApplyGitPatchToolResultSchema>;

export type TaskApplyGitPatchToolResult = TaskApplyGitPatchToolSuccessResult | ToolErrorResult;

export type TaskAwaitToolResult = TaskAwaitToolSuccessResult | ToolErrorResult;

// Task List Tool Types
export type TaskListToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_list.schema>;

export type TaskListToolSuccessResult = z.infer<typeof TaskListToolResultSchema>;

export type TaskListToolResult = TaskListToolSuccessResult | ToolErrorResult;

// Task Terminate Tool Types
export type TaskTerminateToolArgs = z.infer<typeof TOOL_DEFINITIONS.task_terminate.schema>;

export type TaskTerminateToolSuccessResult = z.infer<typeof TaskTerminateToolResultSchema>;

export type TaskTerminateToolResult = TaskTerminateToolSuccessResult | ToolErrorResult;

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

// Todo Tool Types — derived from schema (avoid drift)
export type TodoWriteToolArgs = z.infer<typeof TOOL_DEFINITIONS.todo_write.schema>;
export type TodoItem = TodoWriteToolArgs["todos"][number];

export interface TodoWriteToolResult {
  success: true;
  count: number;
}

// Status Set Tool Types — derived from schema (avoid drift)
export type StatusSetToolArgs = z.infer<typeof TOOL_DEFINITIONS.status_set.schema>;

// Bash Output Tool Types — derived from schema (avoid drift)
export type BashOutputToolArgs = z.infer<typeof TOOL_DEFINITIONS.bash_output.schema>;

// BashOutputToolResult derived from Zod schema (single source of truth)
export type BashOutputToolResult = z.infer<typeof BashOutputToolResultSchema>;

// Bash Background Tool Types — derived from schema (avoid drift)
export type BashBackgroundTerminateArgs = z.infer<
  typeof TOOL_DEFINITIONS.bash_background_terminate.schema
>;

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

// Web Fetch Tool Types — derived from schema (avoid drift)
export type WebFetchToolArgs = z.infer<typeof TOOL_DEFINITIONS.web_fetch.schema>;

// WebFetchToolResult derived from Zod schema (single source of truth)
export type WebFetchToolResult = z.infer<typeof WebFetchToolResultSchema>;

// Notify Tool Types
export type NotifyToolResult =
  | (ToolOutputUiOnlyFields & {
      success: true;
      title: string;
      message?: string;
    })
  | {
      success: false;
      error: string;
    };

// ═══════════════════════════════════════════════════════════════════════════════
// Hook Output Types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tool results may include hook_output when a tool hook (pre/post) produced output.
 * This is added by withHooks.ts in the backend.
 */
export interface WithHookOutput {
  hook_output?: string;
  /** Total hook execution time (pre + post) in milliseconds */
  hook_duration_ms?: number;
  /** Path to the hook file that produced this output (helps the model investigate/modify) */
  hook_path?: string;
}

/**
 * Type utility to add hook_output to any tool result type.
 * Use this when you need to represent a result that may have hook output attached.
 */
export type MayHaveHookOutput<T> = T & WithHookOutput;
