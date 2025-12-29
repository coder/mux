import { z } from "zod";

/**
 * UI Mode types
 */

export const UI_MODE_VALUES = ["plan", "exec"] as const;
export const UIModeSchema = z.enum(UI_MODE_VALUES);
export type UIMode = z.infer<typeof UIModeSchema>;

/**
 * Agent mode types
 *
 * Includes non-UI modes like "compact" used for history compaction.
 */

export const AGENT_MODE_VALUES = [...UI_MODE_VALUES, "compact"] as const;
export const AgentModeSchema = z.enum(AGENT_MODE_VALUES);
export type AgentMode = z.infer<typeof AgentModeSchema>;
