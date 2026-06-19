/**
 * Unified tool component registry.
 *
 * Single source of truth for mapping tool names to their UI components.
 * Both ToolMessage.tsx and NestedToolRenderer.tsx use this to avoid duplication.
 */
import type { ComponentType } from "react";
import { z, type ZodSchema } from "zod";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";

import { AnalyticsQueryToolCall } from "../analyticsQuery/AnalyticsQueryToolCall";
import { AttachFileToolCall } from "../AttachFileToolCall";
import { AdvisorToolCall } from "../AdvisorToolCall";
import { GenericToolCall } from "../GenericToolCall";
import { BashToolCall } from "../BashToolCall";
import { DesktopActionToolCall } from "../DesktopActionToolCall";
import { DesktopScreenshotToolCall } from "../DesktopScreenshotToolCall";
import { FileEditToolCall } from "../FileEditToolCall";
import { AgentSkillReadToolCall } from "../AgentSkillReadToolCall";
import { AgentSkillReadFileToolCall } from "../AgentSkillReadFileToolCall";
import { FileReadToolCall } from "../FileReadToolCall";
import { MemoryToolCall } from "../MemoryToolCall";
import { WebFetchToolCall } from "../WebFetchToolCall";
import { WebSearchToolCall } from "../WebSearchToolCall";
import { GoogleSearchToolCall } from "../GoogleSearchToolCall";
import { AskUserQuestionToolCall } from "../AskUserQuestionToolCall";
import { ProposePlanToolCall } from "../ProposePlanToolCall";
import { TodoToolCall } from "../TodoToolCall";
import { StatusSetToolCall } from "../StatusSetToolCall";
import { NotifyToolCall } from "../NotifyToolCall";
import { ReviewPaneUpdateToolCall } from "../ReviewPaneUpdateToolCall";
import { ReviewPaneGetToolCall } from "../ReviewPaneGetToolCall";
import { BashBackgroundListToolCall } from "../BashBackgroundListToolCall";
import { BashBackgroundTerminateToolCall } from "../BashBackgroundTerminateToolCall";
import { BashOutputToolCall } from "../BashOutputToolCall";
import { AgentReportToolCall } from "../AgentReportToolCall";
import { CodeExecutionToolCall } from "../CodeExecutionToolCall";
import {
  TaskToolCall,
  TaskAwaitToolCall,
  TaskListToolCall,
  TaskTerminateToolCall,
} from "../TaskToolCall";
import { TaskApplyGitPatchToolCall } from "../TaskApplyGitPatchToolCall";
import { SetGoalToolCall } from "../SetGoalToolCall";
import { GetGoalToolCall } from "../GetGoalToolCall";
import { WorkflowResumeToolCall, WorkflowRunToolCall } from "../WorkflowRunToolCall";
import { WorkflowListToolCall, WorkflowReadToolCall } from "../WorkflowDefinitionToolCall";
import { WorkflowActionListToolCall } from "../WorkflowActionListToolCall";
import { CompleteGoalToolCall } from "../CompleteGoalToolCall";

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
 * Note: Some tools (ask_user_question, propose_plan, todo_write) require
 * props like workspaceId/toolCallId that aren't available in nested context. This is
 * fine because the backend excludes these from code_execution sandbox (see EXCLUDED_TOOLS
 * in src/node/services/ptc/toolBridge.ts). They can never appear in nested tool calls.
 */
const legacyStatusSetSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().url().optional().nullable(),
});

const legacyAgentReportFileArgsSchema = z
  .object({
    reportMarkdownPath: z.string().min(1).nullish(),
    structuredOutputPath: z.string().min(1).nullish(),
    title: z.string().nullish(),
  })
  .strict();

const agentReportRenderSchema = z.union([
  TOOL_DEFINITIONS.agent_report.schema,
  legacyAgentReportFileArgsSchema,
]);

const TOOL_REGISTRY: Record<string, ToolRegistryEntry> = {
  bash: { component: BashToolCall, schema: TOOL_DEFINITIONS.bash.schema },
  file_read: { component: FileReadToolCall, schema: TOOL_DEFINITIONS.file_read.schema },
  memory: { component: MemoryToolCall, schema: TOOL_DEFINITIONS.memory.schema },
  attach_file: { component: AttachFileToolCall, schema: TOOL_DEFINITIONS.attach_file.schema },
  desktop_screenshot: {
    component: DesktopScreenshotToolCall,
    schema: TOOL_DEFINITIONS.desktop_screenshot.schema,
  },
  desktop_move_mouse: {
    component: DesktopActionToolCall,
    schema: TOOL_DEFINITIONS.desktop_move_mouse.schema,
  },
  desktop_click: {
    component: DesktopActionToolCall,
    schema: TOOL_DEFINITIONS.desktop_click.schema,
  },
  desktop_double_click: {
    component: DesktopActionToolCall,
    schema: TOOL_DEFINITIONS.desktop_double_click.schema,
  },
  desktop_drag: { component: DesktopActionToolCall, schema: TOOL_DEFINITIONS.desktop_drag.schema },
  desktop_scroll: {
    component: DesktopActionToolCall,
    schema: TOOL_DEFINITIONS.desktop_scroll.schema,
  },
  desktop_type: { component: DesktopActionToolCall, schema: TOOL_DEFINITIONS.desktop_type.schema },
  desktop_key_press: {
    component: DesktopActionToolCall,
    schema: TOOL_DEFINITIONS.desktop_key_press.schema,
  },
  agent_skill_read: {
    component: AgentSkillReadToolCall,
    schema: TOOL_DEFINITIONS.agent_skill_read.schema,
  },
  agent_skill_read_file: {
    component: AgentSkillReadFileToolCall,
    schema: TOOL_DEFINITIONS.agent_skill_read_file.schema,
  },
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
  // Legacy-only transcript renderer for historical status_set calls.
  status_set: { component: StatusSetToolCall, schema: legacyStatusSetSchema },
  notify: { component: NotifyToolCall, schema: TOOL_DEFINITIONS.notify.schema },
  analytics_query: {
    component: AnalyticsQueryToolCall,
    schema: TOOL_DEFINITIONS.analytics_query.schema,
  },
  advisor: { component: AdvisorToolCall, schema: TOOL_DEFINITIONS.advisor.schema },
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
  task_apply_git_patch: {
    component: TaskApplyGitPatchToolCall,
    schema: TOOL_DEFINITIONS.task_apply_git_patch.schema,
  },
  workflow_list: {
    component: WorkflowListToolCall,
    schema: TOOL_DEFINITIONS.workflow_list.schema,
  },
  workflow_read: {
    component: WorkflowReadToolCall,
    schema: TOOL_DEFINITIONS.workflow_read.schema,
  },
  workflow_run: {
    component: WorkflowRunToolCall,
    schema: TOOL_DEFINITIONS.workflow_run.schema,
  },
  workflow_resume: {
    component: WorkflowResumeToolCall,
    schema: TOOL_DEFINITIONS.workflow_resume.schema,
  },
  workflow_action_list: {
    component: WorkflowActionListToolCall,
    schema: TOOL_DEFINITIONS.workflow_action_list.schema,
  },
  agent_report: {
    component: AgentReportToolCall,
    schema: agentReportRenderSchema,
  },
  set_goal: { component: SetGoalToolCall, schema: TOOL_DEFINITIONS.set_goal.schema },
  get_goal: { component: GetGoalToolCall, schema: TOOL_DEFINITIONS.get_goal.schema },
  complete_goal: {
    component: CompleteGoalToolCall,
    schema: TOOL_DEFINITIONS.complete_goal.schema,
  },
  review_pane_update: {
    component: ReviewPaneUpdateToolCall,
    schema: TOOL_DEFINITIONS.review_pane_update.schema,
  },
  review_pane_get: {
    component: ReviewPaneGetToolCall,
    schema: TOOL_DEFINITIONS.review_pane_get.schema,
  },
  // Provider-defined tool (Anthropic/OpenAI) - no TOOL_DEFINITIONS entry
  // Anthropic: args.query, OpenAI: args={}, query in result.action.query
  web_search: { component: WebSearchToolCall, schema: z.object({ query: z.string().optional() }) },
  // Google native search grounding (Gemini 3+), provider-executed — name comes from the wire.
  // queries stays optional so streaming/pending args don't bounce to GenericToolCall.
  "server:GOOGLE_SEARCH_WEB": {
    component: GoogleSearchToolCall,
    schema: z.object({ queries: z.array(z.string()).optional() }),
  },
};

/**
 * Returns the appropriate tool component for a given tool name and args.
 * Validates args against Zod schemas; returns GenericToolCall if validation fails or tool unknown.
 */
export function getToolComponent(toolName: string, args: unknown): AnyToolComponent {
  // Object.hasOwn: toolName flows verbatim from persisted transcripts (attacker-controlled).
  // A bare index lookup returns truthy inherited members for names like "constructor",
  // which would then throw on .schema and brick the workspace view instead of degrading
  // to the generic renderer (self-healing invariant).
  const entry = Object.hasOwn(TOOL_REGISTRY, toolName) ? TOOL_REGISTRY[toolName] : undefined;
  if (!entry?.schema.safeParse(args).success) {
    return GenericToolCall;
  }
  return entry.component;
}
