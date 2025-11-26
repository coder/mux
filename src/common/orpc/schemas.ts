import { eventIterator } from "@orpc/server";
import { z } from "zod";

// --- Shared Helper Schemas ---

export const ResultSchema = <T extends z.ZodTypeAny, E extends z.ZodTypeAny = z.ZodString>(
  dataSchema: T,
  errorSchema: E = z.string() as unknown as E
) =>
  z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), data: dataSchema }),
    z.object({ success: z.literal(false), error: errorSchema }),
  ]);

// --- Dependent Types Schemas ---

// from src/common/types/runtime.ts
export const RuntimeModeSchema = z.enum(["local", "ssh"]);

export const RuntimeConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal(RuntimeModeSchema.enum.local),
    srcBaseDir: z.string(),
  }),
  z.object({
    type: z.literal(RuntimeModeSchema.enum.ssh),
    host: z.string(),
    srcBaseDir: z.string(),
    identityFile: z.string().optional(),
    port: z.number().optional(),
  }),
]);

// from src/common/types/project.ts
export const WorkspaceConfigSchema = z.object({
  path: z.string(),
  id: z.string().optional(),
  name: z.string().optional(),
  createdAt: z.string().optional(),
  runtimeConfig: RuntimeConfigSchema.optional(),
});

export const ProjectConfigSchema = z.object({
  workspaces: z.array(WorkspaceConfigSchema),
});

// from src/common/types/workspace.ts
export const WorkspaceMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  createdAt: z.string().optional(),
  runtimeConfig: RuntimeConfigSchema,
});

export const FrontendWorkspaceMetadataSchema = WorkspaceMetadataSchema.extend({
  namedWorkspacePath: z.string(),
});

export const WorkspaceActivitySnapshotSchema = z.object({
  recency: z.number(),
  streaming: z.boolean(),
  lastModel: z.string().nullable(),
});

// from src/common/types/chatStats.ts
export const TokenConsumerSchema = z.object({
  name: z.string(),
  tokens: z.number(),
  percentage: z.number(),
  fixedTokens: z.number().optional(),
  variableTokens: z.number().optional(),
});

// Usage stats component
export const ChatUsageComponentSchema = z.object({
  tokens: z.number(),
  cost_usd: z.number().optional(),
});

// Enhanced usage type for display
export const ChatUsageDisplaySchema = z.object({
  input: ChatUsageComponentSchema,
  cached: ChatUsageComponentSchema,
  cacheCreate: ChatUsageComponentSchema,
  output: ChatUsageComponentSchema,
  reasoning: ChatUsageComponentSchema,
  model: z.string().optional(),
});

export const ChatStatsSchema = z.object({
  consumers: z.array(TokenConsumerSchema),
  totalTokens: z.number(),
  model: z.string(),
  tokenizerName: z.string(),
  usageHistory: z.array(ChatUsageDisplaySchema),
});

// from src/common/types/errors.ts
export const SendMessageErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("api_key_not_found"), provider: z.string() }),
  z.object({ type: z.literal("provider_not_supported"), provider: z.string() }),
  z.object({ type: z.literal("invalid_model_string"), message: z.string() }),
  z.object({ type: z.literal("unknown"), raw: z.string() }),
]);

export const StreamErrorTypeSchema = z.enum([
  "authentication",
  "rate_limit",
  "server_error",
  "api",
  "retry_failed",
  "aborted",
  "network",
  "context_exceeded",
  "quota",
  "model_not_found",
  "unknown",
]);

// from src/common/types/tools.ts
export const BashToolResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    wall_duration_ms: z.number(),
    output: z.string(),
    exitCode: z.literal(0),
    note: z.string().optional(),
    truncated: z
      .object({
        reason: z.string(),
        totalLines: z.number(),
      })
      .optional(),
  }),
  z.object({
    success: z.literal(false),
    wall_duration_ms: z.number(),
    output: z.string().optional(),
    exitCode: z.number(),
    error: z.string(),
    note: z.string().optional(),
    truncated: z
      .object({
        reason: z.string(),
        totalLines: z.number(),
      })
      .optional(),
  }),
]);

// from src/common/types/secrets.ts
export const SecretSchema = z.object({
  key: z.string(),
  value: z.string(),
});

// from src/common/types/providerOptions.ts
export const MuxProviderOptionsSchema = z.object({
  anthropic: z.object({ use1MContext: z.boolean().optional() }).optional(),
  openai: z
    .object({
      disableAutoTruncation: z.boolean().optional(),
      forceContextLimitError: z.boolean().optional(),
      simulateToolPolicyNoop: z.boolean().optional(),
    })
    .optional(),
  google: z.any().optional(),
  ollama: z.any().optional(),
  openrouter: z.any().optional(),
  xai: z
    .object({
      searchParameters: z
        .object({
          mode: z.enum(["auto", "off", "on"]),
          returnCitations: z.boolean().optional(),
          fromDate: z.string().optional(),
          toDate: z.string().optional(),
          maxSearchResults: z.number().optional(),
          sources: z
            .array(
              z.discriminatedUnion("type", [
                z.object({
                  type: z.literal("web"),
                  country: z.string().optional(),
                  excludedWebsites: z.array(z.string()).optional(),
                  allowedWebsites: z.array(z.string()).optional(),
                  safeSearch: z.boolean().optional(),
                }),
                z.object({
                  type: z.literal("x"),
                  excludedXHandles: z.array(z.string()).optional(),
                  includedXHandles: z.array(z.string()).optional(),
                  postFavoriteCount: z.number().optional(),
                  postViewCount: z.number().optional(),
                  xHandles: z.array(z.string()).optional(),
                }),
                z.object({
                  type: z.literal("news"),
                  country: z.string().optional(),
                  excludedWebsites: z.array(z.string()).optional(),
                  safeSearch: z.boolean().optional(),
                }),
                z.object({
                  type: z.literal("rss"),
                  links: z.array(z.string()),
                }),
              ])
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

// from src/common/utils/git/numstatParser.ts
export const FileTreeNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  get children() {
    return z.array(FileTreeNodeSchema);
  },
  stats: z
    .object({
      filePath: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .optional(),
  totalStats: z
    .object({
      filePath: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .optional(),
});

// from src/common/types/terminal.ts
export const TerminalSessionSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  cols: z.number(),
  rows: z.number(),
});

export const TerminalCreateParamsSchema = z.object({
  workspaceId: z.string(),
  cols: z.number(),
  rows: z.number(),
});

export const TerminalResizeParamsSchema = z.object({
  sessionId: z.string(),
  cols: z.number(),
  rows: z.number(),
});

// from src/common/types/message.ts & ipc.ts
export const ImagePartSchema = z.object({
  url: z.string(),
  mediaType: z.string(),
});

// Message Parts
export const MuxTextPartSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  timestamp: z.number().optional(),
});

export const MuxReasoningPartSchema = z.object({
  type: z.literal("reasoning"),
  text: z.string(),
  timestamp: z.number().optional(),
});

export const MuxToolPartSchema = z.object({
  type: z.literal("dynamic-tool"),
  toolCallId: z.string(),
  toolName: z.string(),
  state: z.enum(["input-available", "output-available"]),
  input: z.unknown(),
  output: z.unknown().optional(),
  timestamp: z.number().optional(),
});

export const MuxImagePartSchema = z.object({
  type: z.literal("file"),
  mediaType: z.string(),
  url: z.string(),
  filename: z.string().optional(),
});

// Export types inferred from schemas for reuse across app/test code.
export type ImagePart = z.infer<typeof ImagePartSchema>;
export type MuxImagePart = z.infer<typeof MuxImagePartSchema>;

// MuxMessage (simplified)
export const MuxMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["system", "user", "assistant"]),
  parts: z.array(
    z.discriminatedUnion("type", [
      MuxTextPartSchema,
      MuxReasoningPartSchema,
      MuxToolPartSchema,
      MuxImagePartSchema,
    ])
  ),
  createdAt: z.date().optional(),
  metadata: z
    .object({
      historySequence: z.number().optional(),
      timestamp: z.number().optional(),
      model: z.string().optional(),
      usage: z.any().optional(),
      providerMetadata: z.record(z.string(), z.unknown()).optional(),
      duration: z.number().optional(),
      systemMessageTokens: z.number().optional(),
      muxMetadata: z.any().optional(),
      cmuxMetadata: z.any().optional(), // Legacy field for backward compatibility
      compacted: z.boolean().optional(), // Marks compaction summary messages
      toolPolicy: z.any().optional(),
      mode: z.string().optional(),
      partial: z.boolean().optional(),
      synthetic: z.boolean().optional(),
      error: z.string().optional(),
      errorType: StreamErrorTypeSchema.optional(),
      historicalUsage: ChatUsageDisplaySchema.optional(),
    })
    .optional(),
});

// IPC Types
export const BranchListResultSchema = z.object({
  branches: z.array(z.string()),
  recommendedTrunk: z.string(),
});

export const SendMessageOptionsSchema = z.object({
  editMessageId: z.string().optional(),
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  model: z.string("No model specified"),
  toolPolicy: z.any().optional(), // Complex recursive type, skipping for now
  additionalSystemInstructions: z.string().optional(),
  maxOutputTokens: z.number().optional(),
  providerOptions: MuxProviderOptionsSchema.optional(),
  mode: z.string().optional(),
  muxMetadata: z.any().optional(), // Black box
});

// Chat Events

export const CaughtUpMessageSchema = z.object({
  type: z.literal("caught-up"),
});

export const StreamErrorMessageSchema = z.object({
  type: z.literal("stream-error"),
  messageId: z.string(),
  error: z.string(),
  errorType: StreamErrorTypeSchema,
});

export const DeleteMessageSchema = z.object({
  type: z.literal("delete"),
  historySequences: z.array(z.number()),
});

export const StreamStartEventSchema = z.object({
  type: z.literal("stream-start"),
  workspaceId: z.string(),
  messageId: z.string(),
  model: z.string(),
  historySequence: z.number(),
});

export const StreamDeltaEventSchema = z.object({
  type: z.literal("stream-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  tokens: z.number(),
  timestamp: z.number(),
});

export const CompletedMessagePartSchema = z.discriminatedUnion("type", [
  MuxReasoningPartSchema,
  MuxTextPartSchema,
  MuxToolPartSchema,
]);

export const StreamEndEventSchema = z.object({
  type: z.literal("stream-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  metadata: z.object({
    model: z.string(),
    usage: z.any().optional(),
    providerMetadata: z.record(z.string(), z.unknown()).optional(),
    duration: z.number().optional(),
    systemMessageTokens: z.number().optional(),
    historySequence: z.number().optional(),
    timestamp: z.number().optional(),
  }),
  parts: z.array(CompletedMessagePartSchema),
});

export const StreamAbortEventSchema = z.object({
  type: z.literal("stream-abort"),
  workspaceId: z.string(),
  messageId: z.string(),
  metadata: z
    .object({
      usage: z.any().optional(),
      duration: z.number().optional(),
    })
    .optional(),
  abandonPartial: z.boolean().optional(),
});

export const ToolCallStartEventSchema = z.object({
  type: z.literal("tool-call-start"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown(),
  tokens: z.number(),
  timestamp: z.number(),
});

export const ToolCallDeltaEventSchema = z.object({
  type: z.literal("tool-call-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  delta: z.unknown(),
  tokens: z.number(),
  timestamp: z.number(),
});

export const ToolCallEndEventSchema = z.object({
  type: z.literal("tool-call-end"),
  workspaceId: z.string(),
  messageId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  result: z.unknown(),
});

export const ReasoningDeltaEventSchema = z.object({
  type: z.literal("reasoning-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  delta: z.string(),
  tokens: z.number(),
  timestamp: z.number(),
});

export const ReasoningEndEventSchema = z.object({
  type: z.literal("reasoning-end"),
  workspaceId: z.string(),
  messageId: z.string(),
});

// Usage schema matching LanguageModelV2Usage from @ai-sdk/provider
export const LanguageModelUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
});

export const UsageDeltaEventSchema = z.object({
  type: z.literal("usage-delta"),
  workspaceId: z.string(),
  messageId: z.string(),
  usage: LanguageModelUsageSchema,
});

export const WorkspaceInitEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("init-start"),
    hookPath: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("init-output"),
    line: z.string(),
    timestamp: z.number(),
    isError: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("init-end"),
    exitCode: z.number(),
    timestamp: z.number(),
  }),
]);

export const QueuedMessageChangedEventSchema = z.object({
  type: z.literal("queued-message-changed"),
  workspaceId: z.string(),
  queuedMessages: z.array(z.string()),
  displayText: z.string(),
  imageParts: z.array(ImagePartSchema).optional(),
});

export const RestoreToInputEventSchema = z.object({
  type: z.literal("restore-to-input"),
  workspaceId: z.string(),
  text: z.string(),
  imageParts: z.array(ImagePartSchema).optional(),
});

export const WorkspaceChatMessageSchema = z.union([
  MuxMessageSchema,
  z.discriminatedUnion("type", [
    CaughtUpMessageSchema,
    StreamErrorMessageSchema,
    DeleteMessageSchema,
    StreamStartEventSchema,
    StreamDeltaEventSchema,
    StreamEndEventSchema,
    StreamAbortEventSchema,
    ToolCallStartEventSchema,
    ToolCallDeltaEventSchema,
    ToolCallEndEventSchema,
    ReasoningDeltaEventSchema,
    ReasoningEndEventSchema,
    UsageDeltaEventSchema,
    // Flatten WorkspaceInitEventSchema members into this union if possible,
    // or just include it as a union member. Zod discriminated union is strict.
    // WorkspaceInitEventSchema is already a discriminated union.
    // We can spread its options if we want a single discriminated union,
    // but WorkspaceInitEventSchema is useful on its own.
    // Let's add the individual init event schemas here manually to keep one big union?
    // Or just nest the union.
    // z.discriminatedUnion only works with object schemas.
    // WorkspaceInitEventSchema is a ZodDiscriminatedUnion.
    // So we can't put it inside another z.discriminatedUnion directly unless we extract its options.
    // Easier to just use z.union for the top level mix.
  ]),
  // Add WorkspaceInitEventSchema separately to the top union
  WorkspaceInitEventSchema,
  z.discriminatedUnion("type", [QueuedMessageChangedEventSchema, RestoreToInputEventSchema]),
]);

// Update Status
export const UpdateStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("checking") }),
  z.object({ type: z.literal("available"), info: z.object({ version: z.string() }) }),
  z.object({ type: z.literal("up-to-date") }),
  z.object({ type: z.literal("downloading"), percent: z.number() }),
  z.object({ type: z.literal("downloaded"), info: z.object({ version: z.string() }) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

// --- API Router Schema ---

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
export const ProviderConfigInfoSchema = z.object({
  apiKeySet: z.boolean(),
  baseUrl: z.string().optional(),
  models: z.array(z.string()).optional(),
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
  listBranches: {
    input: z.object({ projectPath: z.string() }),
    output: BranchListResultSchema,
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
};

export type WorkspaceSendMessageOutput = z.infer<typeof workspace.sendMessage.output>;

// Workspace
export const workspace = {
  list: {
    input: z.void(),
    output: z.array(FrontendWorkspaceMetadataSchema),
  },
  create: {
    input: z.object({
      projectPath: z.string(),
      branchName: z.string(),
      trunkBranch: z.string(),
      runtimeConfig: RuntimeConfigSchema.optional(),
    }),
    output: z.union([
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
  fork: {
    input: z.object({ sourceWorkspaceId: z.string(), newName: z.string() }),
    output: z.union([
      z.object({
        success: z.literal(true),
        metadata: WorkspaceMetadataSchema,
        projectPath: z.string(),
      }),
      z.object({ success: z.literal(false), error: z.string() }),
    ]),
  },
  sendMessage: {
    input: z.object({
      workspaceId: z.string().nullable(),
      message: z.string(),
      options: SendMessageOptionsSchema.extend({
        imageParts: z.array(ImagePartSchema).optional(),
        runtimeConfig: RuntimeConfigSchema.optional(),
        projectPath: z.string().optional(),
        trunkBranch: z.string().optional(),
      }).optional(),
    }),
    output: z.union([
      ResultSchema(z.void(), SendMessageErrorSchema),
      z.object({
        success: z.literal(true),
        workspaceId: z.string(),
        metadata: FrontendWorkspaceMetadataSchema,
      }),
    ]),
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
      options: z.object({ abandonPartial: z.boolean().optional() }).optional(),
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
    }),
    output: ResultSchema(z.void(), z.string()),
  },
  getInfo: {
    input: z.object({ workspaceId: z.string() }),
    output: FrontendWorkspaceMetadataSchema.nullable(),
  },
  executeBash: {
    input: z.object({
      workspaceId: z.string(),
      script: z.string(),
      options: z
        .object({
          timeout_secs: z.number().optional(),
          niceness: z.number().optional(),
        })
        .optional(),
    }),
    output: ResultSchema(BashToolResultSchema, z.string()),
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
export const server = {
  getLaunchProject: {
    input: z.void(),
    output: z.string().nullable(),
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

// General
export const general = {
  listDirectory: {
    input: z.object({ path: z.string() }),
    output: ResultSchema(FileTreeNodeSchema),
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
};
