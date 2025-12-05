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
import { FrontendWorkspaceMetadataSchema, WorkspaceActivitySnapshotSchema } from "./workspace";
import {
  MCPAddParamsSchema,
  MCPRemoveParamsSchema,
  MCPServerMapSchema,
  MCPTestParamsSchema,
  MCPTestResultSchema,
} from "./mcp";

// Re-export telemetry schemas
export { telemetry, TelemetryEventSchema } from "./telemetry";

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
  listBranches: {
    input: z.object({ projectPath: z.string() }),
    output: BranchListResultSchema,
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
};

export type WorkspaceSendMessageOutput = z.infer<typeof workspace.sendMessage.output>;

// Name generation for new workspaces (decoupled from workspace creation)
export const nameGeneration = {
  generate: {
    input: z.object({
      message: z.string(),
      /** Model to use if preferred small models (Haiku, GPT-Mini) aren't available */
      fallbackModel: z.string().optional(),
    }),
    output: ResultSchema(
      z.object({
        name: z.string(),
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
  /**
   * Open a file in the user's preferred external editor.
   * Uses $VISUAL -> $EDITOR -> 'code' fallback chain.
   *
   * In desktop mode: Opens native terminal or spawns GUI editor directly.
   * In server mode: Creates embedded terminal session with the editor command.
   *
   * When openedInEmbeddedTerminal is true, the frontend should open/focus
   * the terminal panel for the specified workspace to show the editor.
   */
  openInEditor: {
    input: z.object({
      filePath: z.string(),
      /** Required for server mode to create embedded terminal */
      workspaceId: z.string().optional(),
    }),
    output: ResultSchema(
      z.object({
        /** True if opened in embedded terminal (server mode with $EDITOR) */
        openedInEmbeddedTerminal: z.boolean(),
        /** Workspace ID if embedded terminal was used */
        workspaceId: z.string().optional(),
        /** Terminal session ID if embedded terminal was used */
        sessionId: z.string().optional(),
      }),
      z.string()
    ),
  },
  /**
   * Check if an external editor is available for opening files.
   * Used to conditionally show/hide Edit buttons in the UI.
   *
   * Discovery priority:
   * 1. $VISUAL - User's explicit GUI editor preference
   * 2. $EDITOR - User's explicit editor preference
   * 3. GUI fallbacks: cursor, code, zed, subl (discovered via `which`)
   * 4. Terminal fallbacks: nvim, vim, vi, nano, emacs (discovered via `which`)
   */
  canOpenInEditor: {
    input: z.void(),
    output: z.object({
      /** How the editor was discovered */
      method: z.enum(["visual", "editor", "gui-fallback", "terminal-fallback", "none"]),
      /** The actual editor command that will be used (undefined when method="none") */
      editor: z.string().optional(),
      /** True if the editor requires a terminal window (terminal-fallback only) */
      requiresTerminal: z.boolean().optional(),
    }),
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
