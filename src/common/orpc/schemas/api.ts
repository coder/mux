import { eventIterator } from "@orpc/server";
import { UIModeSchema } from "../../types/mode";
import { z } from "zod";
import { ChatStatsSchema, SessionUsageFileSchema } from "./chatStats";
import {
  NameGenerationErrorSchema,
  ProjectRemoveErrorSchema,
  SendMessageErrorSchema,
} from "./errors";
import { BranchListResultSchema, FilePartSchema, MuxMessageSchema } from "./message";
import { ProjectConfigSchema, SectionConfigSchema } from "./project";
import { ResultSchema } from "./result";
import { SshPromptEventSchema, SshPromptResponseInputSchema } from "./ssh";
import {
  RuntimeConfigSchema,
  RuntimeAvailabilitySchema,
  RuntimeEnablementIdSchema,
} from "./runtime";
import { SecretSchema } from "./secrets";
import {
  CompletedMessagePartSchema,
  OnChatModeSchema,
  SendMessageOptionsSchema,
  StreamEndEventSchema,
  UpdateStatusSchema,
  WorkspaceChatMessageSchema,
} from "./stream";
import { LayoutPresetsConfigSchema } from "./uiLayouts";
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
  AgentSkillDescriptorSchema,
  AgentSkillIssueSchema,
  AgentSkillPackageSchema,
  SkillNameSchema,
} from "./agentSkill";
import {
  AgentDefinitionDescriptorSchema,
  AgentDefinitionPackageSchema,
  AgentIdSchema,
} from "./agentDefinition";
import {
  MCPAddGlobalParamsSchema,
  MCPAddParamsSchema,
  MCPListParamsSchema,
  MCPRemoveGlobalParamsSchema,
  MCPRemoveParamsSchema,
  MCPServerMapSchema,
  MCPSetEnabledGlobalParamsSchema,
  MCPSetEnabledParamsSchema,
  MCPSetToolAllowlistGlobalParamsSchema,
  MCPSetToolAllowlistParamsSchema,
  MCPTestGlobalParamsSchema,
  MCPTestParamsSchema,
  MCPTestResultSchema,
  WorkspaceMCPOverridesSchema,
} from "./mcp";
import { PolicyGetResponseSchema } from "./policy";

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
export { signing, type SigningCapabilities, type SignatureEnvelope } from "./signing";

// Re-export analytics schemas
export { analytics } from "./analytics";

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
    input: z.object({
      workspaceId: z.string(),
      messages: z.array(MuxMessageSchema),
      model: z.string(),
    }),
    output: ChatStatsSchema,
  },
};

// Providers
export const AWSCredentialStatusSchema = z.object({
  region: z.string().optional(),
  /** Optional AWS shared config profile name (equivalent to AWS_PROFILE). */
  profile: z.string().optional(),
  bearerTokenSet: z.boolean(),
  accessKeyIdSet: z.boolean(),
  secretAccessKeySet: z.boolean(),
});

export const ProviderModelEntrySchema = z.union([
  z.string().min(1),
  z
    .object({
      id: z.string().min(1),
      contextWindowTokens: z.number().int().positive().optional(),
      mappedToModel: z.string().min(1).optional(),
    })
    .strict(),
]);

export const ProviderConfigInfoSchema = z.object({
  apiKeySet: z.boolean(),
  /** Whether this provider is enabled for model requests */
  isEnabled: z.boolean().default(true),
  /** Whether this provider is configured and ready to use */
  isConfigured: z.boolean(),
  baseUrl: z.string().optional(),
  models: z.array(ProviderModelEntrySchema).optional(),
  /** OpenAI-specific fields */
  serviceTier: z.enum(["auto", "default", "flex", "priority"]).optional(),
  wireFormat: z.enum(["responses", "chatCompletions"]).optional(),
  /** Anthropic-specific fields */
  cacheTtl: z.enum(["5m", "1h"]).optional(),
  /** OpenAI-only: whether Codex OAuth tokens are present in providers.jsonc */
  codexOauthSet: z.boolean().optional(),
  /**
   * OpenAI-only: default auth precedence to use for Codex-OAuth-allowed models when BOTH
   * ChatGPT OAuth and an OpenAI API key are configured.
   */
  codexOauthDefaultAuth: z.enum(["oauth", "apiKey"]).optional(),
  /** AWS-specific fields (only present for bedrock provider) */
  aws: AWSCredentialStatusSchema.optional(),
  /** Mux Gateway-specific fields */
  couponCodeSet: z.boolean().optional(),
  /** Mux Gateway-specific: which models are enabled for gateway routing */
  gatewayModels: z.array(z.string()).optional(),
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
      models: z.array(ProviderModelEntrySchema),
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

// Policy (admin-enforced config)
export const policy = {
  get: {
    input: z.void(),
    output: PolicyGetResponseSchema,
  },
  // Subscription: emits when the effective policy changes (file refresh)
  onChanged: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
  // Force a refresh of the effective policy (re-reads MUX_POLICY_FILE or Governor policy)
  refreshNow: {
    input: z.void(),
    output: ResultSchema(PolicyGetResponseSchema, z.string()),
  },
};

// Mux Gateway OAuth (desktop login flow)
export const muxGatewayOauth = {
  startDesktopFlow: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
};

// GitHub Copilot OAuth (Device Code Flow)
export const copilotOauth = {
  startDeviceFlow: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        verificationUri: z.string(),
        userCode: z.string(),
      }),
      z.string()
    ),
  },
  waitForDeviceFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDeviceFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
};

// Mux Governor OAuth (enrollment for enterprise policy service)
export const muxGovernorOauth = {
  startDesktopFlow: {
    input: z.object({ governorOrigin: z.string() }).strict(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
};

// Codex OAuth (ChatGPT subscription auth)
export const codexOauth = {
  startDesktopFlow: {
    input: z.void(),
    output: ResultSchema(z.object({ flowId: z.string(), authorizeUrl: z.string() }), z.string()),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  startDeviceFlow: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        userCode: z.string(),
        verifyUrl: z.string(),
        intervalSeconds: z.number().int().positive(),
      }),
      z.string()
    ),
  },
  waitForDeviceFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDeviceFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  disconnect: {
    input: z.void(),
    output: ResultSchema(z.void(), z.string()),
  },
};
// Mux Gateway
export const muxGateway = {
  getAccountStatus: {
    input: z.void(),
    output: ResultSchema(
      z.object({
        remaining_microdollars: z.number().int().nonnegative(),
        ai_gateway_concurrent_requests_per_user: z.number().int().nonnegative(),
      }),
      z.string()
    ),
  },
};

const MCPOAuthPendingServerSchema = z
  .object({
    // OAuth is only supported for remote transports.
    transport: z.union([z.literal("http"), z.literal("sse"), z.literal("auto")]),
    url: z.string(),
  })
  .strict();

// MCP OAuth
export const mcpOauth = {
  startDesktopFlow: {
    input: z
      .object({
        projectPath: z.string().optional(),
        serverName: z.string(),
        pendingServer: MCPOAuthPendingServerSchema.optional(),
      })
      .strict(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForDesktopFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelDesktopFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  startServerFlow: {
    input: z
      .object({
        projectPath: z.string().optional(),
        serverName: z.string(),
        pendingServer: MCPOAuthPendingServerSchema.optional(),
      })
      .strict(),
    output: ResultSchema(
      z.object({
        flowId: z.string(),
        authorizeUrl: z.string(),
        redirectUri: z.string(),
      }),
      z.string()
    ),
  },
  waitForServerFlow: {
    input: z
      .object({
        flowId: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  cancelServerFlow: {
    input: z.object({ flowId: z.string() }).strict(),
    output: z.void(),
  },
  getAuthStatus: {
    input: z.object({ serverUrl: z.string() }).strict(),
    output: z.object({
      serverUrl: z.string().optional(),
      isLoggedIn: z.boolean(),
      hasRefreshToken: z.boolean(),
      scope: z.string().optional(),
      updatedAtMs: z.number().optional(),
    }),
  },
  logout: {
    input: z.object({ serverUrl: z.string() }).strict(),
    output: ResultSchema(z.void(), z.string()),
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
  getDefaultProjectDir: {
    input: z.void(),
    output: z.string(),
  },
  setDefaultProjectDir: {
    input: z.object({ path: z.string() }),
    output: z.void(),
  },
  clone: {
    input: z
      .object({
        repoUrl: z.string(),
        cloneParentDir: z.string().nullish(),
      })
      .strict(),
    output: eventIterator(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("progress"), line: z.string() }),
        z.object({
          type: z.literal("success"),
          projectConfig: ProjectConfigSchema,
          normalizedPath: z.string(),
        }),
        z.object({
          type: z.literal("error"),
          code: z.enum([
            "ssh_host_key_rejected",
            "ssh_credential_cancelled",
            "ssh_prompt_timeout",
            "clone_failed",
            "destination_exists",
          ]),
          error: z.string(),
          normalizedPath: z.string().nullish(),
        }),
      ])
    ),
  },
  pickDirectory: {
    input: z.void(),
    output: z.string().nullable(),
  },
  remove: {
    input: z.object({ projectPath: z.string() }),
    output: ResultSchema(z.void(), ProjectRemoveErrorSchema),
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
  runtimeAvailability: {
    input: z.object({ projectPath: z.string() }),
    output: RuntimeAvailabilitySchema,
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
  mcpOauth: {
    startDesktopFlow: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
          pendingServer: MCPOAuthPendingServerSchema.optional(),
        })
        .strict(),
      output: ResultSchema(
        z.object({
          flowId: z.string(),
          authorizeUrl: z.string(),
          redirectUri: z.string(),
        }),
        z.string()
      ),
    },
    waitForDesktopFlow: {
      input: z
        .object({
          flowId: z.string(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
      output: ResultSchema(z.void(), z.string()),
    },
    cancelDesktopFlow: {
      input: z.object({ flowId: z.string() }).strict(),
      output: z.void(),
    },
    startServerFlow: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
          pendingServer: MCPOAuthPendingServerSchema.optional(),
        })
        .strict(),
      output: ResultSchema(
        z.object({
          flowId: z.string(),
          authorizeUrl: z.string(),
          redirectUri: z.string(),
        }),
        z.string()
      ),
    },
    waitForServerFlow: {
      input: z
        .object({
          flowId: z.string(),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
      output: ResultSchema(z.void(), z.string()),
    },
    cancelServerFlow: {
      input: z.object({ flowId: z.string() }).strict(),
      output: z.void(),
    },
    getAuthStatus: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
        })
        .strict(),
      output: z.object({
        serverUrl: z.string().optional(),
        isLoggedIn: z.boolean(),
        hasRefreshToken: z.boolean(),
        scope: z.string().optional(),
        updatedAtMs: z.number().optional(),
      }),
    },
    logout: {
      input: z
        .object({
          projectPath: z.string(),
          serverName: z.string(),
        })
        .strict(),
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

/**
 * MCP server configuration.
 *
 * Global config lives in <muxHome>/mcp.jsonc, with optional repo overrides in <projectPath>/.mux/mcp.jsonc.
 */
export const mcp = {
  list: {
    input: MCPListParamsSchema,
    output: MCPServerMapSchema,
  },
  add: {
    input: MCPAddGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
  remove: {
    input: MCPRemoveGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
  test: {
    input: MCPTestGlobalParamsSchema,
    output: MCPTestResultSchema,
  },
  setEnabled: {
    input: MCPSetEnabledGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
  setToolAllowlist: {
    input: MCPSetToolAllowlistGlobalParamsSchema,
    output: ResultSchema(z.void(), z.string()),
  },
};

/**
 * Secrets store.
 *
 * - When no projectPath is provided: global secrets
 * - When projectPath is provided: project-only secrets
 */
export const secrets = {
  get: {
    input: z.object({ projectPath: z.string().optional() }),
    output: z.array(SecretSchema),
  },
  update: {
    input: z.object({
      projectPath: z.string().optional(),
      secrets: z.array(SecretSchema),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
};

// Re-export Coder schemas from dedicated file
export {
  coder,
  CoderInfoSchema,
  CoderPresetSchema,
  CoderTemplateSchema,
  CoderWorkspaceConfigSchema,
  CoderWorkspaceSchema,
  CoderWorkspaceStatusSchema,
} from "./coder";

// Workspace
const DebugLlmRequestSnapshotSchema = z
  .object({
    capturedAt: z.number(),
    workspaceId: z.string(),
    messageId: z.string().optional(),
    model: z.string(),
    providerName: z.string(),
    thinkingLevel: z.string(),
    mode: z.string().optional(),
    agentId: z.string().optional(),
    maxOutputTokens: z.number().optional(),
    systemMessage: z.string(),
    messages: z.array(z.unknown()),
    response: z
      .object({
        capturedAt: z.number(),
        metadata: StreamEndEventSchema.shape.metadata,
        parts: z.array(CompletedMessagePartSchema),
      })
      .strict()
      .optional(),
  })
  .strict();

export const workspace = {
  list: {
    input: z
      .object({
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
  regenerateTitle: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.object({ title: z.string() }), z.string()),
  },
  updateAgentAISettings: {
    input: z.object({
      workspaceId: z.string(),
      agentId: AgentIdSchema,
      aiSettings: WorkspaceAISettingsSchema,
    }),
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
  archive: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  unarchive: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.void(), z.string()),
  },
  archiveMergedInProject: {
    input: z.object({ projectPath: z.string() }),
    output: ResultSchema(
      z.object({
        archivedWorkspaceIds: z.array(z.string()),
        skippedWorkspaceIds: z.array(z.string()),
        errors: z.array(
          z.object({
            workspaceId: z.string(),
            error: z.string(),
          })
        ),
      }),
      z.string()
    ),
  },
  fork: {
    input: z.object({ sourceWorkspaceId: z.string(), newName: z.string().optional() }),
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
        fileParts: z.array(FilePartSchema).optional(),
      }),
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
  answerDelegatedToolCall: {
    input: z
      .object({
        workspaceId: z.string(),
        toolCallId: z.string(),
        result: z.unknown(),
      })
      .strict(),
    output: ResultSchema(z.void(), z.string()),
  },
  resumeStream: {
    input: z.object({
      workspaceId: z.string(),
      options: SendMessageOptionsSchema,
    }),
    output: ResultSchema(
      z.object({
        started: z.boolean(),
      }),
      SendMessageErrorSchema
    ),
  },
  setAutoRetryEnabled: {
    input: z.object({
      workspaceId: z.string(),
      enabled: z.boolean(),
      // Runtime-only toggle for temporary retry flows (do not mutate persisted preference).
      persist: z.boolean().nullish(),
    }),
    output: ResultSchema(
      z.object({
        previousEnabled: z.boolean(),
        enabled: z.boolean(),
      }),
      z.string()
    ),
  },
  getStartupAutoRetryModel: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(z.string().nullable(), z.string()),
  },
  setAutoCompactionThreshold: {
    input: z.object({
      workspaceId: z.string(),
      threshold: z.number().finite().min(0.1).max(1.0),
    }),
    output: ResultSchema(z.void(), z.string()),
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
      /**
       * Replace strategy.
       * - destructive (default): clear history, then append summary
       * - append-compaction-boundary: keep history and append summary as durable boundary
       */
      mode: z.enum(["destructive", "append-compaction-boundary"]).nullish(),
      /** When true, delete the plan file (new + legacy paths) and clear plan tracking state. */
      deletePlanFile: z.boolean().optional(),
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  getDevcontainerInfo: {
    input: z.object({ workspaceId: z.string() }),
    output: z
      .object({
        containerName: z.string(),
        containerWorkspacePath: z.string(),
        hostWorkspacePath: z.string(),
      })
      .nullable(),
  },
  getInfo: {
    input: z.object({ workspaceId: z.string() }),
    output: FrontendWorkspaceMetadataSchema.nullable(),
  },
  getLastLlmRequest: {
    input: z.object({ workspaceId: z.string() }),
    output: ResultSchema(DebugLlmRequestSnapshotSchema.nullable(), z.string()),
  },
  getFullReplay: {
    input: z.object({ workspaceId: z.string() }),
    output: z.array(WorkspaceChatMessageSchema),
  },
  history: {
    loadMore: {
      input: z.object({
        workspaceId: z.string(),
        cursor: z
          .object({
            beforeHistorySequence: z.number(),
            beforeMessageId: z.string().nullish(),
          })
          .nullish(),
      }),
      output: z.object({
        messages: z.array(WorkspaceChatMessageSchema),
        nextCursor: z
          .object({
            beforeHistorySequence: z.number(),
            beforeMessageId: z.string().nullish(),
          })
          .nullable(),
        hasOlder: z.boolean(),
      }),
    },
  },
  /**
   * Load an archived subagent transcript (chat.jsonl + optional partial.json) from this workspace's
   * session dir.
   */
  getSubagentTranscript: {
    input: z.object({
      /** Workspace that owns the transcript artifact index (usually the current workspace). */
      workspaceId: z.string().optional(),
      /** Child task/workspace id whose transcript should be loaded. */
      taskId: z.string(),
    }),
    output: z.object({
      messages: z.array(MuxMessageSchema),
      /** Task-level model string used when running the sub-agent (optional for legacy entries). */
      model: z.string().optional(),
      /** Task-level thinking/reasoning level used when running the sub-agent (optional for legacy entries). */
      thinkingLevel: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).optional(),
    }),
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
    input: z.object({
      workspaceId: z.string(),
      mode: OnChatModeSchema.optional(),
      // One-shot migration hint: legacy renderer localStorage opt-out value.
      // Used only when backend auto-retry preference file is missing.
      legacyAutoRetryEnabled: z.boolean().optional(),
    }),
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
    /**
     * Peek output for a background bash process without consuming the bash_output cursor.
     */
    getOutput: {
      input: z.object({
        workspaceId: z.string(),
        processId: z.string(),
        fromOffset: z.number().int().nonnegative().optional(),
        tailBytes: z.number().int().positive().max(1_000_000).optional(),
      }),
      output: ResultSchema(
        z.object({
          status: z.enum(["running", "exited", "killed", "failed"]),
          output: z.string(),
          nextOffset: z.number().int().nonnegative(),
          truncatedStart: z.boolean(),
        }),
        z.string()
      ),
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
    /** When true, include agents disabled by front-matter (for Settings UI). */
    includeDisabled: z.boolean().optional(),
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

// Agent skills
export const agentSkills = {
  list: {
    input: AgentDiscoveryInputSchema,
    output: z.array(AgentSkillDescriptorSchema),
  },
  listDiagnostics: {
    input: AgentDiscoveryInputSchema,
    output: z.object({
      skills: z.array(AgentSkillDescriptorSchema),
      invalidSkills: z.array(AgentSkillIssueSchema),
    }),
  },
  get: {
    input: AgentDiscoveryInputSchema.and(z.object({ skillName: SkillNameSchema })),
    output: AgentSkillPackageSchema,
  },
};

// Name generation for new workspaces (decoupled from workspace creation)
export const nameGeneration = {
  generate: {
    input: z.object({
      message: z.string(),
      /** Ordered list of model candidates to try (backend resolves gateway routing in createModel) */
      candidates: z.array(z.string()),
    }),
    output: ResultSchema(
      z.object({
        /** Short git-safe name with suffix (e.g., "plan-a1b2") */
        name: z.string(),
        /** Human-readable title (e.g., "Fix plan mode over SSH") */
        title: z.string(),
        modelUsed: z.string(),
      }),
      NameGenerationErrorSchema
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
  /**
   * Attach to a terminal session with race-free state restore.
   * First yields { type: "screenState", data: string } with serialized screen (~4KB),
   * then yields { type: "output", data: string } for each live output chunk.
   * Guarantees no missed output between state snapshot and live stream.
   */
  attach: {
    input: z.object({ sessionId: z.string() }),
    output: eventIterator(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("screenState"), data: z.string() }),
        z.object({ type: z.literal("output"), data: z.string() }),
      ])
    ),
  },

  onExit: {
    input: z.object({ sessionId: z.string() }),
    output: eventIterator(z.number()),
  },
  openWindow: {
    input: z.object({
      workspaceId: z.string(),
      /** Optional session ID to reattach to an existing terminal session (for pop-out handoff) */
      sessionId: z.string().optional(),
    }),
    output: z.void(),
  },
  closeWindow: {
    input: z.object({ workspaceId: z.string() }),
    output: z.void(),
  },
  /**
   * Subscribe to terminal activity changes across all workspaces.
   * First event is a snapshot of all workspace aggregates.
   * Subsequent events are per-workspace updates.
   */
  activity: {
    subscribe: {
      input: z.void(),
      output: eventIterator(
        z.discriminatedUnion("type", [
          z.object({
            type: z.literal("snapshot"),
            workspaces: z.record(
              z.string(),
              z.object({
                activeCount: z.number(),
                totalSessions: z.number(),
              })
            ),
          }),
          z.object({
            type: z.literal("update"),
            workspaceId: z.string(),
            activity: z.object({
              activeCount: z.number(),
              totalSessions: z.number(),
            }),
          }),
        ])
      ),
    },
  },
  /**
   * List active terminal sessions for a workspace.
   * Used by frontend to discover existing sessions to reattach to after reload.
   */
  listSessions: {
    input: z.object({ workspaceId: z.string() }),
    output: z.array(z.string()),
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

export const ServerAuthSessionSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAtMs: z.number().int().nonnegative(),
  lastUsedAtMs: z.number().int().nonnegative(),
  isCurrent: z.boolean(),
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

export const serverAuth = {
  listSessions: {
    input: z.void(),
    output: z.array(ServerAuthSessionSchema),
  },
  revokeSession: {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ removed: z.boolean() }),
  },
  revokeOtherSessions: {
    input: z.void(),
    output: z.object({ revokedCount: z.number().int().nonnegative() }),
  },
};

// Config (global settings)
const SubagentAiDefaultsEntrySchema = z
  .object({
    modelString: z.string().min(1).optional(),
    thinkingLevel: z.enum(["off", "low", "medium", "high", "xhigh", "max"]).optional(),
    enabled: z.boolean().optional(),
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
        proposePlanImplementReplacesChatHistory: z.boolean().optional(),
        planSubagentExecutorRouting: z.enum(["exec", "orchestrator", "auto"]).optional(),
        planSubagentDefaultsToOrchestrator: z.boolean().optional(),
        bashOutputCompactionMinLines: z.number().int().optional(),
        bashOutputCompactionMinTotalBytes: z.number().int().optional(),
        bashOutputCompactionMaxKeptLines: z.number().int().optional(),
        bashOutputCompactionTimeoutMs: z.number().int().optional(),
        bashOutputCompactionHeuristicFallback: z.boolean().optional(),
      }),
      muxGatewayEnabled: z.boolean().optional(),
      muxGatewayModels: z.array(z.string()).optional(),
      defaultModel: z.string().optional(),
      hiddenModels: z.array(z.string()).optional(),
      stopCoderWorkspaceOnArchive: z.boolean(),
      runtimeEnablement: z.record(z.string(), z.boolean()),
      defaultRuntime: z.string().nullable(),
      agentAiDefaults: AgentAiDefaultsSchema,
      // Legacy fields (downgrade compatibility)
      subagentAiDefaults: SubagentAiDefaultsSchema,
      // Mux Governor enrollment status (safe fields only - token never exposed)
      muxGovernorUrl: z.string().nullable(),
      muxGovernorEnrolled: z.boolean(),
    }),
  },
  saveConfig: {
    input: z.object({
      taskSettings: z.object({
        maxParallelAgentTasks: z.number().int(),
        maxTaskNestingDepth: z.number().int(),
        proposePlanImplementReplacesChatHistory: z.boolean().optional(),
        planSubagentExecutorRouting: z.enum(["exec", "orchestrator", "auto"]).optional(),
        planSubagentDefaultsToOrchestrator: z.boolean().optional(),
        bashOutputCompactionMinLines: z.number().int().optional(),
        bashOutputCompactionMinTotalBytes: z.number().int().optional(),
        bashOutputCompactionMaxKeptLines: z.number().int().optional(),
        bashOutputCompactionTimeoutMs: z.number().int().optional(),
        bashOutputCompactionHeuristicFallback: z.boolean().optional(),
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
  updateMuxGatewayPrefs: {
    input: z.object({
      muxGatewayEnabled: z.boolean(),
      muxGatewayModels: z.array(z.string()),
    }),
    output: z.void(),
  },
  updateModelPreferences: {
    input: z.object({
      defaultModel: z.string().optional(),
      hiddenModels: z.array(z.string()).optional(),
    }),
    output: z.void(),
  },
  updateCoderPrefs: {
    input: z
      .object({
        stopCoderWorkspaceOnArchive: z.boolean(),
      })
      .strict(),
    output: z.void(),
  },
  updateRuntimeEnablement: {
    input: z
      .object({
        projectPath: z.string().nullish(),
        runtimeEnablement: z.record(z.string(), z.boolean()).nullish(),
        defaultRuntime: RuntimeEnablementIdSchema.nullish(),
        runtimeOverridesEnabled: z.boolean().nullish(),
      })
      .strict(),
    output: z.void(),
  },
  unenrollMuxGovernor: {
    input: z.void(),
    output: z.void(),
  },
};

// UI Layouts (global settings)
export const uiLayouts = {
  getAll: {
    input: z.void(),
    output: LayoutPresetsConfigSchema,
  },
  saveAll: {
    input: z
      .object({
        layoutPresets: LayoutPresetsConfigSchema,
      })
      .strict(),
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
export const UpdateChannelSchema = z.enum(["stable", "nightly"]);

export const update = {
  check: {
    input: z.object({ source: z.enum(["auto", "manual"]).optional() }).optional(),
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
  getChannel: {
    input: z.void(),
    output: UpdateChannelSchema,
  },
  setChannel: {
    input: z.object({ channel: UpdateChannelSchema }),
    output: z.void(),
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
  getLogPath: {
    input: z.void(),
    output: z.object({ path: z.string() }),
  },
  clearLogs: {
    input: z.void(),
    output: z.object({
      success: z.boolean(),
      error: z.string().nullish(),
    }),
  },
  subscribeLogs: {
    input: z.object({
      level: z.enum(["error", "warn", "info", "debug"]).nullish(),
    }),
    output: eventIterator(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("snapshot"),
          epoch: z.number(),
          entries: z.array(
            z.object({
              timestamp: z.number(),
              level: z.enum(["error", "warn", "info", "debug"]),
              message: z.string(),
              location: z.string(),
            })
          ),
        }),
        z.object({
          type: z.literal("append"),
          epoch: z.number(),
          entries: z.array(
            z.object({
              timestamp: z.number(),
              level: z.enum(["error", "warn", "info", "debug"]),
              message: z.string(),
              location: z.string(),
            })
          ),
        }),
        z.object({
          type: z.literal("reset"),
          epoch: z.number(),
        }),
      ])
    ),
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

export const ssh = {
  prompt: {
    subscribe: {
      input: z.void(),
      output: eventIterator(SshPromptEventSchema),
    },
    respond: {
      input: SshPromptResponseInputSchema,
      output: ResultSchema(z.void(), z.string()),
    },
  },
};
