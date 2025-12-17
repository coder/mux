import { z } from "zod";

/**
 * Agent task preset types (built-in subagent presets).
 * - research: web search + web fetch, read-only (no file edits)
 * - explore: repo exploration with file_read + bash (for rg/git), no edits
 */
export const AgentTypeSchema = z.enum(["research", "explore"]).meta({
  description: "Built-in agent preset type that determines tool policy and system prompt",
});

/**
 * Task status for agent task workspaces.
 * - queued: waiting for a slot (maxParallelAgentTasks reached)
 * - running: actively streaming/executing
 * - awaiting_report: stream ended but agent_report not yet called
 * - reported: agent_report was called, ready for cleanup
 * - failed: task failed (timeout, error, etc.)
 */
export const TaskStatusSchema = z
  .enum(["queued", "running", "awaiting_report", "reported", "failed"])
  .meta({
    description: "Current status of an agent task workspace",
  });

/**
 * Task settings stored in global config (configurable limits).
 */
export const TaskSettingsSchema = z.object({
  maxParallelAgentTasks: z.number().int().min(1).max(10).default(3).meta({
    description: "Maximum number of agent tasks running in parallel across all workspaces",
  }),
  maxTaskNestingDepth: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .meta({ description: "Maximum depth of nested agent tasks (parent → child → grandchild...)" }),
});

/**
 * Task state persisted per agent-task workspace.
 * Enables restart-safe orchestration.
 */
export const TaskStateSchema = z.object({
  taskStatus: TaskStatusSchema,
  agentType: AgentTypeSchema,
  parentWorkspaceId: z.string().meta({
    description: "Workspace ID of the parent that spawned this task",
  }),
  prompt: z.string().meta({
    description: "Original prompt sent to this agent task",
  }),
  description: z.string().optional().meta({
    description: "Optional human-readable description of what this task does",
  }),
  /** Tool call ID in parent's message that spawned this task (for result injection) */
  parentToolCallId: z.string().optional().meta({
    description: "Tool call ID in parent message (used to inject result on completion)",
  }),
  /** When the task was queued */
  queuedAt: z.string().optional().meta({
    description: "ISO 8601 timestamp when task was queued",
  }),
  /** When the task started running */
  startedAt: z.string().optional().meta({
    description: "ISO 8601 timestamp when task started running",
  }),
  /** When agent_report was called */
  reportedAt: z.string().optional().meta({
    description: "ISO 8601 timestamp when agent_report was called",
  }),
  /** Report content (persisted for restart safety) */
  reportMarkdown: z.string().optional().meta({
    description: "Markdown content from agent_report (persisted for delivery after restart)",
  }),
  reportTitle: z.string().optional().meta({
    description: "Optional title from agent_report",
  }),
});

/**
 * Result returned from Task.create operation.
 */
export const TaskCreateResultSchema = z.object({
  taskId: z.string().meta({ description: "Workspace ID of the created agent task" }),
  kind: z.literal("agent").meta({ description: "Task kind (agent for now, bash later)" }),
  status: TaskStatusSchema,
});

/**
 * Input for the `task` tool (spawns a subagent).
 */
export const TaskToolInputSchema = z.object({
  subagent_type: AgentTypeSchema.meta({
    description: "Type of subagent to spawn (determines tools and system prompt)",
  }),
  prompt: z.string().min(1).meta({
    description: "The task/question to send to the subagent",
  }),
  description: z.string().optional().meta({
    description: "Optional short description of the task (shown in UI)",
  }),
  run_in_background: z.boolean().optional().default(false).meta({
    description:
      "If true, return immediately with taskId; otherwise block until agent_report is called",
  }),
});

/**
 * Result returned from the `task` tool.
 */
export const TaskToolResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("queued"),
    taskId: z.string(),
  }),
  z.object({
    status: z.literal("running"),
    taskId: z.string(),
  }),
  z.object({
    status: z.literal("completed"),
    taskId: z.string(),
    reportMarkdown: z.string(),
    reportTitle: z.string().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    taskId: z.string().optional(),
    error: z.string(),
  }),
]);

/**
 * Input for the `agent_report` tool (subagent reports back to parent).
 */
export const AgentReportToolInputSchema = z.object({
  reportMarkdown: z.string().min(1).meta({
    description: "The final report/answer in markdown format",
  }),
  title: z.string().optional().meta({
    description: "Optional short title for the report",
  }),
});

/**
 * Result returned from the `agent_report` tool.
 */
export const AgentReportToolResultSchema = z.object({
  success: z.literal(true),
});
