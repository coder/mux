/**
 * Unified tool component registry.
 *
 * Single source of truth for mapping tool names to their UI components.
 * Both ToolMessage.tsx and NestedToolRenderer.tsx use this to avoid duplication.
 */
import type { ComponentType } from "react";
import type { ZodSchema } from "zod";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { GenericToolCall } from "../GenericToolCall";
import { BashToolCall } from "../BashToolCall";
import { FileEditToolCall } from "../FileEditToolCall";
import { FileReadToolCall } from "../FileReadToolCall";
import { WebFetchToolCall } from "../WebFetchToolCall";
import { AskUserQuestionToolCall } from "../AskUserQuestionToolCall";
import { ProposePlanToolCall } from "../ProposePlanToolCall";
import { TodoToolCall } from "../TodoToolCall";
import { StatusSetToolCall } from "../StatusSetToolCall";
import { BashBackgroundListToolCall } from "../BashBackgroundListToolCall";
import { BashBackgroundTerminateToolCall } from "../BashBackgroundTerminateToolCall";
import { BashOutputToolCall } from "../BashOutputToolCall";
import { CodeExecutionToolCall } from "../CodeExecutionToolCall";
import {
  TaskToolCall,
  TaskAwaitToolCall,
  TaskListToolCall,
  TaskTerminateToolCall,
} from "../TaskToolCall";

/**
 * Component type that accepts any props. We use this because:
 * 1. The registry validates args before returning the component
 * 2. Callers pass all possible extras; components pick what they need
 * 3. Type safety is enforced at the component level, not the registry level
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolComponent = ComponentType<any>;

interface ToolRegistryEntry {
  component: AnyToolComponent;
  schema: ZodSchema;
}

/**
 * Registry mapping tool names to their components and validation schemas.
 * Adding a new tool: add one line here.
 *
 * Note: Some tools (ask_user_question, propose_plan, todo_write, status_set) require
 * props like workspaceId/toolCallId that aren't available in nested context. This is
 * fine because the backend excludes these from code_execution sandbox (see EXCLUDED_TOOLS
 * in src/node/services/ptc/toolBridge.ts). They can never appear in nested tool calls.
 */
const TOOL_REGISTRY: Record<string, ToolRegistryEntry> = {
  bash: { component: BashToolCall, schema: TOOL_DEFINITIONS.bash.schema },
  file_read: { component: FileReadToolCall, schema: TOOL_DEFINITIONS.file_read.schema },
  file_edit_replace_string: {
    component: FileEditToolCall,
    schema: TOOL_DEFINITIONS.file_edit_replace_string.schema,
  },
  file_edit_replace_lines: {
    component: FileEditToolCall,
    schema: TOOL_DEFINITIONS.file_edit_replace_lines.schema,
  },
  file_edit_insert: {
    component: FileEditToolCall,
    schema: TOOL_DEFINITIONS.file_edit_insert.schema,
  },
  ask_user_question: {
    component: AskUserQuestionToolCall,
    schema: TOOL_DEFINITIONS.ask_user_question.schema,
  },
  propose_plan: {
    component: ProposePlanToolCall,
    schema: TOOL_DEFINITIONS.propose_plan.schema,
  },
  todo_write: { component: TodoToolCall, schema: TOOL_DEFINITIONS.todo_write.schema },
  status_set: { component: StatusSetToolCall, schema: TOOL_DEFINITIONS.status_set.schema },
  web_fetch: { component: WebFetchToolCall, schema: TOOL_DEFINITIONS.web_fetch.schema },
  bash_background_list: {
    component: BashBackgroundListToolCall,
    schema: TOOL_DEFINITIONS.bash_background_list.schema,
  },
  bash_background_terminate: {
    component: BashBackgroundTerminateToolCall,
    schema: TOOL_DEFINITIONS.bash_background_terminate.schema,
  },
  bash_output: { component: BashOutputToolCall, schema: TOOL_DEFINITIONS.bash_output.schema },
  code_execution: {
    component: CodeExecutionToolCall,
    schema: TOOL_DEFINITIONS.code_execution.schema,
  },
  task: { component: TaskToolCall, schema: TOOL_DEFINITIONS.task.schema },
  task_await: { component: TaskAwaitToolCall, schema: TOOL_DEFINITIONS.task_await.schema },
  task_list: { component: TaskListToolCall, schema: TOOL_DEFINITIONS.task_list.schema },
  task_terminate: {
    component: TaskTerminateToolCall,
    schema: TOOL_DEFINITIONS.task_terminate.schema,
  },
};

/**
 * Returns the appropriate tool component for a given tool name and args.
 * Validates args against Zod schemas; returns GenericToolCall if validation fails or tool unknown.
 */
export function getToolComponent(toolName: string, args: unknown): AnyToolComponent {
  const entry = TOOL_REGISTRY[toolName];
  if (!entry?.schema.safeParse(args).success) {
    return GenericToolCall;
  }
  return entry.component;
}
