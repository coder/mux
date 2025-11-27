import { eventIterator } from "@orpc/server";
import { z } from "zod";
import { ChatStatsSchema } from "./chatStats";
import { SendMessageErrorSchema } from "./errors";
import { BranchListResultSchema, ImagePartSchema, MuxMessageSchema } from "./message";
import { ProjectConfigSchema } from "./project";
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
import {
  FrontendWorkspaceMetadataSchema,
  WorkspaceActivitySnapshotSchema,
  WorkspaceMetadataSchema,
} from "./workspace";

// --- API Router Schemas ---

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
    output: ResultSchema(
      z.object({
        workspaceId: z.string().optional(),
        metadata: FrontendWorkspaceMetadataSchema.optional(),
      }),
      SendMessageErrorSchema
    ),
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

export type WorkspaceSendMessageOutput = z.infer<typeof workspace.sendMessage.output>;

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
