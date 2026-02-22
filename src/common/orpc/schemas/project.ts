import { z } from "zod";
import { RuntimeConfigSchema, RuntimeEnablementIdSchema } from "./runtime";
import { WorkspaceMCPOverridesSchema } from "./mcp";
import { WorkspaceAISettingsByAgentSchema, WorkspaceAISettingsSchema } from "./workspaceAiSettings";

const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh", "max"]);

const RuntimeEnablementOverridesSchema = z
  .object(
    Object.fromEntries(
      RuntimeEnablementIdSchema.options.map((runtimeId) => [runtimeId, z.literal(false)])
    ) as Record<string, z.ZodLiteral<false>>
  )
  .partial();

/**
 * Section schema for organizing workspaces within a project.
 * Sections are project-scoped and persist to config.json.
 */
export const SectionConfigSchema = z.object({
  id: z.string().meta({
    description: "Unique section ID (8 hex chars)",
  }),
  name: z.string().meta({
    description: "Display name for the section",
  }),
  color: z.string().optional().meta({
    description: "Accent color (hex value like #ff6b6b or preset name)",
  }),
  nextId: z.string().nullable().optional().meta({
    description: "ID of the next section in display order (null = last, undefined treated as null)",
  }),
});

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
  aiSettingsByAgent: WorkspaceAISettingsByAgentSchema.optional().meta({
    description: "Per-agent workspace-scoped AI settings",
  }),
  runtimeConfig: RuntimeConfigSchema.optional().meta({
    description: "Runtime configuration (local vs SSH) - optional, defaults to local",
  }),
  aiSettings: WorkspaceAISettingsSchema.optional().meta({
    description: "Workspace-scoped AI settings (model + thinking level)",
  }),
  parentWorkspaceId: z.string().optional().meta({
    description:
      "If set, this workspace is a child workspace spawned from the parent workspaceId (enables nesting in UI and backend orchestration).",
  }),
  agentType: z.string().optional().meta({
    description: 'If set, selects an agent preset for this workspace (e.g., "explore" or "exec").',
  }),
  agentId: z.string().optional().meta({
    description:
      'If set, selects an agent definition for this workspace (e.g., "explore" or "exec").',
  }),
  agentSwitchingEnabled: z.boolean().optional().meta({
    description:
      "When true, switch_agent tool is enabled for this workspace (set when session starts from Auto agent).",
  }),
  taskStatus: z
    .enum(["queued", "running", "awaiting_report", "interrupted", "reported"])
    .optional()
    .meta({
      description:
        "Agent task lifecycle status for child workspaces (queued|running|awaiting_report|interrupted|reported).",
    }),
  reportedAt: z.string().optional().meta({
    description: "ISO 8601 timestamp for when an agent task reported completion (optional).",
  }),
  taskModelString: z.string().optional().meta({
    description: "Model string used to run this agent task (used for restart-safe resumptions).",
  }),
  taskThinkingLevel: ThinkingLevelSchema.optional().meta({
    description: "Thinking level used for this agent task (used for restart-safe resumptions).",
  }),
  taskPrompt: z.string().optional().meta({
    description:
      "Initial prompt for a queued agent task (persisted only until the task actually starts).",
  }),
  taskExperiments: z
    .object({
      programmaticToolCalling: z.boolean().optional(),
      programmaticToolCallingExclusive: z.boolean().optional(),
      execSubagentHardRestart: z.boolean().optional(),
    })
    .optional()
    .meta({
      description: "Experiments inherited from parent for restart-safe resumptions.",
    }),
  taskBaseCommitSha: z.string().optional().meta({
    description:
      "Git commit SHA this agent task workspace started from (used for generating git-format-patch artifacts).",
  }),
  taskTrunkBranch: z.string().optional().meta({
    description:
      "Trunk branch used to create/init this agent task workspace (used for restart-safe init on queued tasks).",
  }),
  mcp: WorkspaceMCPOverridesSchema.optional().meta({
    description:
      "LEGACY: Per-workspace MCP overrides (migrated to <workspace>/.mux/mcp.local.jsonc)",
  }),
  archivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last archived. Workspace is considered archived if archivedAt > unarchivedAt (or unarchivedAt is absent).",
  }),
  unarchivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last unarchived. Used for recency calculation to bump restored workspaces to top.",
  }),
  sectionId: z.string().optional().meta({
    description: "ID of the section this workspace belongs to (optional, unsectioned if absent)",
  }),
});

export const ProjectConfigSchema = z.object({
  workspaces: z.array(WorkspaceConfigSchema),
  sections: z.array(SectionConfigSchema).optional().meta({
    description: "Sections for organizing workspaces within this project",
  }),
  idleCompactionHours: z.number().min(1).nullable().optional().meta({
    description:
      "Hours of inactivity before auto-compacting workspaces. null/undefined = disabled.",
  }),
  runtimeEnablement: RuntimeEnablementOverridesSchema.optional().meta({
    description: "Runtime enablement overrides (store `false` only to keep config.json minimal)",
  }),
  runtimeOverridesEnabled: z.boolean().optional().meta({
    description: "Whether this project uses runtime overrides, even if no overrides are set",
  }),
  defaultRuntime: RuntimeEnablementIdSchema.optional().meta({
    description: "Default runtime override for new workspaces in this project",
  }),
});
