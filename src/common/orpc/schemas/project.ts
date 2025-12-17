import { z } from "zod";
import { RuntimeConfigSchema } from "./runtime";
import { WorkspaceMCPOverridesSchema } from "./mcp";
import { WorkspaceAISettingsSchema } from "./workspaceAiSettings";
import { TaskStateSchema, AgentTypeSchema } from "./task";

export const WorkspaceConfigSchema = z.object({
  path: z.string().meta({
    description: "Absolute path to workspace directory - REQUIRED for backward compatibility",
  }),
  id: z.string().optional().meta({
    description: "Stable workspace ID (10 hex chars for new workspaces) - optional for legacy",
  }),
  name: z.string().optional().meta({
    description: 'Git branch / directory name (e.g., "plan-a1b2") - optional for legacy',
  }),
  title: z.string().optional().meta({
    description:
      'Human-readable workspace title (e.g., "Fix plan mode over SSH") - optional for legacy',
  }),
  createdAt: z
    .string()
    .optional()
    .meta({ description: "ISO 8601 creation timestamp - optional for legacy" }),
  runtimeConfig: RuntimeConfigSchema.optional().meta({
    description: "Runtime configuration (local vs SSH) - optional, defaults to local",
  }),
  aiSettings: WorkspaceAISettingsSchema.optional().meta({
    description: "Workspace-scoped AI settings (model + thinking level)",
  }),
  mcp: WorkspaceMCPOverridesSchema.optional().meta({
    description: "Per-workspace MCP overrides (disabled servers, tool allowlists)",
  }),
  // Agent task workspace fields (optional - only set for subagent workspaces)
  parentWorkspaceId: z.string().optional().meta({
    description:
      "If this is an agent task workspace, the ID of the parent workspace that spawned it",
  }),
  agentType: AgentTypeSchema.optional().meta({
    description: "Agent preset type (research, explore) - only set for agent task workspaces",
  }),
  taskState: TaskStateSchema.optional().meta({
    description: "Full task state for agent task workspaces (persisted for restart safety)",
  }),
});

export const ProjectConfigSchema = z.object({
  workspaces: z.array(WorkspaceConfigSchema),
  idleCompactionHours: z.number().min(1).nullable().optional().meta({
    description:
      "Hours of inactivity before auto-compacting workspaces. null/undefined = disabled.",
  }),
});
