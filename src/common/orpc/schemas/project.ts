import { z } from "zod";
import { RuntimeConfigSchema } from "./runtime";
import { WorkspaceMCPOverridesSchema } from "./mcp";
import { WorkspaceAISettingsSchema } from "./workspaceAiSettings";

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
  parentWorkspaceId: z.string().optional().meta({
    description:
      "If set, this workspace is a child (sub-workspace) of the given parent workspace id.",
  }),
  agentType: z.string().optional().meta({
    description: "If set, this workspace is an agent task workspace using the named preset.",
  }),
  taskStatus: z
    .enum(["queued", "running", "awaiting_report", "reported"])
    .optional()
    .meta({ description: "Task lifecycle status for agent task workspaces." }),
  taskParentToolCallId: z.string().optional().meta({
    description:
      "If set, the parent toolCallId that created this task (used for durable tool output).",
  }),
  taskPrompt: z.string().optional().meta({
    description: "If set, the initial prompt for this agent task workspace.",
  }),
  taskModel: z.string().optional().meta({
    description: "If set, the model used to run this task (used to resume tasks after restart).",
  }),
  mcp: WorkspaceMCPOverridesSchema.optional().meta({
    description: "Per-workspace MCP overrides (disabled servers, tool allowlists)",
  }),
});

export const ProjectConfigSchema = z.object({
  workspaces: z.array(WorkspaceConfigSchema),
  idleCompactionHours: z.number().min(1).nullable().optional().meta({
    description:
      "Hours of inactivity before auto-compacting workspaces. null/undefined = disabled.",
  }),
});
