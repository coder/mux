import { eventIterator } from "@orpc/server";
import { UIModeSchema } from "../../types/mode";
import { z } from "zod";
import { ChatStatsSchema, SessionUsageFileSchema } from "./chatStats";
import { SendMessageErrorSchema } from "./errors";
import { BranchListResultSchema, ImagePartSchema, MuxMessageSchema } from "./message";
import { ProjectConfigSchema, SectionConfigSchema } from "./project";
import { ResultSchema } from "./result";
import { RuntimeConfigSchema } from "./runtime";
import { SecretSchema } from "./secrets";
import { SendMessageOptionsSchema, UpdateStatusSchema, WorkspaceChatMessageSchema } from "./stream";
import {
  TerminalCreateParamsSchema,
  TerminalResizeParamsSchema,
  TerminalSessionSchema,
} from "./terminal";
import { BashToolResultSchema, FileTreeNodeSchema } from "./tools";
import { WorkspaceStatsSnapshotSchema } from "./workspaceStats";
import { FrontendWorkspaceMetadataSchema, WorkspaceActivitySnapshotSchema } from "./workspace";
import { WorkspaceAISettingsSchema } from "./workspaceAiSettings";
import {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionPackageSchema,
  AgentIdSchema,
} from "./agentDefinition";
import {
  MCPAddParamsSchema,
  MCPRemoveParamsSchema,
  MCPServerMapSchema,
  MCPSetEnabledParamsSchema,
  MCPSetToolAllowlistParamsSchema,
  MCPTestParamsSchema,
  MCPTestResultSchema,
  WorkspaceMCPOverridesSchema,
} from "./mcp";

// Experiments
export const ExperimentValueSchema = z.object({
  value: z.union([z.string(), z.boolean(), z.null()]),
  source: z.enum(["posthog", "cache", "disabled"]),
});

export const experiments = {
  getAll: {
    input: z.void(),
    output: z.record(z.string(), ExperimentValueSchema),
  },
  reload: {
    input: z.void(),
    output: z.void(),
  },
};
// Re-export telemetry schemas
export { telemetry, TelemetryEventSchema } from "./telemetry";

// Re-export signing schemas
export { signing, type SigningCapabilities, type SignCredentials } from "./signing";

// --- API Router Schemas ---

// Background process info (for UI display)
export const BackgroundProcessInfoSchema = z.object({
  id: z.string(),
  pid: z.number(),
  script: z.string(),
  displayName: z.string().optional(),
  startTime: z.number(),
  status: z.enum(["running", "exited", "killed", "failed"]),
  exitCode: z.number().optional(),
});

export type BackgroundProcessInfo = z.infer<typeof BackgroundProcessInfoSchema>;

// Tokenizer
export const tokenizer = {
  countTokens: {
    input: z.object({ model: z.string(), text: z.string() }),
    output: z.number(),
  },
  countTokensBatch: {
    input: z.object({ model: z.string(), texts: z.array(z.string()) }),
    output: z.array(z.number()),
  },
  calculateStats: {
    input: z.object({ messages: z.array(MuxMessageSchema), model: z.string() }),
    output: ChatStatsSchema,
  },
};

// Providers
export const AWSCredentialStatusSchema = z.object({
  region: z.string().optional(),
  bearerTokenSet: z.boolean(),
  accessKeyIdSet: z.boolean(),
  secretAccessKeySet: z.boolean(),
});

export const ProviderConfigInfoSchema = z.object({
  apiKeySet: z.boolean(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()).optional(),
  /** OpenAI-specific fields */
  serviceTier: z.enum(["auto", "default", "flex", "priority"]).optional(),
  /** AWS-specific fields (only present for bedrock provider) */
  aws: AWSCredentialStatusSchema.optional(),
  /** Mux Gateway-specific fields */
  couponCodeSet: z.boolean().optional(),
});

export const ProvidersConfigMapSchema = z.record(z.string(), ProviderConfigInfoSchema);

export const providers = {
  setProviderConfig: {
    input: z.object({
      provider: z.string(),
      keyPath: z.array(z.string()),
      value: z.string(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  getConfig: {
    input: z.void(),
    output: ProvidersConfigMapSchema,
  },
  setModels: {
    input: z.object({
      provider: z.string(),
      models: z.array(z.string()),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  list: {
    input: z.void(),
    output: z.array(z.string()),
  },
  // Subscription: emits when provider config changes (API keys, models, etc.)
  onConfigChanged: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
};

// Projects
export const projects = {
  create: {
    input: z.object({ projectPath: z.string() }),
    output: ResultSchema(
      z.object({
        projectConfig: ProjectConfigSchema,
        normalizedPath: z.string(),
      }),
      z.string()
    ),
  },
  pickDirectory: {
    input: z.void(),
    output: z.string().nullable(),
  },
  remove: {
    input: z.object({ projectPath: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  list: {
    input: z.void(),
    output: z.array(z.tuple([z.string(), ProjectConfigSchema])),
  },
  getFileCompletions: {
    input: z
      .object({
        projectPath: z.string(),
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      })
      .strict(),
    output: z.object({ paths: z.array(z.string()) }),
  },
  listBranches: {
    input: z.object({ projectPath: z.string() }),
    output: BranchListResultSchema,
  },
  gitInit: {
    input: z.object({ projectPath: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  mcp: {
    list: {
      input: z.object({ projectPath: z.string() }),
      output: MCPServerMapSchema,
    },
    add: {
      input: MCPAddParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
    remove: {
      input: MCPRemoveParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
    test: {
      input: MCPTestParamsSchema,
      output: MCPTestResultSchema,
    },
    setEnabled: {
      input: MCPSetEnabledParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
    setToolAllowlist: {
      input: MCPSetToolAllowlistParamsSchema,
      output: ResultSchema(z.void(), z.string()),
    },
  },
  secrets: {
    get: {
      input: z.object({ projectPath: z.string() }),
      output: z.array(SecretSchema),
    },
    update: {
      input: z.object({
        projectPath: z.string(),
        secrets: z.array(SecretSchema),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  idleCompaction: {
    get: {
      input: z.object({ projectPath: z.string() }),
      output: z.object({ hours: z.number().nullable() }),
    },
    set: {
      input: z.object({
        projectPath: z.string(),
        hours: z.number().min(1).nullable(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  sections: {
    list: {
      input: z.object({ projectPath: z.string() }),
      output: z.array(SectionConfigSchema),
    },
    create: {
      input: z.object({
        projectPath: z.string(),
        name: z.string().min(1),
        color: z.string().optional(),
      }),
      output: ResultSchema(SectionConfigSchema, z.string()),
    },
    update: {
      input: z.object({
        projectPath: z.string(),
        sectionId: z.string(),
        name: z.string().min(1).optional(),
        color: z.string().optional(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
    remove: {
      input: z.object({
        projectPath: z.string(),
        sectionId: z.string(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
    reorder: {
      input: z.object({
        projectPath: z.string(),
        sectionIds: z.array(z.string()),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
    assignWorkspace: {
      input: z.object({
        projectPath: z.string(),
        workspaceId: z.string(),
        sectionId: z.string().nullable(),
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
};

// Workspace
export const workspace = {
  list: {
    input: z
      .object({
        includePostCompaction: z.boolean().optional(),
        /** When true, only return archived workspaces. Default returns only non-archived. */
        archived: z.boolean().optional(),
      })
      .optional(),
    output: z.array(FrontendWorkspaceMetadataSchema),
  },
  create: {
    input: z.object({
      projectPath: z.string(),
      branchName: z.string(),
      /** Trunk branch to fork from - only required for worktree/SSH runtimes, ignored for local */
      trunkBranch: z.string().optional(),
      /** Human-readable title (e.g., "Fix plan mode over SSH") - optional for backwards compat */
      title: z.string().optional(),
      runtimeConfig: RuntimeConfigSchema.optional(),
      /** Section ID to assign the new workspace to (optional) */
      sectionId: z.string().optional(),
    }),
    output: z.discriminatedUnion("success", [
      z.object({ success: z.literal(true), metadata: FrontendWorkspaceMetadataSchema }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
  },
  remove: {
    input: z.object({
      workspaceId: z.string(),
      options: z.object({ force: z.boolean().optional() }).optional(),
    }),
    output: z.object({ success: z.boolean(), error: z.string().optional() }),
  },
  rename: {
    input: z.object({ workspaceId: z.string(), newName: z.string() }),
    output: ResultSchema(z.object({ newWorkspaceId: z.string() }), z.string()),
  },
  updateTitle: {
    input: z.object({ workspaceId: z.string(), title: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  updateModeAISettings: {
    input: z.object({
      workspaceId: z.string(),
      mode: UIModeSchema,
      aiSettings: WorkspaceAISettingsSchema,
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  updateAISettings: {
    input: z.object({
      workspaceId: z.string(),
      aiSettings: WorkspaceAISettingsSchema,
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  archive: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  unarchive: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  fork: {
    input: z.object({ sourceWorkspaceId: z.string(), newName: z.string() }),
    output: z.discriminatedUnion("success", [
      z.object({
        success: z.literal(true),
        metadata: FrontendWorkspaceMetadataSchema,
        projectPath: z.string(),
      }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
  },
  sendMessage: {
    input: z.object({
      workspaceId: z.string(),
      message: z.string(),
      options: SendMessageOptionsSchema.extend({
        imageParts: z.array(ImagePartSchema).optional(),
      }).optional(),
    }),
    output: ResultSchema(z.object({}), SendMessageErrorSchema),
  },
  answerAskUserQuestion: {
    input: z
      .object({
        workspaceId: z.string(),
        toolCallId: z.string(),
        answers: z.record(z.string(), z.string()),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  resumeStream: {
    input: z.object({
      workspaceId: z.string(),
      options: SendMessageOptionsSchema,
    }),
    output: ResultSchema(z.void(), SendMessageErrorSchema),
  },
  interruptStream: {
    input: z.object({
      workspaceId: z.string(),
      options: z
        .object({
          soft: z.boolean().optional(),
          abandonPartial: z.boolean().optional(),
          sendQueuedImmediately: z.boolean().optional(),
        })
        .optional(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  clearQueue: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  truncateHistory: {
    input: z.object({
      workspaceId: z.string(),
      percentage: z.number().optional(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  replaceChatHistory: {
    input: z.object({
      workspaceId: z.string(),
      summaryMessage: MuxMessageSchema,
      /** When true, delete the plan file (new + legacy paths) and clear plan tracking state. */
      deletePlanFile: z.boolean().optional(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  getInfo: {
    input: z.object({ workspaceId: z.string() }),
    output: FrontendWorkspaceMetadataSchema.nullable(),
  },
  getFullReplay: {
    input: z.object({ workspaceId: z.string() }),
    output: z.array(WorkspaceChatMessageSchema),
  },
  executeBash: {
    input: z.object({
      workspaceId: z.string(),
      script: z.string(),
      options: z
        .object({
          timeout_secs: z.number().optional(),
        })
        .optional(),
    }),
    output: ResultSchema(BashToolResultSchema, z.string()),
  },
  getFileCompletions: {
    input: z
      .object({
        workspaceId: z.string(),
        query: z.string(),
        limit: z.number().int().positive().max(50).optional(),
      })
      .strict(),
    output: z.object({ paths: z.array(z.string()) }),
  },
  // Subscriptions
  onChat: {
    input: z.object({ workspaceId: z.string() }),
    output: eventIterator(WorkspaceChatMessageSchema), // Stream event
  },
  onMetadata: {
    input: z.void(),
    output: eventIterator(
      z.object({
        workspaceId: z.string(),
        metadata: FrontendWorkspaceMetadataSchema.nullable(),
      })
    ),
  },
  activity: {
    list: {
      input: z.void(),
      output: z.record(z.string(), WorkspaceActivitySnapshotSchema),
    },
    subscribe: {
      input: z.void(),
      output: eventIterator(
        z.object({
          workspaceId: z.string(),
          activity: WorkspaceActivitySnapshotSchema.nullable(),
        })
      ),
    },
  },
  /**
   * Get the current plan file content for a workspace.
   * Used by UI to refresh plan display when file is edited externally.
   */
  getPlanContent: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(
      z.object({
        content: z.string(),
        path: z.string(),
      }),
      z.string()
    ),
  },
  backgroundBashes: {
    /**
     * Subscribe to background bash state changes for a workspace.
     * Emits full state on connect, then incremental updates.
     */
    subscribe: {
      input: z.object({ workspaceId: z.string() }),
      output: eventIterator(
        z.object({
          /** Background processes (not including foreground ones being waited on) */
          processes: z.array(BackgroundProcessInfoSchema),
          /** Tool call IDs of foreground bashes that can be sent to background */
          foregroundToolCallIds: z.array(z.string()),
        })
      ),
    },
    terminate: {
      input: z.object({ workspaceId: z.string(), processId: z.string() }),
      output: ResultSchema(z.void(), z.string()),
    },
    /**
     * Send a foreground bash process to background.
     * The process continues running but the agent stops waiting for it.
     */
    sendToBackground: {
      input: z.object({ workspaceId: z.string(), toolCallId: z.string() }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  /**
   * Get post-compaction context state for a workspace.
   * Returns plan path (if exists) and tracked file paths that will be injected.
   */
  getPostCompactionState: {
    input: z.object({ workspaceId: z.string() }),
    output: z.object({
      planPath: z.string().nullable(),
      trackedFilePaths: z.array(z.string()),
      excludedItems: z.array(z.string()),
    }),
  },
  /**
   * Toggle whether a post-compaction item is excluded from injection.
   * Item IDs: "plan" for plan file, "file:<path>" for tracked files.
   */
  setPostCompactionExclusion: {
    input: z.object({
      workspaceId: z.string(),
      itemId: z.string(),
      excluded: z.boolean(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  stats: {
    subscribe: {
      input: z.object({ workspaceId: z.string() }),
      output: eventIterator(WorkspaceStatsSnapshotSchema),
    },
    clear: {
      input: z.object({ workspaceId: z.string() }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
  getSessionUsage: {
    input: z.object({ workspaceId: z.string() }),
    output: SessionUsageFileSchema.optional(),
  },
  /** Batch fetch session usage for multiple workspaces (for archived workspaces cost display) */
  getSessionUsageBatch: {
    input: z.object({ workspaceIds: z.array(z.string()) }),
    output: z.record(z.string(), SessionUsageFileSchema.optional()),
  },
  /** Per-workspace MCP configuration (overrides project-level mcp.jsonc) */
  mcp: {
    get: {
      input: z.object({ workspaceId: z.string() }),
      output: WorkspaceMCPOverridesSchema,
    },
    set: {
      input: z.object({
        workspaceId: z.string(),
        overrides: WorkspaceMCPOverridesSchema,
      }),
      output: ResultSchema(z.void(), z.string()),
    },
  },
};

export type WorkspaceSendMessageOutput = z.infer<typeof workspace.sendMessage.output>;

// Tasks (agent sub-workspaces)
export const tasks = {
  create: {
    input: z
      .object({
        parentWorkspaceId: z.string(),
        kind: z.literal("agent"),
        agentId: AgentIdSchema.optional(),
        /** @deprecated Legacy alias for agentId (kept for downgrade compatibility). */
        agentType: z.string().min(1).optional(),
        prompt: z.string(),
        title: z.string().min(1),
        modelString: z.string().optional(),
        thinkingLevel: z.string().optional(),
      })
      .superRefine((value, ctx) => {
        const hasAgentId = typeof value.agentId === "string" && value.agentId.trim().length > 0;
        const hasAgentType =
          typeof value.agentType === "string" && value.agentType.trim().length > 0;

        if (hasAgentId === hasAgentType) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "tasks.create: exactly one of agentId or agentType is required",
            path: ["agentId"],
          });
        }
      }),
    output: ResultSchema(
      z.object({
        taskId: z.string(),
        kind: z.literal("agent"),
        status: z.enum(["queued", "running"]),
      }),
      z.string()
    ),
  },
};

// Agent definitions (unifies UI modes + subagents)
// Agents can be discovered from either the PROJECT path or the WORKSPACE path.
// - Project path: <projectPath>/.mux/agents - shared across all workspaces
// - Workspace path: <worktree>/.mux/agents - workspace-specific (useful for iterating)
// Default is workspace path when workspaceId is provided.
// Use disableWorkspaceAgents in SendMessageOptions to skip workspace agents during message sending.

// At least one of projectPath or workspaceId must be provided for agent discovery.
// Agent discovery input supports:
// - workspaceId only: resolve projectPath from workspace metadata, discover from worktree
// - projectPath only: discover from project path (project page, no workspace yet)
// - both: discover from worktree using workspaceId
// - disableWorkspaceAgents: when true with workspaceId, use workspace's runtime but discover
//   from projectPath instead of worktree (useful for SSH workspaces when iterating on agents)
const AgentDiscoveryInputSchema = z
  .object({
    projectPath: z.string().optional(),
    workspaceId: z.string().optional(),
    /** When true, skip workspace worktree and discover from projectPath (but still use workspace runtime) */
    disableWorkspaceAgents: z.boolean().optional(),
  })
  .refine((data) => Boolean(data.projectPath ?? data.workspaceId), {
    message: "Either projectPath or workspaceId must be provided",
  });

export const agents = {
  list: {
    input: AgentDiscoveryInputSchema,
    output: z.array(AgentDefinitionDescriptorSchema),
  },
  get: {
    input: AgentDiscoveryInputSchema.and(z.object({ agentId: AgentIdSchema })),
    output: AgentDefinitionPackageSchema,
  },
};

// Name generation for new workspaces (decoupled from workspace creation)
export const nameGeneration = {
  generate: {
    input: z.object({
      message: z.string(),
      /** Models to try in order (frontend converts to gateway format if needed) */
      preferredModels: z.array(z.string()).optional(),
      /** Model to use if preferred models aren't available */
      fallbackModel: z.string().optional(),
    }),
    output: ResultSchema(
      z.object({
        /** Short git-safe name with suffix (e.g., "plan-a1b2") */
        name: z.string(),
        /** Human-readable title (e.g., "Fix plan mode over SSH") */
        title: z.string(),
        modelUsed: z.string(),
      }),
      SendMessageErrorSchema
    ),
  },
};

// Window
export const window = {
  setTitle: {
    input: z.object({ title: z.string() }),
    output: z.void(),
  },
};

// Terminal
export const terminal = {
  create: {
    input: TerminalCreateParamsSchema,
    output: TerminalSessionSchema,
  },
  close: {
    input: z.object({ sessionId: z.string() }),
    output: z.void(),
  },
  resize: {
    input: TerminalResizeParamsSchema,
    output: z.void(),
  },
  sendInput: {
    input: z.object({ sessionId: z.string(), data: z.string() }),
    output: z.void(),
  },
  onOutput: {
    input: z.object({ sessionId: z.string() }),
    output: eventIterator(z.string()),
  },
  onExit: {
    input: z.object({ sessionId: z.string() }),
    output: eventIterator(z.number()),
  },
  openWindow: {
    input: z.object({ workspaceId: z.string() }),
    output: z.void(),
  },
  closeWindow: {
    input: z.object({ workspaceId: z.string() }),
    output: z.void(),
  },
  /**
   * Open the native system terminal for a workspace.
   * Opens the user's preferred terminal emulator (Ghostty, Terminal.app, etc.)
   * with the working directory set to the workspace path.
   */
  openNative: {
    input: z.object({ workspaceId: z.string() }),
    output: z.void(),
  },
};

// Server

export const ApiServerStatusSchema = z.object({
  running: z.boolean(),
  /** Base URL that is always connectable from the local machine (loopback for wildcard binds). */
  baseUrl: z.string().nullable(),
  /** The host/interface the server is actually bound to. */
  bindHost: z.string().nullable(),
  /** The port the server is listening on. */
  port: z.number().int().min(0).max(65535).nullable(),
  /** Additional base URLs that may be reachable from other devices (LAN/VPN). */
  networkBaseUrls: z.array(z.url()),
  /** Auth token required for HTTP/WS API access. */
  token: z.string().nullable(),
  /** Configured bind host from ~/.mux/config.json (if set). */
  configuredBindHost: z.string().nullable(),
  /** Configured port from ~/.mux/config.json (if set). */
  configuredPort: z.number().int().min(0).max(65535).nullable(),
  /** Whether the API server should serve the mux web UI at /. */
  configuredServeWebUi: z.boolean(),
});
export const server = {
  getLaunchProject: {
    input: z.void(),
    output: z.string().nullable(),
  },
  getSshHost: {
    input: z.void(),
    output: z.string().nullable(),
  },
  setSshHost: {
    input: z.object({ sshHost: z.string().nullable() }),
    output: z.void(),
  },
  getApiServerStatus: {
    input: z.void(),
    output: ApiServerStatusSchema,
  },
  setApiServerSettings: {
    input: z.object({
      bindHost: z.string().nullable(),
      port: z.number().int().min(0).max(65535).nullable(),
      serveWebUi: z.boolean().nullable().optional(),
    }),
    output: ApiServerStatusSchema,
  },
};

// Config (global settings)
const SubagentAiDefaultsEntrySchema = z
  .object({
    modelString: z.string().min(1).optional(),
    thinkingLevel: z.enum(["off", "low", "medium", "high", "xhigh"]).optional(),
  })
  .strict();

const ModeAiDefaultsEntrySchema = z
  .object({
    modelString: z.string().min(1).optional(),
    thinkingLevel: z.enum(["off", "low", "medium", "high", "xhigh"]).optional(),
  })
  .strict();

const ModeAiDefaultsSchema = z
  .object({
    plan: ModeAiDefaultsEntrySchema.optional(),
    exec: ModeAiDefaultsEntrySchema.optional(),
    compact: ModeAiDefaultsEntrySchema.optional(),
  })
  .strict();
const AgentAiDefaultsSchema = z.record(z.string().min(1), SubagentAiDefaultsEntrySchema);
const SubagentAiDefaultsSchema = z.record(z.string().min(1), SubagentAiDefaultsEntrySchema);

export const config = {
  getConfig: {
    input: z.void(),
    output: z.object({
      taskSettings: z.object({
        maxParallelAgentTasks: z.number().int(),
        maxTaskNestingDepth: z.number().int(),
      }),
      agentAiDefaults: AgentAiDefaultsSchema,
      // Legacy fields (downgrade compatibility)
      subagentAiDefaults: SubagentAiDefaultsSchema,
      modeAiDefaults: ModeAiDefaultsSchema,
    }),
  },
  saveConfig: {
    input: z.object({
      taskSettings: z.object({
        maxParallelAgentTasks: z.number().int(),
        maxTaskNestingDepth: z.number().int(),
      }),
      agentAiDefaults: AgentAiDefaultsSchema.optional(),
      // Legacy field (downgrade compatibility)
      subagentAiDefaults: SubagentAiDefaultsSchema.optional(),
    }),
    output: z.void(),
  },
  updateAgentAiDefaults: {
    input: z.object({
      agentAiDefaults: AgentAiDefaultsSchema,
    }),
    output: z.void(),
  },
  updateModeAiDefaults: {
    input: z.object({
      modeAiDefaults: ModeAiDefaultsSchema,
    }),
    output: z.void(),
  },
};

// Splash screens
export const splashScreens = {
  getViewedSplashScreens: {
    input: z.void(),
    output: z.array(z.string()),
  },
  markSplashScreenViewed: {
    input: z.object({
      splashId: z.string(),
    }),
    output: z.void(),
  },
};

// Update
export const update = {
  check: {
    input: z.void(),
    output: z.void(),
  },
  download: {
    input: z.void(),
    output: z.void(),
  },
  install: {
    input: z.void(),
    output: z.void(),
  },
  onStatus: {
    input: z.void(),
    output: eventIterator(UpdateStatusSchema),
  },
};

// Editor config schema for openWorkspaceInEditor
const EditorTypeSchema = z.enum(["vscode", "cursor", "zed", "custom"]);
const EditorConfigSchema = z.object({
  editor: EditorTypeSchema,
  customCommand: z.string().optional(),
});

const StatsTabVariantSchema = z.enum(["control", "stats"]);
const StatsTabOverrideSchema = z.enum(["default", "on", "off"]);
const StatsTabStateSchema = z.object({
  enabled: z.boolean(),
  variant: StatsTabVariantSchema,
  override: StatsTabOverrideSchema,
});

// Feature gates (PostHog-backed)
export const features = {
  getStatsTabState: {
    input: z.void(),
    output: StatsTabStateSchema,
  },
  setStatsTabOverride: {
    input: z.object({ override: StatsTabOverrideSchema }),
    output: StatsTabStateSchema,
  },
};

// General
export const general = {
  listDirectory: {
    input: z.object({ path: z.string() }),
    output: ResultSchema(FileTreeNodeSchema),
  },
  /**
   * Create a directory at the specified path.
   * Creates parent directories recursively if they don't exist (like mkdir -p).
   */
  createDirectory: {
    input: z.object({ path: z.string() }),
    output: ResultSchema(z.object({ normalizedPath: z.string() }), z.string()),
  },
  ping: {
    input: z.string(),
    output: z.string(),
  },
  /**
   * Test endpoint: emits numbered ticks at an interval.
   * Useful for verifying streaming works over HTTP and WebSocket.
   */
  tick: {
    input: z.object({
      count: z.number().int().min(1).max(100),
      intervalMs: z.number().int().min(10).max(5000),
    }),
    output: eventIterator(z.object({ tick: z.number(), timestamp: z.number() })),
  },
  /**
   * Open a path in the user's configured code editor.
   * For SSH workspaces with useRemoteExtension enabled, uses Remote-SSH extension.
   *
   * @param workspaceId - The workspace (used to determine if SSH and get remote host)
   * @param targetPath - The path to open (workspace directory or specific file)
   * @param editorConfig - Editor configuration from user settings
   */
  openInEditor: {
    input: z.object({
      workspaceId: z.string(),
      targetPath: z.string(),
      editorConfig: EditorConfigSchema,
    }),
    output: ResultSchema(z.void(), z.string()),
  },
};

// Menu events (main→renderer notifications)
export const menu = {
  onOpenSettings: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
};

// Voice input (transcription via OpenAI Whisper)
export const voice = {
  transcribe: {
    input: z.object({ audioBase64: z.string() }),
    output: ResultSchema(z.string(), z.string()),
  },
};

// Debug endpoints (test-only, not for production use)
export const debug = {
  /**
   * Trigger an artificial stream error for testing recovery.
   * Used by integration tests to simulate network errors mid-stream.
   */
  triggerStreamError: {
    input: z.object({
      workspaceId: z.string(),
      errorMessage: z.string().optional(),
    }),
    output: z.boolean(), // true if error was triggered on an active stream
  },
};
