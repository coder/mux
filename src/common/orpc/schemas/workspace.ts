import { z } from "zod";
import { RuntimeConfigSchema } from "./runtime";
import { WorkspaceAISettingsByModeSchema, WorkspaceAISettingsSchema } from "./workspaceAiSettings";

const ThinkingLevelSchema = z.enum(["off", "low", "medium", "high", "xhigh"]);

export const WorkspaceMetadataSchema = z.object({
  id: z.string().meta({
    description:
      "Stable unique identifier (10 hex chars for new workspaces, legacy format for old)",
  }),
  name: z.string().meta({
    description: 'Git branch / directory name (e.g., "plan-a1b2") - used for path computation',
  }),
  title: z.string().optional().meta({
    description:
      'Human-readable workspace title (e.g., "Fix plan mode over SSH") - optional for legacy workspaces',
  }),
  projectName: z
    .string()
    .meta({ description: "Project name extracted from project path (for display)" }),
  projectPath: z
    .string()
    .meta({ description: "Absolute path to the project (needed to compute workspace path)" }),
  createdAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp of when workspace was created (optional for backward compatibility)",
  }),
  aiSettingsByMode: WorkspaceAISettingsByModeSchema.optional().meta({
    description: "Per-mode AI settings (plan/exec) persisted in config",
  }),
  runtimeConfig: RuntimeConfigSchema.meta({
    description: "Runtime configuration for this workspace (always set, defaults to local on load)",
  }),
  aiSettings: WorkspaceAISettingsSchema.optional().meta({
    description: "Workspace-scoped AI settings (model + thinking level) persisted in config",
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
  taskStatus: z.enum(["queued", "running", "awaiting_report", "reported"]).optional().meta({
    description:
      "Agent task lifecycle status for child workspaces (queued|running|awaiting_report|reported).",
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
  taskTrunkBranch: z.string().optional().meta({
    description:
      "Trunk branch used to create/init this agent task workspace (used for restart-safe init on queued tasks).",
  }),
  status: z.enum(["creating"]).optional().meta({
    description:
      "Workspace creation status. 'creating' = pending setup (ephemeral, not persisted). Absent = ready.",
  }),
  archivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last archived. Workspace is considered archived if archivedAt > unarchivedAt (or unarchivedAt is absent).",
  }),
  unarchivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last unarchived. Used for recency calculation to bump restored workspaces to top.",
  }),
});

export const FrontendWorkspaceMetadataSchema = WorkspaceMetadataSchema.extend({
  namedWorkspacePath: z
    .string()
    .meta({ description: "Worktree path (uses workspace name as directory)" }),
  incompatibleRuntime: z.string().optional().meta({
    description:
      "If set, this workspace has an incompatible runtime configuration (e.g., from a newer version of mux). The workspace should be displayed but interactions should show this error message.",
  }),
  postCompaction: z
    .object({
      planPath: z.string().nullable(),
      trackedFilePaths: z.array(z.string()),
      excludedItems: z.array(z.string()),
    })
    .optional()
    .meta({
      description:
        "Post-compaction context state. Only included when requested via includePostCompaction param.",
    }),
});

export const WorkspaceActivitySnapshotSchema = z.object({
  recency: z.number().meta({ description: "Unix ms timestamp of last user interaction" }),
  streaming: z.boolean().meta({ description: "Whether workspace currently has an active stream" }),
  lastModel: z.string().nullable().meta({ description: "Last model sent from this workspace" }),
  lastThinkingLevel: ThinkingLevelSchema.nullable().meta({
    description: "Last thinking/reasoning level used in this workspace",
  }),
});

export const PostCompactionStateSchema = z.object({
  planPath: z.string().nullable(),
  trackedFilePaths: z.array(z.string()),
  excludedItems: z.array(z.string()),
});

export const GitStatusSchema = z.object({
  /** Commit divergence relative to origin's primary branch */
  ahead: z.number(),
  behind: z.number(),
  dirty: z
    .boolean()
    .meta({ description: "Whether there are uncommitted changes (staged or unstaged)" }),

  /**
   * Line deltas for changes unique to this workspace.
   * Computed vs the merge-base with origin's primary branch.
   *
   * Note: outgoing includes committed changes + uncommitted changes (working tree).
   */
  outgoingAdditions: z.number(),
  outgoingDeletions: z.number(),

  /** Line deltas for changes that exist on origin's primary branch but not locally */
  incomingAdditions: z.number(),
  incomingDeletions: z.number(),
});
