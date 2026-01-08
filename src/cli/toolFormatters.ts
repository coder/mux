/**
 * CLI tool output formatters for `mux run`
 *
 * Provides clean, readable formatting for recognized tool calls,
 * with emoji prefixes and structured output similar to the frontend UI.
 */

import chalk from "chalk";
import type { ToolCallStartEvent, ToolCallEndEvent } from "@/common/types/stream";
import type {
  BashToolArgs,
  BashToolResult,
  FileReadToolArgs,
  FileReadToolResult,
  FileEditReplaceStringToolArgs,
  FileEditReplaceStringToolResult,
  FileEditInsertToolArgs,
  FileEditInsertToolResult,
  TaskToolArgs,
  TaskToolResult,
  WebFetchToolArgs,
  WebFetchToolResult,
} from "@/common/types/tools";

/** Tool formatters return formatted string or null to fall back to generic */
type ToolStartFormatter = (toolName: string, args: unknown) => string | null;
type ToolEndFormatter = (toolName: string, args: unknown, result: unknown) => string | null;

/** Tools that should have their result on a new line (multi-line results) */
const MULTILINE_RESULT_TOOLS = new Set([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
  "bash",
  "task",
  "task_await",
  "code_execution",
]);

// ============================================================================
// Utilities
// ============================================================================

function formatFilePath(filePath: string): string {
  return chalk.cyan(filePath);
}

function formatCommand(cmd: string): string {
  // Truncate long commands
  const maxLen = 80;
  const truncated = cmd.length > maxLen ? cmd.slice(0, maxLen) + "…" : cmd;
  return chalk.yellow(truncated);
}

function formatDiff(diff: string): string {
  // Color diff lines for terminal output
  return diff
    .split("\n")
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        return chalk.green(line);
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        return chalk.red(line);
      } else if (line.startsWith("@@")) {
        return chalk.cyan(line);
      }
      return line;
    })
    .join("\n");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function indent(text: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

function renderUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ============================================================================
// Tool Start Formatters
// ============================================================================

function formatFileEditStart(toolName: string, args: unknown): string | null {
  const editArgs = args as FileEditReplaceStringToolArgs | FileEditInsertToolArgs;
  if (!editArgs?.file_path) return null;

  return `✏️  ${formatFilePath(editArgs.file_path)}`;
}

function formatFileReadStart(_toolName: string, args: unknown): string | null {
  const readArgs = args as FileReadToolArgs;
  if (!readArgs?.filePath) return null;

  let suffix = "";
  if (readArgs.offset !== undefined || readArgs.limit !== undefined) {
    const parts: string[] = [];
    if (readArgs.offset !== undefined) parts.push(`L${readArgs.offset}`);
    if (readArgs.limit !== undefined) parts.push(`+${readArgs.limit}`);
    suffix = chalk.dim(` (${parts.join(", ")})`);
  }

  return `📖 ${formatFilePath(readArgs.filePath)}${suffix}`;
}

function formatBashStart(_toolName: string, args: unknown): string | null {
  const bashArgs = args as BashToolArgs;
  if (!bashArgs?.script) return null;

  const bg = bashArgs.run_in_background ? chalk.dim(" [background]") : "";
  const timeout = bashArgs.timeout_secs ? chalk.dim(` timeout:${bashArgs.timeout_secs}s`) : "";

  return `🔧 ${formatCommand(bashArgs.script)}${bg}${timeout}`;
}

function formatTaskStart(_toolName: string, args: unknown): string | null {
  const taskArgs = args as TaskToolArgs;
  if (!taskArgs?.title) return null;

  const bg = taskArgs.run_in_background ? chalk.dim(" [background]") : "";
  return `🤖 ${chalk.magenta(taskArgs.title)}${bg}`;
}

function formatWebFetchStart(_toolName: string, args: unknown): string | null {
  const fetchArgs = args as WebFetchToolArgs;
  if (!fetchArgs?.url) return null;

  return `🌐 ${chalk.blue(fetchArgs.url)}`;
}

function formatWebSearchStart(_toolName: string, args: unknown): string | null {
  const searchArgs = args as { query?: string };
  if (!searchArgs?.query) return null;

  return `🔍 ${chalk.blue(searchArgs.query)}`;
}

function formatTodoStart(_toolName: string, args: unknown): string | null {
  const todoArgs = args as { todos?: Array<{ content: string; status: string }> };
  if (!todoArgs?.todos) return null;

  return `📋 ${chalk.dim(`${todoArgs.todos.length} items`)}`;
}

function formatNotifyStart(_toolName: string, args: unknown): string | null {
  const notifyArgs = args as { title?: string };
  if (!notifyArgs?.title) return null;

  return `🔔 ${chalk.yellow(notifyArgs.title)}`;
}

function formatStatusSetStart(_toolName: string, args: unknown): string | null {
  const statusArgs = args as { emoji?: string; message?: string };
  if (!statusArgs?.message) return null;

  const emoji = statusArgs.emoji ?? "📌";
  return `${emoji} ${chalk.dim(statusArgs.message)}`;
}

function formatAgentSkillReadStart(_toolName: string, args: unknown): string | null {
  const skillArgs = args as { name?: string };
  if (!skillArgs?.name) return null;

  return `📚 ${chalk.cyan(skillArgs.name)}`;
}

function formatCodeExecutionStart(_toolName: string, args: unknown): string | null {
  const codeArgs = args as { code?: string };
  if (!codeArgs?.code) return null;

  // Show first line or truncated preview of code
  const firstLine = codeArgs.code.split("\n")[0];
  const maxLen = 60;
  const preview = firstLine.length > maxLen ? firstLine.slice(0, maxLen) + "…" : firstLine;

  return `🧮 ${chalk.yellow(preview)}`;
}

// ============================================================================
// Tool End Formatters
// ============================================================================

function formatFileEditEnd(toolName: string, _args: unknown, result: unknown): string | null {
  const editResult = result as FileEditReplaceStringToolResult | FileEditInsertToolResult;

  if (editResult?.success === false) {
    return `${chalk.red("✗")} ${chalk.red(editResult.error || "Edit failed")}`;
  }

  if (editResult?.success && editResult.diff) {
    return formatDiff(editResult.diff);
  }

  return chalk.green("✓");
}

function formatFileReadEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  const readResult = result as FileReadToolResult;

  if (readResult?.success === false) {
    return `${chalk.red("✗")} ${chalk.red(readResult.error || "Read failed")}`;
  }

  if (readResult?.success) {
    const size = readResult.file_size ? chalk.dim(` (${formatBytes(readResult.file_size)})`) : "";
    const lines = readResult.lines_read ? chalk.dim(` ${readResult.lines_read} lines`) : "";
    return `${chalk.green("✓")}${lines}${size}`;
  }

  return null;
}

function formatBashEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  const bashResult = result as BashToolResult;

  // Background process started
  if ("backgroundProcessId" in bashResult) {
    return `${chalk.blue("→")} background: ${chalk.dim(bashResult.backgroundProcessId)}`;
  }

  const duration = bashResult.wall_duration_ms
    ? chalk.dim(` (${formatDuration(bashResult.wall_duration_ms)})`)
    : "";
  const exitCode = bashResult.exitCode;
  const exitStr = exitCode === 0 ? chalk.green("exit:0") : chalk.red(`exit:${exitCode}`);

  let output = `${exitStr}${duration}`;

  // Show truncated output if present
  if (bashResult.output) {
    const lines = bashResult.output.split("\n");
    const maxLines = 20;
    const truncated = lines.length > maxLines;
    const displayLines = truncated ? lines.slice(0, maxLines) : lines;
    const outputText = displayLines.join("\n");

    if (outputText.trim()) {
      output += "\n" + indent(chalk.dim(outputText));
      if (truncated) {
        output += "\n" + indent(chalk.dim(`... ${lines.length - maxLines} more lines`));
      }
    }
  }

  // Show error if present (only on failure)
  if (!bashResult.success && bashResult.error) {
    output += "\n" + indent(chalk.red(bashResult.error));
  }

  return output;
}

function formatTaskEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  const taskResult = result as TaskToolResult;

  if ("taskId" in taskResult && taskResult.status) {
    return `${chalk.blue("→")} ${taskResult.status}: ${chalk.dim(taskResult.taskId)}`;
  }

  if ("reportMarkdown" in taskResult) {
    // Truncate long reports
    const report = taskResult.reportMarkdown;
    const maxLen = 500;
    const truncated = report.length > maxLen ? report.slice(0, maxLen) + "…" : report;
    return `${chalk.green("✓")}\n${indent(chalk.dim(truncated))}`;
  }

  return null;
}

function formatWebFetchEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  const fetchResult = result as WebFetchToolResult;

  if (fetchResult?.success === false) {
    return `${chalk.red("✗")} ${chalk.red(fetchResult.error ?? "Fetch failed")}`;
  }

  if (fetchResult?.success) {
    const title = fetchResult.title ? chalk.dim(` "${fetchResult.title}"`) : "";
    const len = fetchResult.length ? chalk.dim(` ${formatBytes(fetchResult.length)}`) : "";
    return `${chalk.green("✓")}${title}${len}`;
  }

  return null;
}

function formatCodeExecutionEnd(_toolName: string, _args: unknown, result: unknown): string | null {
  if (result === undefined || result === null) return null;

  // Code execution results can be complex - show truncated summary
  const resultStr = typeof result === "string" ? result : renderUnknown(result);
  const lines = resultStr.split("\n");
  const maxLines = 10;
  const truncated = lines.length > maxLines;
  const displayLines = truncated ? lines.slice(0, maxLines) : lines;

  let output = chalk.green("✓");
  if (displayLines.join("").trim()) {
    output += "\n" + indent(chalk.dim(displayLines.join("\n")));
    if (truncated) {
      output += "\n" + indent(chalk.dim(`... ${lines.length - maxLines} more lines`));
    }
  }
  return output;
}

// ============================================================================
// Registry and Public API
// ============================================================================

const startFormatters: Record<string, ToolStartFormatter> = {
  file_edit_replace_string: formatFileEditStart,
  file_edit_replace_lines: formatFileEditStart,
  file_edit_insert: formatFileEditStart,
  file_read: formatFileReadStart,
  bash: formatBashStart,
  task: formatTaskStart,
  web_fetch: formatWebFetchStart,
  web_search: formatWebSearchStart,
  todo_write: formatTodoStart,
  notify: formatNotifyStart,
  status_set: formatStatusSetStart,
  agent_skill_read: formatAgentSkillReadStart,
  agent_skill_read_file: formatAgentSkillReadStart,
  code_execution: formatCodeExecutionStart,
};

const endFormatters: Record<string, ToolEndFormatter> = {
  file_edit_replace_string: formatFileEditEnd,
  file_edit_replace_lines: formatFileEditEnd,
  file_edit_insert: formatFileEditEnd,
  file_read: formatFileReadEnd,
  bash: formatBashEnd,
  task: formatTaskEnd,
  task_await: formatTaskEnd,
  web_fetch: formatWebFetchEnd,
  code_execution: formatCodeExecutionEnd,
};

/**
 * Format a tool-call-start event for CLI output.
 * Returns formatted string, or null to use generic fallback.
 */
export function formatToolStart(payload: ToolCallStartEvent): string | null {
  const formatter = startFormatters[payload.toolName];
  if (!formatter) return null;

  try {
    return formatter(payload.toolName, payload.args);
  } catch {
    return null;
  }
}

/**
 * Format a tool-call-end event for CLI output.
 * Returns formatted string, or null to use generic fallback.
 */
export function formatToolEnd(payload: ToolCallEndEvent, startArgs?: unknown): string | null {
  const formatter = endFormatters[payload.toolName];
  if (!formatter) return null;

  try {
    return formatter(payload.toolName, startArgs, payload.result);
  } catch {
    return null;
  }
}

/**
 * Generic fallback formatter for unrecognized tools.
 */
export function formatGenericToolStart(payload: ToolCallStartEvent): string {
  return [
    chalk.dim("─".repeat(40)),
    `${chalk.bold(payload.toolName)} ${chalk.dim(`(${payload.toolCallId})`)}`,
    chalk.dim("Args:"),
    indent(renderUnknown(payload.args)),
    chalk.dim("─".repeat(40)),
  ].join("\n");
}

/**
 * Generic fallback formatter for unrecognized tool results.
 */
export function formatGenericToolEnd(payload: ToolCallEndEvent): string {
  return [
    chalk.dim("─".repeat(40)),
    `${chalk.bold(payload.toolName)} ${chalk.dim("result")}`,
    indent(renderUnknown(payload.result)),
    chalk.dim("─".repeat(40)),
  ].join("\n");
}

/**
 * Check if a tool should have its result on a new line (multi-line output).
 * For single-line results (file_read, web_fetch, etc.), result appears inline.
 */
export function isMultilineResultTool(toolName: string): boolean {
  return MULTILINE_RESULT_TOOLS.has(toolName);
}
