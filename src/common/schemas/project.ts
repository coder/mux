import { RuntimeConfigSchema } from "@/common/orpc/schemas/runtime";
import { WorkspaceMCPOverridesSchema } from "@/common/orpc/schemas/mcp";
import {
  BestOfGroupSchema,
  ProjectRefSchema,
  WorkflowTaskMetadataSchema,
  WorkspaceGoalDefaultsOverrideSchema,
  WorkspaceHeartbeatSettingsSchema,
  WorkspaceWorkflowScheduleSchema,
  WorkflowScheduleContextModeSchema,
  WorkflowScheduleTargetBranchNameSchema,
} from "@/common/orpc/schemas/workspace";
import {
  WorkspaceAISettingsByAgentSchema,
  WorkspaceAISettingsSchema,
} from "@/common/orpc/schemas/workspaceAiSettings";
import { ThinkingLevelSchema } from "@/common/types/thinking";
import {
  WORKFLOW_SCHEDULE_MAX_INTERVAL_MS,
  WORKFLOW_SCHEDULE_MIN_INTERVAL_MS,
} from "@/constants/workflowSchedule";
import { z } from "zod";

import { RuntimeEnablementIdSchema } from "./ids";
import { RuntimeEnablementOverridesSchema } from "./runtimeEnablement";

export const WorktreeArchiveSnapshotProjectSchema = z.object({
  projectPath: z.string().meta({
    description: "Absolute path to the project repo that this archive snapshot entry restores.",
  }),
  projectName: z.string().meta({ description: "Display name for the project repo." }),
  storageKey: z.string().meta({
    description: "Filesystem-safe per-project storage key for archive artifacts.",
  }),
  branchName: z.string().meta({ description: "Workspace branch name captured for this project." }),
  trunkBranch: z
    .string()
    .meta({ description: "Trunk branch used to compute merge-base fallback." }),
  baseSha: z.string().meta({ description: "Commit used as the restore base for patch replay." }),
  headSha: z.string().meta({ description: "HEAD commit SHA captured at archive time." }),
  committedPatchPath: z.string().optional().meta({
    description: "Session-dir-relative path to the git-format-patch mailbox for committed history.",
  }),
  stagedPatchPath: z.string().optional().meta({
    description: "Session-dir-relative path to the staged tracked diff artifact.",
  }),
  unstagedPatchPath: z.string().optional().meta({
    description: "Session-dir-relative path to the unstaged tracked diff artifact.",
  }),
});

export const WorktreeArchiveSnapshotSchema = z.object({
  version: z.literal(1).meta({ description: "Snapshot metadata schema version." }),
  capturedAt: z
    .string()
    .meta({ description: "ISO 8601 timestamp when the snapshot was captured." }),
  stateDirPath: z.string().meta({
    description: "Session-dir-relative path to the directory that stores snapshot artifacts.",
  }),
  projects: z.array(WorktreeArchiveSnapshotProjectSchema).min(1).meta({
    description: "Per-project restore metadata for the archived workspace snapshot.",
  }),
});

// Shared with workspace metadata IPC; see src/common/orpc/schemas/workspace.ts.
export { WorkflowTaskMetadataSchema };

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
  pendingAutoTitle: z.boolean().optional().meta({
    description:
      "True when a forked workspace is waiting to generate a title from its first accepted continue message.",
  }),
  forkFamilyBaseName: z.string().optional().meta({
    description:
      "Stable base workspace name used to continue auto-generated fork numbering without relying on title heuristics.",
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
  heartbeat: WorkspaceHeartbeatSettingsSchema.optional().meta({
    description: "Persisted heartbeat settings for this workspace.",
  }),
  workflowSchedule: WorkspaceWorkflowScheduleSchema.optional().meta({
    description: "Persisted scheduled workflow run for this workspace.",
  }),
  goalDefaults: WorkspaceGoalDefaultsOverrideSchema.optional().meta({
    description:
      "Per-workspace overrides for goal creation defaults. Sparse; each null field follows the global `goalDefaults`.",
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
  tags: z
    .record(z.string(), z.string())
    .optional()
    .meta({
      description:
        "Programmatic key/value tags (e.g. workItemKey) set via API/CLI/workflow actions; " +
        "not rendered in the UI. Stable identity for orchestration loops, unlike title/name.",
    }),
  workflowTask: WorkflowTaskMetadataSchema.optional().meta({
    description: "Workflow run/step metadata for workflow-spawned child tasks.",
  }),
  bestOf: BestOfGroupSchema.optional().meta({
    description: "Grouping metadata for child tasks spawned from the same parent tool call.",
  }),
  taskStatus: z
    .enum(["queued", "starting", "running", "awaiting_report", "interrupted", "reported"])
    .optional()
    .meta({
      description:
        "Agent task lifecycle status for child workspaces (queued|starting|running|awaiting_report|interrupted|reported).",
    }),
  taskLaunchError: z.string().optional().meta({
    description: "Startup failure recorded before an agent task could begin streaming.",
  }),
  taskRecoveryAttempts: z.number().int().nonnegative().optional().meta({
    description:
      "Completion-tool recovery prompts sent to this agent task since it last completed successfully. Persisted (not in-memory) so crash/restart recovery loops stay bounded; cleared on a successful report, on plan-to-exec handoff, and on user-initiated resume.",
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
  taskOnRefusal: z.enum(["fail", "fallback"]).optional().meta({
    description:
      "Model-refusal policy for this agent task: 'fail' opts out of configured model-fallback chains so refusals settle terminally (e.g. workflow verifier steps). Default behavior is 'fallback'.",
  }),
  taskPrompt: z.string().optional().meta({
    description:
      "Initial prompt for a queued agent task (persisted only until the task actually starts).",
  }),
  taskExperiments: z
    .object({
      programmaticToolCalling: z.boolean().optional(),
      programmaticToolCallingExclusive: z.boolean().optional(),
      advisorTool: z.boolean().optional(),
      dynamicWorkflows: z.boolean().optional(),
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
  taskBaseCommitShaByProjectPath: z.record(z.string(), z.string()).optional().meta({
    description:
      "Per-project git HEAD SHAs captured when an agent task workspace starts (used for multi-project git-format-patch artifacts).",
  }),
  taskTrunkBranch: z.string().optional().meta({
    description:
      "Trunk branch used to create/init this agent task workspace (used for restart-safe init on queued tasks).",
  }),
  taskIsolation: z
    .enum(["fork", "none"])
    .optional()
    .meta({
      description:
        'Workspace isolation for an agent task. "none" means the task shares its parent workspace\'s ' +
        "checkout (no fork): its `path` points at the parent's checkout, init is skipped, and removal " +
        'must not delete that shared directory. Absent/"fork" is the isolated default.',
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
  worktreeArchiveSnapshot: WorktreeArchiveSnapshotSchema.optional().meta({
    description:
      "Durable restore metadata captured before archive-time worktree deletion. Present only while an archived snapshot is awaiting restore.",
  }),
  projects: z.array(ProjectRefSchema).optional(),
  subProjectPath: z.string().optional().meta({
    description:
      "Sub-project path that provides cwd and AGENTS.md context while sharing the parent project's worktree.",
  }),
});

export const ProjectWorkflowScheduleTargetSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("existing-workspace").meta({
      description: "Run the project automation in a specific existing workspace.",
    }),
    workspaceId: z.string().min(1).meta({
      description: "Workspace used as the execution target for this automation.",
    }),
  }),
  z.object({
    type: z.literal("new-workspace").meta({
      description: "Create a fresh workspace for each due project automation run.",
    }),
    branchName: WorkflowScheduleTargetBranchNameSchema.optional().meta({
      description:
        "Optional branch/workspace-name base for the fresh workspace. Runtime collision handling may suffix it.",
    }),
    trunkBranch: z.string().min(1).meta({
      description: "Base branch checked out when creating the fresh automation workspace.",
    }),
    title: z.string().min(1).optional().meta({
      description: "Optional human-readable title for each fresh automation workspace.",
    }),
  }),
]);

/**
 * Project-level scheduled workflow automation. The project owns the automation;
 * workspaces are only runtime targets resolved at dispatch time.
 */
export const ProjectWorkflowScheduleSchema = z.object({
  id: z.string().min(1).meta({
    description: "Stable project-local automation identifier.",
  }),
  title: z.string().min(1).optional().meta({
    description: "Optional user-facing automation title.",
  }),
  enabled: z.boolean().meta({
    description: "Whether this project automation is active.",
  }),
  workflowName: z.string().min(1).meta({
    description: "Named workflow definition to run (resolved like workflows.start).",
  }),
  args: z.record(z.string(), z.unknown()).optional().meta({
    description: "JSON args passed to the workflow run.",
  }),
  contextMode: WorkflowScheduleContextModeSchema.optional().meta({
    description:
      'Context preparation before existing-workspace scheduled runs. Missing values default to "normal" at read time for backward compatibility.',
  }),
  target: ProjectWorkflowScheduleTargetSchema.meta({
    description: "Workspace target policy for this project automation.",
  }),
  intervalMs: z
    .number()
    .int()
    .min(WORKFLOW_SCHEDULE_MIN_INTERVAL_MS)
    .max(WORKFLOW_SCHEDULE_MAX_INTERVAL_MS)
    .meta({ description: "Wall-clock interval between dispatched runs." }),
  lastRunStartedAt: z.string().optional().meta({
    description:
      "ISO timestamp of the last dispatched run (persisted before dispatch so restarts retry at most once per interval).",
  }),
});

export const ProjectConfigSchema = z.object({
  displayName: z.string().nullish().meta({
    description: "Custom display name for the project",
  }),
  color: z.string().optional().meta({
    description: "Project folder accent color (hex value like #5a9bd4 or preset name)",
  }),
  /**
   * Parent project path when this project is a one-level sub-project. Parentage is
   * re-derived from registered paths during project load/list so stale persisted
   * values never become the source of truth.
   */
  parentProjectPath: z.string().optional().meta({
    description: "Absolute path to the top-level parent project for one-level sub-projects",
  }),
  workspaces: z.array(WorkspaceConfigSchema),
  workflowSchedules: z.array(ProjectWorkflowScheduleSchema).optional().meta({
    description: "Project-level scheduled workflow automations.",
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
  projectKind: z.enum(["user", "system"]).optional().meta({
    description:
      "Project classification. System projects are hidden from user-facing project lists unless explicitly requested.",
  }),
  trusted: z.boolean().optional().meta({
    description:
      "Whether the user has confirmed trust for this project. Untrusted projects cannot run hooks or user scripts.",
  }),
});

export type WorktreeArchiveSnapshotProject = z.infer<typeof WorktreeArchiveSnapshotProjectSchema>;
export type WorktreeArchiveSnapshot = z.infer<typeof WorktreeArchiveSnapshotSchema>;
