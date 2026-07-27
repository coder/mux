import type { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

type ToolName = keyof typeof TOOL_DEFINITIONS;

const NOTABLE_TOOLS = new Set<string>([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
  "task",
  "task_terminate",
  "task_apply_git_patch",
  "workflow_run",
  "workflow_resume",
  "propose_plan",
  "set_goal",
  "complete_goal",
  "agent_skill_write",
  "agent_skill_delete",
  "notify",
  "ask_user_question",
] satisfies ToolName[]);

const MUTATING_BASH_COMMAND = /^\s*(?:git|gh|make|bun|npm|pnpm|yarn|docker|cargo|go)(?:\s|$)/;
const MUTATING_MEMORY_COMMANDS = new Set(["create", "str_replace", "insert", "delete", "rename"]);

export function readTimelineStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" ? fieldValue : undefined;
}

export function isFailedToolCallResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const record = result as Record<string, unknown>;
  return record.success === false || Boolean(record.error);
}

export function isNotableToolCall(toolName: string, args: unknown, result: unknown): boolean {
  if (isFailedToolCallResult(result)) {
    return true;
  }

  if (toolName === "bash") {
    const script = readTimelineStringField(args, "script");
    return script != null && MUTATING_BASH_COMMAND.test(script);
  }

  if (toolName === "memory") {
    const command = readTimelineStringField(args, "command");
    return command != null && MUTATING_MEMORY_COMMANDS.has(command);
  }

  return NOTABLE_TOOLS.has(toolName);
}
