import { z } from "zod";
import { ThinkingLevelSchema } from "../../types/thinking";
import { RuntimeConfigSchema } from "./runtime";
import { WorkspaceAISettingsByAgentSchema, WorkspaceAISettingsSchema } from "./workspaceAiSettings";

export const ProjectRefSchema = z.object({
  projectPath: z.string().meta({ description: "Absolute path to the project's main git repo" }),
  projectName: z
    .string()
    .meta({ description: "Display name for the project (typically derived from projectPath)" }),
});

export const BestOfGroupSchema = z.object({
  groupId: z.string().meta({
    description:
      "Stable identifier shared by sibling task workspaces spawned from the same best-of-n request.",
  }),
  index: z.number().int().min(0).meta({
    description: "Zero-based candidate index within the best-of group.",
  }),
  total: z.number().int().min(2).meta({
    description: "Total number of candidates spawned in the best-of group.",
  }),
});

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
  aiSettingsByAgent: WorkspaceAISettingsByAgentSchema.optional().meta({
    description: "Per-agent AI settings persisted in config",
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
  bestOf: BestOfGroupSchema.optional().meta({
    description:
      "Grouping metadata for best-of-n child tasks spawned from the same parent tool call.",
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
  taskBaseCommitSha: z.string().optional().meta({
    description:
      "Git commit SHA this agent task workspace started from (used for generating git-format-patch artifacts).",
  }),
  taskBaseCommitShaByProjectPath: z.record(z.string(), z.string()).optional().meta({
    description:
      "Per-project git HEAD SHAs captured when an agent task workspace starts (used for multi-project git-format-patch artifacts).",
  }),
  taskTrunkBranch: z.string().optional().meta({
    description:
      "Trunk branch used to create/init this agent task workspace (used for restart-safe init on queued tasks).",
  }),
  archivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last archived. Workspace is considered archived if archivedAt > unarchivedAt (or unarchivedAt is absent).",
  }),
  unarchivedAt: z.string().optional().meta({
    description:
      "ISO 8601 timestamp when workspace was last unarchived. Used for recency calculation to bump restored workspaces to top.",
  }),
  projects: z
    .array(ProjectRefSchema)
    .optional()
    .meta({
      description:
        "For multi-project workspaces: list of included projects. " +
        "When >1 entry, this is a multi-project workspace. " +
        "projectPath/projectName reflect the primary project for backcompat.",
    }),
  sectionId: z.string().optional().meta({
    description: "ID of the section this workspace belongs to (optional, unsectioned if absent)",
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
  isRemoving: z.boolean().optional().meta({
    description: "True if this workspace is currently being deleted (deletion in progress).",
  }),
  isInitializing: z.boolean().optional().meta({
    description:
      "True if this workspace is currently initializing (postCreateSetup or initWorkspace running).",
  }),
});

export const WorkspaceAgentStatusSchema = z.object({
  emoji: z.string(),
  message: z.string(),
  url: z.string().optional(),
});

export const WorkspaceActivitySnapshotSchema = z.object({
  recency: z.number().meta({ description: "Unix ms timestamp of last user interaction" }),
  streaming: z.boolean().meta({ description: "Whether workspace currently has an active stream" }),
  streamingGeneration: z.number().optional().meta({
    description: "Monotonic stream generation counter for distinguishing newer background turns",
  }),
  lastModel: z.string().nullable().meta({ description: "Last model sent from this workspace" }),
  lastThinkingLevel: ThinkingLevelSchema.nullable().meta({
    description: "Last thinking/reasoning level used in this workspace",
  }),
  agentStatus: WorkspaceAgentStatusSchema.nullable().optional().meta({
    description:
      "Most recent status_set value for this workspace (used to surface background progress in sidebar).",
  }),
  hasTodos: z.boolean().optional().meta({
    description: "Whether the workspace still had todos when streaming last stopped",
  }),
  isIdleCompaction: z.boolean().optional().meta({
    description: "Whether the current streaming activity is an idle (background) compaction",
  }),
});

export const PostCompactionStateSchema = z.object({
  planPath: z.string().nullable(),
  trackedFilePaths: z.array(z.string()),
  excludedItems: z.array(z.string()),
});

export const GitStatusSchema = z.object({
  /** Current HEAD branch name (empty string if detached HEAD or not a git repo) */
  branch: z.string(),
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
