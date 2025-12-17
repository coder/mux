/**
 * Task types for subagent workspaces.
 * Derived from Zod schemas for type safety.
 */

import type { z } from "zod";
import type {
  AgentReportToolInputSchema,
  AgentReportToolResultSchema,
  AgentTypeSchema,
  TaskCreateResultSchema,
  TaskSettingsSchema,
  TaskStateSchema,
  TaskStatusSchema,
  TaskToolInputSchema,
  TaskToolResultSchema,
} from "../orpc/schemas";

/** Agent preset type (research, explore, etc.) */
export type AgentType = z.infer<typeof AgentTypeSchema>;

/** Task status for agent task workspaces */
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** Task settings stored in global config */
export type TaskSettings = z.infer<typeof TaskSettingsSchema>;

/** Full task state persisted per agent-task workspace */
export type TaskState = z.infer<typeof TaskStateSchema>;

/** Result from Task.create operation */
export type TaskCreateResult = z.infer<typeof TaskCreateResultSchema>;

/** Input for the `task` tool */
export type TaskToolInput = z.infer<typeof TaskToolInputSchema>;

/** Result from the `task` tool */
export type TaskToolResult = z.infer<typeof TaskToolResultSchema>;

/** Input for the `agent_report` tool */
export type AgentReportToolInput = z.infer<typeof AgentReportToolInputSchema>;

/** Result from the `agent_report` tool */
export type AgentReportToolResult = z.infer<typeof AgentReportToolResultSchema>;
