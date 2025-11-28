/**
 * Tool definitions module - Frontend-safe
 *
 * Single source of truth for all tool definitions.
 * Zod schemas are defined here and JSON schemas are auto-generated.
 */

import { z } from "zod";
import {
  BASH_DEFAULT_TIMEOUT_SECS,
  BASH_HARD_MAX_LINES,
  BASH_MAX_LINE_BYTES,
  BASH_MAX_TOTAL_BYTES,
  STATUS_MESSAGE_MAX_LENGTH,
  WEB_FETCH_MAX_OUTPUT_BYTES,
} from "@/common/constants/toolLimits";
import { TOOL_EDIT_WARNING } from "@/common/types/tools";

import { zodToJsonSchema } from "zod-to-json-schema";

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
        .optional()
        .describe(
          `Timeout (seconds, default: ${BASH_DEFAULT_TIMEOUT_SECS}). Start small and increase on retry; avoid large initial values to keep UX responsive`
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
  propose_plan: {
    description:
      "Propose a plan before taking action. The plan should be complete but minimal - cover what needs to be decided or understood, nothing more. Use this tool to get approval before proceeding with implementation.",
    schema: z.object({
      title: z
        .string()
        .describe("A short, descriptive title for the plan (e.g., 'Add User Authentication')"),
      plan: z
        .string()
        .describe(
          "Implementation plan in markdown (start at h2 level). " +
            "Scale the detail to match the task complexity: for straightforward changes, briefly state what and why; " +
            "for complex changes, explain approach, key decisions, risks/tradeoffs; " +
            "for uncertain changes, clarify options and what needs user input. " +
            "When presenting options, always provide your recommendation for the overall best option for the user. " +
            "For highly complex concepts, use mermaid diagrams where they'd clarify better than text. " +
            "Cover what's necessary to understand and approve the approach. Omit obvious details or ceremony."
        ),
    }),
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
} as const;

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
        inputSchema: zodToJsonSchema(def.schema) as ToolSchema["inputSchema"],
      },
    ])
  );
}

/**
 * Get which tools are available for a given model
 * @param modelString The model string (e.g., "anthropic:claude-opus-4-1")
 * @returns Array of tool names available for the model
 */
export function getAvailableTools(modelString: string): string[] {
  const [provider] = modelString.split(":");

  // Base tools available for all models
  const baseTools = [
    "bash",
    "file_read",
    "file_edit_replace_string",
    // "file_edit_replace_lines", // DISABLED: causes models to break repo state
    "file_edit_insert",
    "propose_plan",
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
