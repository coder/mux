/**
 * Tool definitions module - Frontend-safe
 *
 * Single source of truth for all tool definitions.
 * Zod schemas are defined here and JSON schemas are auto-generated.
 */

import { z } from "zod";
import {
  BASH_HARD_MAX_LINES,
  BASH_MAX_LINE_BYTES,
  BASH_MAX_TOTAL_BYTES,
  STATUS_MESSAGE_MAX_LENGTH,
  WEB_FETCH_MAX_OUTPUT_BYTES,
} from "@/common/constants/toolLimits";
import { BUILT_IN_SUBAGENT_TYPES } from "@/common/constants/agents";
import { TOOL_EDIT_WARNING } from "@/common/types/tools";

import { zodToJsonSchema } from "zod-to-json-schema";

// -----------------------------------------------------------------------------
// ask_user_question (plan-mode interactive questions)
// -----------------------------------------------------------------------------

export const AskUserQuestionOptionSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

export const AskUserQuestionQuestionSchema = z
  .object({
    question: z.string().min(1),
    header: z.string().min(1).max(12),
    options: z.array(AskUserQuestionOptionSchema).min(2).max(4),
    multiSelect: z.boolean(),
  })
  .strict()
  .superRefine((question, ctx) => {
    const labels = question.options.map((o) => o.label);
    const labelSet = new Set(labels);
    if (labelSet.size !== labels.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Option labels must be unique within a question",
        path: ["options"],
      });
    }

    // Claude Code provides "Other" automatically; do not include it explicitly.
    if (labels.some((label) => label.trim().toLowerCase() === "other")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Do not include an 'Other' option; it is provided automatically",
        path: ["options"],
      });
    }
  });

export const AskUserQuestionToolArgsSchema = z
  .object({
    questions: z.array(AskUserQuestionQuestionSchema).min(1).max(4),
    // Optional prefilled answers (Claude Code supports this, though Mux typically won't use it)
    answers: z.record(z.string(), z.string()).optional(),
  })
  .strict()
  .superRefine((args, ctx) => {
    const questionTexts = args.questions.map((q) => q.question);
    const questionTextSet = new Set(questionTexts);
    if (questionTextSet.size !== questionTexts.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question text must be unique across questions",
        path: ["questions"],
      });
    }
  });

export const AskUserQuestionToolResultSchema = z
  .object({
    questions: z.array(AskUserQuestionQuestionSchema),
    answers: z.record(z.string(), z.string()),
  })
  .strict();

// -----------------------------------------------------------------------------
// task (sub-workspaces as subagents)
// -----------------------------------------------------------------------------

const SubagentTypeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(BUILT_IN_SUBAGENT_TYPES)
);

export const TaskToolArgsSchema = z
  .object({
    subagent_type: SubagentTypeSchema,
    prompt: z.string().min(1),
    description: z.string().optional(),
    run_in_background: z.boolean().default(false),
  })
  .strict();

export const TaskToolQueuedResultSchema = z
  .object({
    status: z.enum(["queued", "running"]),
    taskId: z.string(),
  })
  .strict();

export const TaskToolCompletedResultSchema = z
  .object({
    status: z.literal("completed"),
    taskId: z.string().optional(),
    reportMarkdown: z.string(),
    title: z.string().optional(),
    agentType: z.string().optional(),
  })
  .strict();

export const TaskToolResultSchema = z.discriminatedUnion("status", [
  TaskToolQueuedResultSchema,
  TaskToolCompletedResultSchema,
]);

// -----------------------------------------------------------------------------
// task_await (await one or more sub-agent tasks)
// -----------------------------------------------------------------------------

export const TaskAwaitToolArgsSchema = z
  .object({
    task_ids: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "List of task IDs to await. When omitted, waits for all active descendant tasks of the current workspace."
      ),
    timeout_secs: z
      .number()
      .positive()
      .optional()
      .describe(
        "Maximum time to wait in seconds for each task. " +
          "If exceeded, the result returns status=queued|running|awaiting_report (task is still active). " +
          "Optional, defaults to 10 minutes."
      ),
  })
  .strict();

export const TaskAwaitToolCompletedResultSchema = z
  .object({
    status: z.literal("completed"),
    taskId: z.string(),
    reportMarkdown: z.string(),
    title: z.string().optional(),
  })
  .strict();

export const TaskAwaitToolActiveResultSchema = z
  .object({
    status: z.enum(["queued", "running", "awaiting_report"]),
    taskId: z.string(),
  })
  .strict();

export const TaskAwaitToolNotFoundResultSchema = z
  .object({
    status: z.literal("not_found"),
    taskId: z.string(),
  })
  .strict();

export const TaskAwaitToolInvalidScopeResultSchema = z
  .object({
    status: z.literal("invalid_scope"),
    taskId: z.string(),
  })
  .strict();

export const TaskAwaitToolErrorResultSchema = z
  .object({
    status: z.literal("error"),
    taskId: z.string(),
    error: z.string(),
  })
  .strict();

export const TaskAwaitToolResultSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion("status", [
        TaskAwaitToolCompletedResultSchema,
        TaskAwaitToolActiveResultSchema,
        TaskAwaitToolNotFoundResultSchema,
        TaskAwaitToolInvalidScopeResultSchema,
        TaskAwaitToolErrorResultSchema,
      ])
    ),
  })
  .strict();

// -----------------------------------------------------------------------------
// task_terminate (terminate one or more sub-agent tasks)
// -----------------------------------------------------------------------------

export const TaskTerminateToolArgsSchema = z
  .object({
    task_ids: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "List of task IDs to terminate. Each must be a descendant sub-agent task of the current workspace."
      ),
  })
  .strict();

export const TaskTerminateToolTerminatedResultSchema = z
  .object({
    status: z.literal("terminated"),
    taskId: z.string(),
    terminatedTaskIds: z
      .array(z.string())
      .describe("All terminated task IDs (includes descendants)"),
  })
  .strict();

export const TaskTerminateToolNotFoundResultSchema = z
  .object({
    status: z.literal("not_found"),
    taskId: z.string(),
  })
  .strict();

export const TaskTerminateToolInvalidScopeResultSchema = z
  .object({
    status: z.literal("invalid_scope"),
    taskId: z.string(),
  })
  .strict();

export const TaskTerminateToolErrorResultSchema = z
  .object({
    status: z.literal("error"),
    taskId: z.string(),
    error: z.string(),
  })
  .strict();

export const TaskTerminateToolResultSchema = z
  .object({
    results: z.array(
      z.discriminatedUnion("status", [
        TaskTerminateToolTerminatedResultSchema,
        TaskTerminateToolNotFoundResultSchema,
        TaskTerminateToolInvalidScopeResultSchema,
        TaskTerminateToolErrorResultSchema,
      ])
    ),
  })
  .strict();

// -----------------------------------------------------------------------------
// task_list (list descendant sub-agent tasks)
// -----------------------------------------------------------------------------

const TaskListStatusSchema = z.enum(["queued", "running", "awaiting_report", "reported"]);
const TaskListThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]);

export const TaskListToolArgsSchema = z
  .object({
    statuses: z
      .array(TaskListStatusSchema)
      .optional()
      .describe(
        "Task statuses to include. Defaults to active tasks: queued, running, awaiting_report."
      ),
  })
  .strict();

export const TaskListToolTaskSchema = z
  .object({
    taskId: z.string(),
    status: TaskListStatusSchema,
    parentWorkspaceId: z.string(),
    agentType: z.string().optional(),
    workspaceName: z.string().optional(),
    title: z.string().optional(),
    createdAt: z.string().optional(),
    modelString: z.string().optional(),
    thinkingLevel: TaskListThinkingLevelSchema.optional(),
    depth: z.number().int().min(0),
  })
  .strict();

export const TaskListToolResultSchema = z
  .object({
    tasks: z.array(TaskListToolTaskSchema),
  })
  .strict();

// -----------------------------------------------------------------------------
// agent_report (explicit subagent -> parent report)
// -----------------------------------------------------------------------------

export const AgentReportToolArgsSchema = z
  .object({
    reportMarkdown: z.string().min(1),
    title: z.string().optional(),
  })
  .strict();

export const AgentReportToolResultSchema = z.object({ success: z.literal(true) }).strict();
const FILE_EDIT_FILE_PATH = z
  .string()
  .describe("Path to the file to edit (absolute or relative to the current workspace)");

interface ToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Tool definitions: single source of truth
 * Key = tool name, Value = { description, schema }
 */
export const TOOL_DEFINITIONS = {
  bash: {
    description:
      "Execute a bash command with a configurable timeout. " +
      `Output is strictly limited to ${BASH_HARD_MAX_LINES} lines, ${BASH_MAX_LINE_BYTES} bytes per line, and ${BASH_MAX_TOTAL_BYTES} bytes total. ` +
      "Commands that exceed these limits will FAIL with an error (no partial output returned). " +
      "Be conservative: use 'head', 'tail', 'grep', or other filters to limit output before running commands.",
    schema: z.object({
      script: z.string().describe("The bash script/command to execute"),
      timeout_secs: z
        .number()
        .positive()
        .describe(
          "Timeout in seconds. For foreground: max execution time before kill. " +
            "For background: max lifetime before auto-termination. " +
            "Start small and increase on retry; avoid large initial values to keep UX responsive"
        ),
      run_in_background: z
        .boolean()
        .default(false)
        .describe(
          "Run this command in the background without blocking. " +
            "Use for processes running >5s (dev servers, builds, file watchers). " +
            "Do NOT use for quick commands (<5s), interactive processes (no stdin support), " +
            "or processes requiring real-time output (use foreground with larger timeout instead). " +
            "Returns immediately with process_id. " +
            "Read output with bash_output (returns only new output since last check). " +
            "Terminate with bash_background_terminate using the process_id. " +
            "Process persists until timeout_secs expires, terminated, or workspace is removed." +
            "\\n\\nFor long-running tasks like builds or compilations, prefer background mode to continue productive work in parallel. " +
            "Check back periodically with bash_output rather than blocking on completion."
        ),
      display_name: z
        .string()
        .describe(
          "Human-readable name for the process (e.g., 'Dev Server', 'TypeCheck Watch'). " +
            "Required for all bash invocations since any process can be sent to background."
        ),
    }),
  },
  file_read: {
    description:
      "Read the contents of a file from the file system. Read as little as possible to complete the task.",
    schema: z.object({
      filePath: z.string().describe("The path to the file to read (absolute or relative)"),
      offset: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based starting line number (optional, defaults to 1)"),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Number of lines to return from offset (optional, returns all if not specified)"),
    }),
  },
  file_edit_replace_string: {
    description:
      "⚠️ CRITICAL: Always check tool results - edits WILL fail if old_string is not found or unique. Do not proceed with dependent operations (commits, pushes, builds) until confirming success.\n\n" +
      "Apply one or more edits to a file by replacing exact text matches. All edits are applied sequentially. Each old_string must be unique in the file unless replace_count > 1 or replace_count is -1.",
    schema: z.object({
      file_path: FILE_EDIT_FILE_PATH,
      old_string: z
        .string()
        .describe(
          "The exact text to replace (must be unique in file if replace_count is 1). Include enough context (indentation, surrounding lines) to make it unique."
        ),
      new_string: z.string().describe("The replacement text"),
      replace_count: z
        .number()
        .int()
        .optional()
        .describe(
          "Number of occurrences to replace (default: 1). Use -1 to replace all occurrences. If 1, old_string must be unique in the file."
        ),
    }),
  },
  file_edit_replace_lines: {
    description:
      "⚠️ CRITICAL: Always check tool results - edits WILL fail if line numbers are invalid or file content has changed. Do not proceed with dependent operations (commits, pushes, builds) until confirming success.\n\n" +
      "Replace a range of lines in a file. Use this for line-based edits when you know the exact line numbers to modify.",
    schema: z.object({
      file_path: FILE_EDIT_FILE_PATH,
      start_line: z.number().int().min(1).describe("1-indexed start line (inclusive) to replace"),
      end_line: z.number().int().min(1).describe("1-indexed end line (inclusive) to replace"),
      new_lines: z
        .array(z.string())
        .describe("Replacement lines. Provide an empty array to delete the specified range."),
      expected_lines: z
        .array(z.string())
        .optional()
        .describe(
          "Optional safety check. When provided, the current lines in the specified range must match exactly."
        ),
    }),
  },
  file_edit_insert: {
    description:
      "Insert content into a file using substring guards. " +
      "Provide exactly one of before or after to anchor the operation when editing an existing file. " +
      "When the file does not exist, it is created automatically without guards. " +
      `Optional before/after substrings must uniquely match surrounding content. ${TOOL_EDIT_WARNING}`,
    schema: z
      .object({
        file_path: FILE_EDIT_FILE_PATH,
        content: z.string().describe("The content to insert"),
        before: z
          .string()
          .min(1)
          .optional()
          .describe("Optional substring that must appear immediately before the insertion point"),
        after: z
          .string()
          .min(1)
          .optional()
          .describe("Optional substring that must appear immediately after the insertion point"),
      })
      .refine((data) => !(data.before !== undefined && data.after !== undefined), {
        message: "Provide only one of before or after (not both).",
        path: ["before"],
      }),
  },
  ask_user_question: {
    description:
      "Ask 1–4 multiple-choice questions (with optional multi-select) and wait for the user's answers. " +
      "This tool is intended for plan mode and MUST be used when you need user clarification to complete the plan. " +
      "Do not output a list of open questions; ask them via this tool instead. " +
      "Each question must include 2–4 options; an 'Other' choice is provided automatically.",
    schema: AskUserQuestionToolArgsSchema,
  },
  propose_plan: {
    description:
      "Signal that your plan is complete and ready for user approval. " +
      "This tool reads the plan from the plan file you wrote. " +
      "You must write your plan to the plan file before calling this tool. " +
      "After calling this tool, do not paste the plan contents or mention the plan file path; the UI already shows the full plan.",
    schema: z.object({}),
  },
  task: {
    description:
      "Spawn a sub-agent task in a child workspace. " +
      'Use this to delegate work to specialized presets like "explore" (read-only investigation) or "exec" (general-purpose coding in a child workspace). ' +
      "If run_in_background is false, this tool blocks until the sub-agent calls agent_report, then returns the report. " +
      "If run_in_background is true, you can await it later with task_await.",
    schema: TaskToolArgsSchema,
  },
  task_await: {
    description:
      "Wait for one or more sub-agent tasks to finish and return their reports. " +
      "Use this tool to WAIT; do not poll task_list in a loop to wait for task completion (that is misuse and wastes tool calls). " +
      "This is similar to Promise.allSettled(): you always get per-task results. " +
      "Possible statuses: completed, queued, running, awaiting_report, not_found, invalid_scope, error.",
    schema: TaskAwaitToolArgsSchema,
  },
  task_terminate: {
    description:
      "Terminate one or more sub-agent tasks immediately. " +
      "This stops their AI streams and deletes their workspaces (best-effort). " +
      "No report will be delivered; any in-progress work is discarded. " +
      "If the task has descendant sub-agent tasks, they are terminated too.",
    schema: TaskTerminateToolArgsSchema,
  },
  task_list: {
    description:
      "List descendant sub-agent tasks for the current workspace, including their status and metadata. " +
      "Use this after compaction or interruptions to rediscover which tasks are still active. " +
      "This is a discovery tool, NOT a waiting mechanism: if you need to wait for tasks to finish, call task_await (optionally omit task_ids to await all active descendant tasks).",
    schema: TaskListToolArgsSchema,
  },
  agent_report: {
    description:
      "Report the final result of a sub-agent task back to the parent workspace. " +
      "Call this exactly once when you have a final answer (after any spawned sub-tasks complete).",
    schema: AgentReportToolArgsSchema,
  },
  todo_write: {
    description:
      "Create or update the todo list for tracking multi-step tasks (limit: 7 items). " +
      "The TODO list is displayed to the user at all times. " +
      "Replace the entire list on each call - the AI tracks which tasks are completed.\n" +
      "\n" +
      "Mark ONE task as in_progress at a time. " +
      "Order tasks as: completed first, then in_progress (max 1), then pending last. " +
      "Use appropriate tense in content: past tense for completed (e.g., 'Added tests'), " +
      "present progressive for in_progress (e.g., 'Adding tests'), " +
      "and imperative/infinitive for pending (e.g., 'Add tests').\n" +
      "\n" +
      "If you hit the 7-item limit, summarize older completed items into one line " +
      "(e.g., 'Completed initial setup (3 tasks)').\n" +
      "\n" +
      "Update the list as work progresses. If work fails or the approach changes, update " +
      "the list to reflect reality - only mark tasks complete when they actually succeed.",
    schema: z.object({
      todos: z.array(
        z.object({
          content: z
            .string()
            .describe(
              "Task description with tense matching status: past for completed, present progressive for in_progress, imperative for pending"
            ),
          status: z.enum(["pending", "in_progress", "completed"]).describe("Task status"),
        })
      ),
    }),
  },
  todo_read: {
    description: "Read the current todo list",
    schema: z.object({}),
  },
  status_set: {
    description:
      "Set a status indicator to show what Assistant is currently doing. The status is set IMMEDIATELY \n" +
      "when this tool is called, even before other tool calls complete.\n" +
      "\n" +
      "WHEN TO SET STATUS:\n" +
      "- Set status when beginning concrete work (file edits, running tests, executing commands)\n" +
      "- Update status as work progresses through distinct phases\n" +
      "- Set a final status after completion, only claim success when certain (e.g., after confirming checks passed)\n" +
      "- DO NOT set status during initial exploration, file reading, or planning phases\n" +
      "\n" +
      "The status is cleared when a new user message comes in. Validate your approach is feasible \n" +
      "before setting status - failed tool calls after setting status indicate premature commitment.\n" +
      "\n" +
      "URL PARAMETER:\n" +
      "- Optional 'url' parameter links to external resources (e.g., PR URL: 'https://github.com/owner/repo/pull/123')\n" +
      "- Prefer stable URLs that don't change often - saving the same URL twice is a no-op\n" +
      "- URL persists until replaced by a new status with a different URL",
    schema: z
      .object({
        emoji: z.string().describe("A single emoji character representing the current activity"),
        message: z
          .string()
          .describe(
            `A brief description of the current activity (auto-truncated to ${STATUS_MESSAGE_MAX_LENGTH} chars with ellipsis if needed)`
          ),
        url: z
          .string()
          .url()
          .optional()
          .describe(
            "Optional URL to external resource with more details (e.g., Pull Request URL). The URL persists and is displayed to the user for easy access."
          ),
      })
      .strict(),
  },
  bash_output: {
    description:
      "Retrieve output from a running or completed background bash process. " +
      "Returns only NEW output since the last check (incremental). " +
      "Returns stdout and stderr output along with process status. " +
      "Supports optional regex filtering to show only lines matching a pattern. " +
      "WARNING: When using filter, non-matching lines are permanently discarded. " +
      "Use timeout to wait for output instead of polling repeatedly.",
    schema: z.object({
      process_id: z.string().describe("The ID of the background process to retrieve output from"),
      filter: z
        .string()
        .optional()
        .describe(
          "Optional regex to filter output lines. By default, only matching lines are returned. " +
            "When filter_exclude is true, matching lines are excluded instead. " +
            "Non-matching lines are permanently discarded and cannot be retrieved later."
        ),
      filter_exclude: z
        .boolean()
        .optional()
        .describe(
          "When true, lines matching 'filter' are excluded instead of kept. " +
            "Key behavior: excluded lines do NOT cause early return from timeout - " +
            "waiting continues until non-excluded output arrives or process exits. " +
            "Use to avoid busy polling on progress spam (e.g., filter='⏳|waiting|\\.\\.\\.' with filter_exclude=true " +
            "lets you set a long timeout and only wake on meaningful output). " +
            "Requires 'filter' to be set."
        ),
      timeout_secs: z
        .number()
        .min(0)
        .describe(
          "Seconds to wait for new output. " +
            "If no output is immediately available and process is still running, " +
            "blocks up to this duration. Returns early when output arrives or process exits. " +
            "Only use long timeouts (>15s) when no other useful work can be done in parallel."
        ),
    }),
  },
  bash_background_list: {
    description:
      "List all background processes started with bash(run_in_background=true). " +
      "Returns process_id, status, script for each process. " +
      "Use to find process_id for termination or check output with bash_output.",
    schema: z.object({}),
  },
  bash_background_terminate: {
    description:
      "Terminate a background process started with bash(run_in_background=true). " +
      "Use process_id from the original bash response or from bash_background_list. " +
      "Sends SIGTERM, waits briefly, then SIGKILL if needed. " +
      "Output remains available via bash_output after termination.",
    schema: z.object({
      process_id: z.string().describe("Background process ID to terminate"),
    }),
  },
  web_fetch: {
    description:
      `Fetch a web page and extract its main content as clean markdown. ` +
      `Uses the workspace's network context (requests originate from the workspace, not Mux host). ` +
      `Requires curl to be installed in the workspace. ` +
      `Output is truncated to ${Math.floor(WEB_FETCH_MAX_OUTPUT_BYTES / 1024)}KB.`,
    schema: z.object({
      url: z.string().url().describe("The URL to fetch (http or https)"),
    }),
  },
  code_execution: {
    description:
      "Execute JavaScript code in a sandboxed environment with access to Mux tools. " +
      "Available for multi-tool workflows when PTC experiment is enabled.",
    schema: z.object({
      code: z.string().min(1).describe("JavaScript code to execute in the PTC sandbox"),
    }),
  },
} as const;

// -----------------------------------------------------------------------------
// Result Schemas for Bridgeable Tools (PTC Type Generation)
// -----------------------------------------------------------------------------
// These Zod schemas define the result types for tools exposed in the PTC sandbox.
// They serve as single source of truth for both:
// 1. TypeScript types in tools.ts (via z.infer<>)
// 2. Runtime type generation for PTC (via Zod → JSON Schema → TypeScript string)

/**
 * Truncation info returned when output exceeds limits.
 */
const TruncatedInfoSchema = z.object({
  reason: z.string(),
  totalLines: z.number(),
});

/**
 * Bash tool result - success, background spawn, or failure.
 */
export const BashToolResultSchema = z.union([
  // Foreground success
  z.object({
    success: z.literal(true),
    output: z.string(),
    exitCode: z.literal(0),
    wall_duration_ms: z.number(),
    note: z.string().optional(),
    truncated: TruncatedInfoSchema.optional(),
  }),
  // Background spawn success
  z.object({
    success: z.literal(true),
    output: z.string(),
    exitCode: z.literal(0),
    wall_duration_ms: z.number(),
    backgroundProcessId: z.string(),
  }),
  // Failure
  z.object({
    success: z.literal(false),
    output: z.string().optional(),
    exitCode: z.number(),
    error: z.string(),
    wall_duration_ms: z.number(),
    note: z.string().optional(),
    truncated: TruncatedInfoSchema.optional(),
  }),
]);

/**
 * Bash output tool result - process status and incremental output.
 */
export const BashOutputToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    status: z.enum(["running", "exited", "killed", "failed", "interrupted"]),
    output: z.string(),
    exitCode: z.number().optional(),
    note: z.string().optional(),
    elapsed_ms: z.number(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * Bash background list tool result - all background processes.
 */
export const BashBackgroundListResultSchema = z.union([
  z.object({
    success: z.literal(true),
    processes: z.array(
      z.object({
        process_id: z.string(),
        status: z.enum(["running", "exited", "killed", "failed"]),
        script: z.string(),
        uptime_ms: z.number(),
        exitCode: z.number().optional(),
        display_name: z.string().optional(),
      })
    ),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * Bash background terminate tool result.
 */
export const BashBackgroundTerminateResultSchema = z.union([
  z.object({
    success: z.literal(true),
    message: z.string(),
    display_name: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * File read tool result - content or error.
 */
export const FileReadToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    file_size: z.number(),
    modifiedTime: z.string(),
    lines_read: z.number(),
    content: z.string(),
    warning: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

/**
 * File edit insert tool result - diff or error.
 */
export const FileEditInsertToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    diff: z.string(),
    warning: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    note: z.string().optional(),
  }),
]);

/**
 * File edit replace string tool result - diff with edit count or error.
 */
export const FileEditReplaceStringToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    diff: z.string(),
    edits_applied: z.number(),
    warning: z.string().optional(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    note: z.string().optional(),
  }),
]);

/**
 * Web fetch tool result - parsed content or error.
 */
export const WebFetchToolResultSchema = z.union([
  z.object({
    success: z.literal(true),
    title: z.string(),
    content: z.string(),
    url: z.string(),
    byline: z.string().optional(),
    length: z.number(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
    content: z.string().optional(),
  }),
]);

/**
 * Names of tools that are bridgeable to PTC sandbox.
 * If adding a new tool here, you must also add its result schema below.
 */
export type BridgeableToolName =
  | "bash"
  | "bash_output"
  | "bash_background_list"
  | "bash_background_terminate"
  | "file_read"
  | "file_edit_insert"
  | "file_edit_replace_string"
  | "web_fetch";

/**
 * Lookup map for result schemas by tool name.
 * Used by PTC type generator to get result types for bridgeable tools.
 *
 * Type-level enforcement ensures all BridgeableToolName entries have schemas.
 */
export const RESULT_SCHEMAS: Record<BridgeableToolName, z.ZodType> = {
  bash: BashToolResultSchema,
  bash_output: BashOutputToolResultSchema,
  bash_background_list: BashBackgroundListResultSchema,
  bash_background_terminate: BashBackgroundTerminateResultSchema,
  file_read: FileReadToolResultSchema,
  file_edit_insert: FileEditInsertToolResultSchema,
  file_edit_replace_string: FileEditReplaceStringToolResultSchema,
  web_fetch: WebFetchToolResultSchema,
};

/**
 * Get tool definition schemas for token counting
 * JSON schemas are auto-generated from zod schemas
 *
 * @returns Record of tool name to schema
 */
export function getToolSchemas(): Record<string, ToolSchema> {
  return Object.fromEntries(
    Object.entries(TOOL_DEFINITIONS).map(([name, def]) => [
      name,
      {
        name,
        description: def.description,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
        inputSchema: zodToJsonSchema(def.schema as any) as ToolSchema["inputSchema"],
      },
    ])
  );
}

/**
 * Get which tools are available for a given model
 * @param modelString The model string (e.g., "anthropic:claude-opus-4-1")
 * @param mode Optional mode ("plan" | "exec") - ask_user_question only available in plan mode
 * @returns Array of tool names available for the model
 */
export function getAvailableTools(
  modelString: string,
  mode?: "plan" | "exec",
  options?: { enableAgentReport?: boolean }
): string[] {
  const [provider] = modelString.split(":");
  const enableAgentReport = options?.enableAgentReport ?? true;

  // Base tools available for all models
  const baseTools = [
    "bash",
    "bash_output",
    "bash_background_list",
    "bash_background_terminate",
    "file_read",
    "file_edit_replace_string",
    // "file_edit_replace_lines", // DISABLED: causes models to break repo state
    "file_edit_insert",
    // ask_user_question only available in plan mode
    ...(mode === "plan" ? ["ask_user_question"] : []),
    "propose_plan",
    "task",
    "task_await",
    "task_terminate",
    "task_list",
    ...(enableAgentReport ? ["agent_report"] : []),
    "todo_write",
    "todo_read",
    "status_set",
    "web_fetch",
  ];

  // Add provider-specific tools
  switch (provider) {
    case "anthropic":
      return [...baseTools, "web_search"];
    case "openai":
      // Only some OpenAI models support web search
      if (modelString.includes("gpt-4") || modelString.includes("gpt-5")) {
        return [...baseTools, "web_search"];
      }
      return baseTools;
    case "google":
      return [...baseTools, "google_search"];
    default:
      return baseTools;
  }
}
