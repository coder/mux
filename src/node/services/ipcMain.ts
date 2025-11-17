import assert from "@/common/utils/assert";
import type { BrowserWindow, IpcMain as ElectronIpcMain, IpcMainInvokeEvent } from "electron";
import { spawn, spawnSync } from "child_process";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { Config, ProjectConfig } from "@/node/config";
import { listLocalBranches, detectDefaultTrunkBranch } from "@/node/git";
import { AIService } from "@/node/services/aiService";
import { HistoryService } from "@/node/services/historyService";
import { PartialService } from "@/node/services/partialService";
import { AgentSession } from "@/node/services/agentSession";
import type { MuxMessage } from "@/common/types/message";
import { log } from "@/node/services/log";
import { countTokens, countTokensBatch } from "@/node/utils/main/tokenizer";
import { calculateTokenStats } from "@/common/utils/tokens/tokenStatsCalculator";
import { IPC_CHANNELS, getChatChannel } from "@/common/constants/ipc-constants";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { SendMessageError } from "@/common/types/errors";
import type {
  SendMessageOptions,
  DeleteMessage,
  ImagePart,
  WorkspaceChatMessage,
} from "@/common/types/ipc";
import { Ok, Err } from "@/common/types/result";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import type {
  WorkspaceMetadata,
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import { createBashTool } from "@/node/services/tools/bash";
import type { BashToolResult } from "@/common/types/tools";
import { secretsToRecord } from "@/common/types/secrets";
import { DisposableTempDir } from "@/node/services/tempDir";
import { InitStateManager } from "@/node/services/initStateManager";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import { validateProjectPath } from "@/node/utils/pathUtils";
import { PTYService } from "@/node/services/ptyService";
import type { TerminalWindowManager } from "@/desktop/terminalWindowManager";
import type { TerminalCreateParams, TerminalResizeParams } from "@/common/types/terminal";
import { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { generateWorkspaceName } from "./workspaceTitleGenerator";
/**
 * IpcMain - Manages all IPC handlers and service coordination
 *
 * This class encapsulates:
 * - All ipcMain handler registration
 * - Service lifecycle management (AIService, HistoryService, PartialService, InitStateManager)
 * - Event forwarding from services to renderer
 *
 * Design:
 * - Constructor accepts only Config for dependency injection
 * - Services are created internally from Config
 * - register() accepts ipcMain and BrowserWindow for handler setup
 */
export class IpcMain {
  private readonly config: Config;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly aiService: AIService;
  private readonly initStateManager: InitStateManager;
  private readonly extensionMetadata: ExtensionMetadataService;
  private readonly ptyService: PTYService;
  private terminalWindowManager?: TerminalWindowManager;
  private readonly sessions = new Map<string, AgentSession>();
  private projectDirectoryPicker?: (event: IpcMainInvokeEvent) => Promise<string | null>;

  private readonly sessionSubscriptions = new Map<
    string,
    { chat: () => void; metadata: () => void }
  >();
  private mainWindow: BrowserWindow | null = null;

  private registered = false;

  constructor(config: Config) {
    this.config = config;
    this.historyService = new HistoryService(config);
    this.partialService = new PartialService(config, this.historyService);
    this.initStateManager = new InitStateManager(config);
    this.extensionMetadata = new ExtensionMetadataService(
      path.join(config.rootDir, "extensionMetadata.json")
    );
    this.aiService = new AIService(
      config,
      this.historyService,
      this.partialService,
      this.initStateManager
    );
    // Terminal services - PTYService is cross-platform
    this.ptyService = new PTYService();

    // Listen to AIService events to update metadata
    this.setupMetadataListeners();
  }

  /**
   * Initialize the service. Call this after construction.
   * This is separate from the constructor to support async initialization.
   */
  async initialize(): Promise<void> {
    await this.extensionMetadata.initialize();
  }

  /**
   * Configure a picker used to select project directories (desktop mode only).
   * Server mode does not provide a native directory picker.
   */
  setProjectDirectoryPicker(picker: (event: IpcMainInvokeEvent) => Promise<string | null>): void {
    this.projectDirectoryPicker = picker;
  }

  /**
   * Set the terminal window manager (desktop mode only).
   * Server mode doesn't use pop-out terminal windows.
   */
  setTerminalWindowManager(manager: TerminalWindowManager): void {
    this.terminalWindowManager = manager;
  }

  /**
   * Setup listeners to update metadata store based on AIService events.
   * This tracks workspace recency and streaming status for VS Code extension integration.
   */
  private setupMetadataListeners(): void {
    const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
    const isWorkspaceEvent = (v: unknown): v is { workspaceId: string } =>
      isObj(v) && "workspaceId" in v && typeof v.workspaceId === "string";
    const isStreamStartEvent = (v: unknown): v is { workspaceId: string; model: string } =>
      isWorkspaceEvent(v) && "model" in v && typeof v.model === "string";
    const isStreamEndEvent = (v: unknown): v is StreamEndEvent =>
      isWorkspaceEvent(v) &&
      (!("metadata" in (v as Record<string, unknown>)) || isObj((v as StreamEndEvent).metadata));
    const isStreamAbortEvent = (v: unknown): v is StreamAbortEvent => isWorkspaceEvent(v);
    const extractTimestamp = (event: StreamEndEvent | { metadata?: { timestamp?: number } }) => {
      const raw = event.metadata?.timestamp;
      return typeof raw === "number" && Number.isFinite(raw) ? raw : Date.now();
    };

    // Update streaming status and recency on stream start
    this.aiService.on("stream-start", (data: unknown) => {
      if (isStreamStartEvent(data)) {
        void this.updateStreamingStatus(data.workspaceId, true, data.model);
      }
    });

    this.aiService.on("stream-end", (data: unknown) => {
      if (isStreamEndEvent(data)) {
        void this.handleStreamCompletion(data.workspaceId, extractTimestamp(data));
      }
    });

    this.aiService.on("stream-abort", (data: unknown) => {
      if (isStreamAbortEvent(data)) {
        void this.updateStreamingStatus(data.workspaceId, false);
      }
    });
  }

  private emitWorkspaceActivity(
    workspaceId: string,
    snapshot: WorkspaceActivitySnapshot | null
  ): void {
    if (!this.mainWindow) {
      return;
    }
    this.mainWindow.webContents.send(IPC_CHANNELS.WORKSPACE_ACTIVITY, {
      workspaceId,
      activity: snapshot,
    });
  }

  private async updateRecencyTimestamp(workspaceId: string, timestamp?: number): Promise<void> {
    try {
      const snapshot = await this.extensionMetadata.updateRecency(
        workspaceId,
        timestamp ?? Date.now()
      );
      this.emitWorkspaceActivity(workspaceId, snapshot);
    } catch (error) {
      log.error("Failed to update workspace recency", { workspaceId, error });
    }
  }

  private async updateStreamingStatus(
    workspaceId: string,
    streaming: boolean,
    model?: string
  ): Promise<void> {
    try {
      const snapshot = await this.extensionMetadata.setStreaming(workspaceId, streaming, model);
      this.emitWorkspaceActivity(workspaceId, snapshot);
    } catch (error) {
      log.error("Failed to update workspace streaming status", { workspaceId, error });
    }
  }

  private async handleStreamCompletion(workspaceId: string, timestamp: number): Promise<void> {
    await this.updateRecencyTimestamp(workspaceId, timestamp);
    await this.updateStreamingStatus(workspaceId, false);
  }

  /**
   * Create InitLogger that bridges to InitStateManager
   * Extracted helper to avoid duplication across workspace creation paths
   */
  private createInitLogger(workspaceId: string) {
    return {
      logStep: (message: string) => {
        this.initStateManager.appendOutput(workspaceId, message, false);
      },
      logStdout: (line: string) => {
        this.initStateManager.appendOutput(workspaceId, line, false);
      },
      logStderr: (line: string) => {
        this.initStateManager.appendOutput(workspaceId, line, true);
      },
      logComplete: (exitCode: number) => {
        void this.initStateManager.endInit(workspaceId, exitCode);
      },
    };
  }

  /**
   * Create a new workspace with AI-generated title and branch name
   * Extracted from sendMessage handler to reduce complexity
   */
  private async createWorkspaceForFirstMessage(
    message: string,
    projectPath: string,
    options: SendMessageOptions & {
      imageParts?: Array<{ url: string; mediaType: string }>;
      runtimeConfig?: RuntimeConfig;
      trunkBranch?: string;
    }
  ): Promise<
    | { success: true; workspaceId: string; metadata: FrontendWorkspaceMetadata }
    | { success: false; error: string }
  > {
    try {
      // 1. Generate workspace branch name using AI (use same model as message)
      const branchName = await generateWorkspaceName(message, options.model, this.config);

      log.debug("Generated workspace name", { branchName });

      // 2. Get trunk branch (use provided trunkBranch or auto-detect)
      const branches = await listLocalBranches(projectPath);
      const recommendedTrunk =
        options.trunkBranch ?? (await detectDefaultTrunkBranch(projectPath, branches)) ?? "main";

      // 3. Create workspace
      const finalRuntimeConfig: RuntimeConfig = options.runtimeConfig ?? {
        type: "local",
        srcBaseDir: this.config.srcDir,
      };

      const workspaceId = this.config.generateStableId();

      let runtime;
      let resolvedSrcBaseDir: string;
      try {
        runtime = createRuntime(finalRuntimeConfig);
        resolvedSrcBaseDir = await runtime.resolvePath(finalRuntimeConfig.srcBaseDir);

        if (resolvedSrcBaseDir !== finalRuntimeConfig.srcBaseDir) {
          const resolvedRuntimeConfig: RuntimeConfig = {
            ...finalRuntimeConfig,
            srcBaseDir: resolvedSrcBaseDir,
          };
          runtime = createRuntime(resolvedRuntimeConfig);
          finalRuntimeConfig.srcBaseDir = resolvedSrcBaseDir;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { success: false, error: errorMsg };
      }

      const session = this.getOrCreateSession(workspaceId);
      this.initStateManager.startInit(workspaceId, projectPath);

      const initLogger = this.createInitLogger(workspaceId);

      const createResult = await runtime.createWorkspace({
        projectPath,
        branchName,
        trunkBranch: recommendedTrunk,
        directoryName: branchName,
        initLogger,
      });

      if (!createResult.success || !createResult.workspacePath) {
        return { success: false, error: createResult.error ?? "Failed to create workspace" };
      }

      const projectName =
        projectPath.split("/").pop() ?? projectPath.split("\\").pop() ?? "unknown";

      const metadata = {
        id: workspaceId,
        name: branchName,
        projectName,
        projectPath,
        createdAt: new Date().toISOString(),
      };

      await this.config.editConfig((config) => {
        let projectConfig = config.projects.get(projectPath);
        if (!projectConfig) {
          projectConfig = { workspaces: [] };
          config.projects.set(projectPath, projectConfig);
        }
        projectConfig.workspaces.push({
          path: createResult.workspacePath!,
          id: workspaceId,
          name: branchName,
          createdAt: metadata.createdAt,
          runtimeConfig: finalRuntimeConfig,
        });
        return config;
      });

      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const completeMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (!completeMetadata) {
        return { success: false, error: "Failed to retrieve workspace metadata" };
      }

      session.emitMetadata(completeMetadata);

      void runtime
        .initWorkspace({
          projectPath,
          branchName,
          trunkBranch: recommendedTrunk,
          workspacePath: createResult.workspacePath,
          initLogger,
        })
        .catch((error: unknown) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`initWorkspace failed for ${workspaceId}:`, error);
          initLogger.logStderr(`Initialization failed: ${errorMsg}`);
          initLogger.logComplete(-1);
        });

      // Send message to new workspace
      void session.sendMessage(message, options);

      return {
        success: true,
        workspaceId,
        metadata: completeMetadata,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in createWorkspaceForFirstMessage:", error);
      return { success: false, error: `Failed to create workspace: ${errorMessage}` };
    }
  }

  private getOrCreateSession(workspaceId: string): AgentSession {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    let session = this.sessions.get(trimmed);
    if (session) {
      return session;
    }

    session = new AgentSession({
      workspaceId: trimmed,
      config: this.config,
      historyService: this.historyService,
      partialService: this.partialService,
      aiService: this.aiService,
      initStateManager: this.initStateManager,
    });

    const chatUnsubscribe = session.onChatEvent((event) => {
      if (!this.mainWindow) {
        return;
      }
      const channel = getChatChannel(event.workspaceId);
      this.mainWindow.webContents.send(channel, event.message);
    });

    const metadataUnsubscribe = session.onMetadataEvent((event) => {
      if (!this.mainWindow) {
        return;
      }
      this.mainWindow.webContents.send(IPC_CHANNELS.WORKSPACE_METADATA, {
        workspaceId: event.workspaceId,
        metadata: event.metadata,
      });
    });

    this.sessions.set(trimmed, session);
    this.sessionSubscriptions.set(trimmed, {
      chat: chatUnsubscribe,
      metadata: metadataUnsubscribe,
    });

    return session;
  }

  private disposeSession(workspaceId: string): void {
    const session = this.sessions.get(workspaceId);
    if (!session) {
      return;
    }

    const subscriptions = this.sessionSubscriptions.get(workspaceId);
    if (subscriptions) {
      subscriptions.chat();
      subscriptions.metadata();
      this.sessionSubscriptions.delete(workspaceId);
    }

    session.dispose();
    this.sessions.delete(workspaceId);
  }

  /**
   * Register all IPC handlers and setup event forwarding
   * @param ipcMain - Electron's ipcMain module
   * @param mainWindow - The main BrowserWindow for sending events
   */
  private registerFsHandlers(ipcMain: ElectronIpcMain): void {
    ipcMain.handle(IPC_CHANNELS.FS_LIST_DIRECTORY, async (_event, root: string) => {
      try {
        const normalizedRoot = path.resolve(root || ".");
        const entries = await fsPromises.readdir(normalizedRoot, { withFileTypes: true });

        const children = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const entryPath = path.join(normalizedRoot, entry.name);
            return {
              name: entry.name,
              path: entryPath,
              isDirectory: true,
              children: [],
            };
          });

        return {
          name: normalizedRoot,
          path: normalizedRoot,
          isDirectory: true,
          children,
        };
      } catch (error) {
        log.error("FS_LIST_DIRECTORY failed:", error);
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  register(ipcMain: ElectronIpcMain, mainWindow: BrowserWindow): void {
    // Always update the window reference (windows can be recreated on macOS)
    this.mainWindow = mainWindow;

    // Skip registration if handlers are already registered
    // This prevents "handler already registered" errors when windows are recreated
    if (this.registered) {
      return;
    }

    // Terminal server starts lazily when first terminal is opened
    this.registerWindowHandlers(ipcMain);
    this.registerTokenizerHandlers(ipcMain);
    this.registerWorkspaceHandlers(ipcMain);
    this.registerProviderHandlers(ipcMain);
    this.registerFsHandlers(ipcMain);
    this.registerProjectHandlers(ipcMain);
    this.registerTerminalHandlers(ipcMain, mainWindow);
    this.registerSubscriptionHandlers(ipcMain);
    this.registered = true;
  }

  private registerWindowHandlers(ipcMain: ElectronIpcMain): void {
    ipcMain.handle(IPC_CHANNELS.WINDOW_SET_TITLE, (_event, title: string) => {
      if (!this.mainWindow) return;
      this.mainWindow.setTitle(title);
    });
  }

  private registerTokenizerHandlers(ipcMain: ElectronIpcMain): void {
    ipcMain.handle(
      IPC_CHANNELS.TOKENIZER_COUNT_TOKENS,
      async (_event, model: string, input: string) => {
        assert(
          typeof model === "string" && model.length > 0,
          "Tokenizer countTokens requires model name"
        );
        assert(typeof input === "string", "Tokenizer countTokens requires text");
        return countTokens(model, input);
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.TOKENIZER_COUNT_TOKENS_BATCH,
      async (_event, model: string, texts: unknown[]) => {
        assert(
          typeof model === "string" && model.length > 0,
          "Tokenizer countTokensBatch requires model name"
        );
        assert(Array.isArray(texts), "Tokenizer countTokensBatch requires an array of strings");
        return countTokensBatch(model, texts as string[]);
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.TOKENIZER_CALCULATE_STATS,
      async (_event, messages: MuxMessage[], model: string) => {
        assert(Array.isArray(messages), "Tokenizer IPC requires an array of messages");
        assert(typeof model === "string" && model.length > 0, "Tokenizer IPC requires model name");

        try {
          return await calculateTokenStats(messages, model);
        } catch (error) {
          log.error("[IpcMain] Token stats calculation failed", error);
          throw error;
        }
      }
    );
  }

  private registerWorkspaceHandlers(ipcMain: ElectronIpcMain): void {
    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_CREATE,
      async (
        _event,
        projectPath: string,
        branchName: string,
        trunkBranch: string,
        runtimeConfig?: RuntimeConfig
      ) => {
        // Validate workspace name
        const validation = validateWorkspaceName(branchName);
        if (!validation.valid) {
          return { success: false, error: validation.error };
        }

        if (typeof trunkBranch !== "string" || trunkBranch.trim().length === 0) {
          return { success: false, error: "Trunk branch is required" };
        }

        const normalizedTrunkBranch = trunkBranch.trim();

        // Generate stable workspace ID (stored in config, not used for directory name)
        const workspaceId = this.config.generateStableId();

        // Create runtime for workspace creation (defaults to local with srcDir as base)
        const finalRuntimeConfig: RuntimeConfig = runtimeConfig ?? {
          type: "local",
          srcBaseDir: this.config.srcDir,
        };

        // Create temporary runtime to resolve srcBaseDir path
        // This allows tilde paths to work for both local and SSH runtimes
        let runtime;
        let resolvedSrcBaseDir: string;
        try {
          runtime = createRuntime(finalRuntimeConfig);

          // Resolve srcBaseDir to absolute path (expanding tildes, etc.)
          resolvedSrcBaseDir = await runtime.resolvePath(finalRuntimeConfig.srcBaseDir);

          // If path was resolved to something different, recreate runtime with resolved path
          if (resolvedSrcBaseDir !== finalRuntimeConfig.srcBaseDir) {
            const resolvedRuntimeConfig: RuntimeConfig = {
              ...finalRuntimeConfig,
              srcBaseDir: resolvedSrcBaseDir,
            };
            runtime = createRuntime(resolvedRuntimeConfig);
            // Update finalRuntimeConfig to store resolved path in config
            finalRuntimeConfig.srcBaseDir = resolvedSrcBaseDir;
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          return { success: false, error: errorMsg };
        }

        // Create session BEFORE starting init so events can be forwarded
        const session = this.getOrCreateSession(workspaceId);

        // Start init tracking (creates in-memory state + emits init-start event)
        // This MUST complete before workspace creation returns so replayInit() finds state
        this.initStateManager.startInit(workspaceId, projectPath);

        const initLogger = this.createInitLogger(workspaceId);

        // Phase 1: Create workspace structure (FAST - returns immediately)
        const createResult = await runtime.createWorkspace({
          projectPath,
          branchName,
          trunkBranch: normalizedTrunkBranch,
          directoryName: branchName, // Use branch name as directory name
          initLogger,
        });

        if (!createResult.success || !createResult.workspacePath) {
          return { success: false, error: createResult.error ?? "Failed to create workspace" };
        }

        const projectName =
          projectPath.split("/").pop() ?? projectPath.split("\\").pop() ?? "unknown";

        // Initialize workspace metadata with stable ID and name
        const metadata = {
          id: workspaceId,
          name: branchName, // Name is separate from ID
          projectName,
          projectPath, // Full project path for computing worktree path
          createdAt: new Date().toISOString(),
        };
        // Note: metadata.json no longer written - config is the only source of truth

        // Update config to include the new workspace (with full metadata)
        await this.config.editConfig((config) => {
          let projectConfig = config.projects.get(projectPath);
          if (!projectConfig) {
            // Create project config if it doesn't exist
            projectConfig = {
              workspaces: [],
            };
            config.projects.set(projectPath, projectConfig);
          }
          // Add workspace to project config with full metadata
          projectConfig.workspaces.push({
            path: createResult.workspacePath!,
            id: workspaceId,
            name: branchName,
            createdAt: metadata.createdAt,
            runtimeConfig: finalRuntimeConfig, // Save runtime config for exec operations
          });
          return config;
        });

        // No longer creating symlinks - directory name IS the workspace name

        // Get complete metadata from config (includes paths)
        const allMetadata = await this.config.getAllWorkspaceMetadata();
        const completeMetadata = allMetadata.find((m) => m.id === workspaceId);
        if (!completeMetadata) {
          return { success: false, error: "Failed to retrieve workspace metadata" };
        }

        // Emit metadata event for new workspace (session already created above)
        session.emitMetadata(completeMetadata);

        // Phase 2: Initialize workspace asynchronously (SLOW - runs in background)
        // This streams progress via initLogger and doesn't block the IPC return
        void runtime
          .initWorkspace({
            projectPath,
            branchName,
            trunkBranch: normalizedTrunkBranch,
            workspacePath: createResult.workspacePath,
            initLogger,
          })
          .catch((error: unknown) => {
            const errorMsg = error instanceof Error ? error.message : String(error);
            log.error(`initWorkspace failed for ${workspaceId}:`, error);
            initLogger.logStderr(`Initialization failed: ${errorMsg}`);
            initLogger.logComplete(-1);
          });

        // Return immediately - init streams separately via initLogger events
        return {
          success: true,
          metadata: completeMetadata,
        };
      }
    );

    // Provide chat history and replay helpers for server mode
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_CHAT_GET_HISTORY, async (_event, workspaceId: string) => {
      return await this.getWorkspaceChatHistory(workspaceId);
    });
    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_CHAT_GET_FULL_REPLAY,
      async (_event, workspaceId: string) => {
        return await this.getFullReplayEvents(workspaceId);
      }
    );
    ipcMain.handle(IPC_CHANNELS.WORKSPACE_ACTIVITY_LIST, async () => {
      const snapshots = await this.extensionMetadata.getAllSnapshots();
      return Object.fromEntries(snapshots.entries());
    });

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_REMOVE,
      async (_event, workspaceId: string, options?: { force?: boolean }) => {
        return this.removeWorkspaceInternal(workspaceId, { force: options?.force ?? false });
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_RENAME,
      async (_event, workspaceId: string, newName: string) => {
        try {
          // Block rename during active streaming to prevent race conditions
          // (bash processes would have stale cwd, system message would be wrong)
          if (this.aiService.isStreaming(workspaceId)) {
            return Err(
              "Cannot rename workspace while AI stream is active. Please wait for the stream to complete."
            );
          }

          // Validate workspace name
          const validation = validateWorkspaceName(newName);
          if (!validation.valid) {
            return Err(validation.error ?? "Invalid workspace name");
          }

          // Get current metadata
          const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
          if (!metadataResult.success) {
            return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
          }
          const oldMetadata = metadataResult.data;
          const oldName = oldMetadata.name;

          // If renaming to itself, just return success (no-op)
          if (newName === oldName) {
            return Ok({ newWorkspaceId: workspaceId });
          }

          // Check if new name collides with existing workspace name or ID
          const allWorkspaces = await this.config.getAllWorkspaceMetadata();
          const collision = allWorkspaces.find(
            (ws) => (ws.name === newName || ws.id === newName) && ws.id !== workspaceId
          );
          if (collision) {
            return Err(`Workspace with name "${newName}" already exists`);
          }

          // Find project path from config
          const workspace = this.config.findWorkspace(workspaceId);
          if (!workspace) {
            return Err("Failed to find workspace in config");
          }
          const { projectPath } = workspace;

          // Create runtime instance for this workspace
          // For local runtimes, workdir should be srcDir, not the individual workspace path
          const runtime = createRuntime(
            oldMetadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir }
          );

          // Delegate rename to runtime (handles both local and SSH)
          // Runtime computes workspace paths internally from workdir + projectPath + workspace names
          const renameResult = await runtime.renameWorkspace(projectPath, oldName, newName);

          if (!renameResult.success) {
            return Err(renameResult.error);
          }

          const { oldPath, newPath } = renameResult;

          // Update config with new name and path
          await this.config.editConfig((config) => {
            const projectConfig = config.projects.get(projectPath);
            if (projectConfig) {
              const workspaceEntry = projectConfig.workspaces.find((w) => w.path === oldPath);
              if (workspaceEntry) {
                workspaceEntry.name = newName;
                workspaceEntry.path = newPath; // Update path to reflect new directory name

                // Note: We don't need to update runtimeConfig.srcBaseDir on rename
                // because srcBaseDir is the base directory, not the individual workspace path
                // The workspace path is computed dynamically via runtime.getWorkspacePath()
              }
            }
            return config;
          });

          // Get updated metadata from config (includes updated name and paths)
          const allMetadata = await this.config.getAllWorkspaceMetadata();
          const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
          if (!updatedMetadata) {
            return Err("Failed to retrieve updated workspace metadata");
          }

          // Emit metadata event with updated metadata (same workspace ID)
          const session = this.sessions.get(workspaceId);
          if (session) {
            session.emitMetadata(updatedMetadata);
          } else if (this.mainWindow) {
            this.mainWindow.webContents.send(IPC_CHANNELS.WORKSPACE_METADATA, {
              workspaceId,
              metadata: updatedMetadata,
            });
          }

          return Ok({ newWorkspaceId: workspaceId });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Err(`Failed to rename workspace: ${message}`);
        }
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_FORK,
      async (_event, sourceWorkspaceId: string, newName: string) => {
        try {
          // Validate new workspace name
          const validation = validateWorkspaceName(newName);
          if (!validation.valid) {
            return { success: false, error: validation.error };
          }

          // If streaming, commit the partial response to history first
          // This preserves the streamed content in both workspaces
          if (this.aiService.isStreaming(sourceWorkspaceId)) {
            await this.partialService.commitToHistory(sourceWorkspaceId);
          }

          // Get source workspace metadata
          const sourceMetadataResult = await this.aiService.getWorkspaceMetadata(sourceWorkspaceId);
          if (!sourceMetadataResult.success) {
            return {
              success: false,
              error: `Failed to get source workspace metadata: ${sourceMetadataResult.error}`,
            };
          }
          const sourceMetadata = sourceMetadataResult.data;
          const foundProjectPath = sourceMetadata.projectPath;
          const projectName = sourceMetadata.projectName;

          // Create runtime for source workspace
          const sourceRuntimeConfig = sourceMetadata.runtimeConfig ?? {
            type: "local",
            srcBaseDir: this.config.srcDir,
          };
          const runtime = createRuntime(sourceRuntimeConfig);

          // Generate stable workspace ID for the new workspace
          const newWorkspaceId = this.config.generateStableId();

          // Create session BEFORE forking so init events can be forwarded
          const session = this.getOrCreateSession(newWorkspaceId);

          // Start init tracking
          this.initStateManager.startInit(newWorkspaceId, foundProjectPath);

          const initLogger = this.createInitLogger(newWorkspaceId);

          // Delegate fork operation to runtime
          const forkResult = await runtime.forkWorkspace({
            projectPath: foundProjectPath,
            sourceWorkspaceName: sourceMetadata.name,
            newWorkspaceName: newName,
            initLogger,
          });

          if (!forkResult.success) {
            return { success: false, error: forkResult.error };
          }

          // Copy session files (chat.jsonl, partial.json) - local backend operation
          const sourceSessionDir = this.config.getSessionDir(sourceWorkspaceId);
          const newSessionDir = this.config.getSessionDir(newWorkspaceId);

          try {
            await fsPromises.mkdir(newSessionDir, { recursive: true });

            // Copy chat.jsonl if it exists
            const sourceChatPath = path.join(sourceSessionDir, "chat.jsonl");
            const newChatPath = path.join(newSessionDir, "chat.jsonl");
            try {
              await fsPromises.copyFile(sourceChatPath, newChatPath);
            } catch (error) {
              if (
                !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
              ) {
                throw error;
              }
            }

            // Copy partial.json if it exists
            const sourcePartialPath = path.join(sourceSessionDir, "partial.json");
            const newPartialPath = path.join(newSessionDir, "partial.json");
            try {
              await fsPromises.copyFile(sourcePartialPath, newPartialPath);
            } catch (error) {
              if (
                !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
              ) {
                throw error;
              }
            }
          } catch (copyError) {
            // If copy fails, clean up everything we created
            await runtime.deleteWorkspace(foundProjectPath, newName, true);
            try {
              await fsPromises.rm(newSessionDir, { recursive: true, force: true });
            } catch (cleanupError) {
              log.error(`Failed to clean up session dir ${newSessionDir}:`, cleanupError);
            }
            const message = copyError instanceof Error ? copyError.message : String(copyError);
            return { success: false, error: `Failed to copy chat history: ${message}` };
          }

          // Initialize workspace metadata
          const metadata: WorkspaceMetadata = {
            id: newWorkspaceId,
            name: newName,
            projectName,
            projectPath: foundProjectPath,
            createdAt: new Date().toISOString(),
            runtimeConfig: DEFAULT_RUNTIME_CONFIG,
          };

          // Write metadata to config.json
          await this.config.addWorkspace(foundProjectPath, metadata);

          // Emit metadata event
          session.emitMetadata(metadata);

          return {
            success: true,
            metadata,
            projectPath: foundProjectPath,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false, error: `Failed to fork workspace: ${message}` };
        }
      }
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
      try {
        // getAllWorkspaceMetadata now returns complete metadata with paths
        return await this.config.getAllWorkspaceMetadata();
      } catch (error) {
        console.error("Failed to list workspaces:", error);
        return [];
      }
    });

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_INFO, async (_event, workspaceId: string) => {
      // Get complete metadata from config (includes paths)
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const metadata = allMetadata.find((m) => m.id === workspaceId);

      // Regenerate title/branch if missing (robust to errors/restarts)
      if (metadata && !metadata.name) {
        log.info(`Workspace ${workspaceId} missing title or branch name, regenerating...`);
        try {
          const historyResult = await this.historyService.getHistory(workspaceId);
          if (!historyResult.success) {
            log.error(`Failed to load history for workspace ${workspaceId}:`, historyResult.error);
            return metadata;
          }

          const firstUserMessage = historyResult.data.find((m: MuxMessage) => m.role === "user");

          if (firstUserMessage) {
            // Extract text content from message parts
            const textParts = firstUserMessage.parts.filter((p) => p.type === "text");
            const messageText = textParts.map((p) => p.text).join(" ");

            if (messageText.trim()) {
              const branchName = await generateWorkspaceName(
                messageText,
                "anthropic:claude-sonnet-4-5", // Use reasonable default model
                this.config
              );

              // Update config with regenerated name
              await this.config.updateWorkspaceMetadata(workspaceId, {
                name: branchName,
              });

              // Return updated metadata
              metadata.name = branchName;
              log.info(`Regenerated workspace name: ${branchName}`);
            }
          }
        } catch (error) {
          log.error(`Failed to regenerate workspace names for ${workspaceId}:`, error);
        }
      }

      return metadata ?? null;
    });

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_SEND_MESSAGE,
      async (
        _event,
        workspaceId: string | null,
        message: string,
        options?: SendMessageOptions & {
          imageParts?: ImagePart[];
          runtimeConfig?: RuntimeConfig;
          projectPath?: string;
          trunkBranch?: string;
        }
      ) => {
        // If workspaceId is null, create a new workspace first (lazy creation)
        if (workspaceId === null) {
          if (!options?.projectPath) {
            return { success: false, error: "projectPath is required when workspaceId is null" };
          }

          log.debug("sendMessage handler: Creating workspace for first message", {
            projectPath: options.projectPath,
            messagePreview: message.substring(0, 50),
          });

          return await this.createWorkspaceForFirstMessage(message, options.projectPath, options);
        }

        // Normal path: workspace already exists
        log.debug("sendMessage handler: Received", {
          workspaceId,
          messagePreview: message.substring(0, 50),
          mode: options?.mode,
          options,
        });
        try {
          const session = this.getOrCreateSession(workspaceId);

          // Update recency on user message (fire and forget)
          void this.updateRecencyTimestamp(workspaceId);

          // Queue new messages during streaming, but allow edits through
          if (this.aiService.isStreaming(workspaceId) && !options?.editMessageId) {
            session.queueMessage(message, options);
            return Ok(undefined);
          }

          const result = await session.sendMessage(message, options);
          if (!result.success) {
            log.error("sendMessage handler: session returned error", {
              workspaceId,
              error: result.error,
            });
          }
          return result;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : JSON.stringify(error, null, 2);
          log.error("Unexpected error in sendMessage handler:", error);
          const sendError: SendMessageError = {
            type: "unknown",
            raw: `Failed to send message: ${errorMessage}`,
          };
          return { success: false, error: sendError };
        }
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_RESUME_STREAM,
      async (_event, workspaceId: string, options: SendMessageOptions) => {
        log.debug("resumeStream handler: Received", {
          workspaceId,
          options,
        });
        try {
          const session = this.getOrCreateSession(workspaceId);
          const result = await session.resumeStream(options);
          if (!result.success) {
            log.error("resumeStream handler: session returned error", {
              workspaceId,
              error: result.error,
            });
          }
          return result;
        } catch (error) {
          // Convert to SendMessageError for typed error handling
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error("Unexpected error in resumeStream handler:", error);
          const sendError: SendMessageError = {
            type: "unknown",
            raw: `Failed to resume stream: ${errorMessage}`,
          };
          return { success: false, error: sendError };
        }
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_INTERRUPT_STREAM,
      async (_event, workspaceId: string, options?: { abandonPartial?: boolean }) => {
        log.debug("interruptStream handler: Received", { workspaceId, options });
        try {
          const session = this.getOrCreateSession(workspaceId);
          const stopResult = await session.interruptStream();
          if (!stopResult.success) {
            log.error("Failed to stop stream:", stopResult.error);
            return { success: false, error: stopResult.error };
          }

          // If abandonPartial is true, delete the partial instead of committing it
          if (options?.abandonPartial) {
            log.debug("Abandoning partial for workspace:", workspaceId);
            await this.partialService.deletePartial(workspaceId);
          }

          return { success: true, data: undefined };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error("Unexpected error in interruptStream handler:", error);
          return { success: false, error: `Failed to interrupt stream: ${errorMessage}` };
        }
      }
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_QUEUE_CLEAR, (_event, workspaceId: string) => {
      try {
        const session = this.getOrCreateSession(workspaceId);
        session.clearQueue();
        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log.error("Unexpected error in clearQueue handler:", error);
        return { success: false, error: `Failed to clear queue: ${errorMessage}` };
      }
    });

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_TRUNCATE_HISTORY,
      async (_event, workspaceId: string, percentage?: number) => {
        // Block truncate if there's an active stream
        // User must press Esc first to stop stream and commit partial to history
        if (this.aiService.isStreaming(workspaceId)) {
          return {
            success: false,
            error:
              "Cannot truncate history while stream is active. Press Esc to stop the stream first.",
          };
        }

        // Truncate chat.jsonl (only operates on committed history)
        // Note: partial.json is NOT touched here - it has its own lifecycle
        // Interrupted messages are committed to history by stream-abort handler
        const truncateResult = await this.historyService.truncateHistory(
          workspaceId,
          percentage ?? 1.0
        );
        if (!truncateResult.success) {
          return { success: false, error: truncateResult.error };
        }

        // Send DeleteMessage event to frontend with deleted historySequence numbers
        const deletedSequences = truncateResult.data;
        if (deletedSequences.length > 0 && this.mainWindow) {
          const deleteMessage: DeleteMessage = {
            type: "delete",
            historySequences: deletedSequences,
          };
          this.mainWindow.webContents.send(getChatChannel(workspaceId), deleteMessage);
        }

        return { success: true, data: undefined };
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_REPLACE_HISTORY,
      async (_event, workspaceId: string, summaryMessage: MuxMessage) => {
        // Block replace if there's an active stream, UNLESS this is a compacted message
        // (which is called from stream-end handler before stream cleanup completes)
        const isCompaction = summaryMessage.metadata?.compacted === true;
        if (!isCompaction && this.aiService.isStreaming(workspaceId)) {
          return Err(
            "Cannot replace history while stream is active. Press Esc to stop the stream first."
          );
        }

        try {
          // Get all existing messages to collect their historySequence numbers
          const historyResult = await this.historyService.getHistory(workspaceId);
          const deletedSequences = historyResult.success
            ? historyResult.data
                .map((msg) => msg.metadata?.historySequence ?? -1)
                .filter((s) => s >= 0)
            : [];

          // Clear entire history
          const clearResult = await this.historyService.clearHistory(workspaceId);
          if (!clearResult.success) {
            return Err(`Failed to clear history: ${clearResult.error}`);
          }

          // Append the summary message to history (gets historySequence assigned by backend)
          // Frontend provides the message with all metadata (compacted, timestamp, etc.)
          const appendResult = await this.historyService.appendToHistory(
            workspaceId,
            summaryMessage
          );
          if (!appendResult.success) {
            return Err(`Failed to append summary: ${appendResult.error}`);
          }

          // Send delete event to frontend for all old messages
          if (deletedSequences.length > 0 && this.mainWindow) {
            const deleteMessage: DeleteMessage = {
              type: "delete",
              historySequences: deletedSequences,
            };
            this.mainWindow.webContents.send(getChatChannel(workspaceId), deleteMessage);
          }

          // Send the new summary message to frontend
          if (this.mainWindow) {
            this.mainWindow.webContents.send(getChatChannel(workspaceId), summaryMessage);
          }

          return Ok(undefined);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Err(`Failed to replace history: ${message}`);
        }
      }
    );

    ipcMain.handle(
      IPC_CHANNELS.WORKSPACE_EXECUTE_BASH,
      async (
        _event,
        workspaceId: string,
        script: string,
        options?: {
          timeout_secs?: number;
          niceness?: number;
        }
      ) => {
        try {
          // Get workspace metadata
          const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
          if (!metadataResult.success) {
            return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
          }

          const metadata = metadataResult.data;

          // Get actual workspace path from config (handles both legacy and new format)
          // Legacy workspaces: path stored in config doesn't match computed path
          // New workspaces: path can be computed, but config is still source of truth
          const workspace = this.config.findWorkspace(workspaceId);
          if (!workspace) {
            return Err(`Workspace ${workspaceId} not found in config`);
          }

          // Load project secrets
          const projectSecrets = this.config.getProjectSecrets(metadata.projectPath);

          // Create scoped temp directory for this IPC call
          using tempDir = new DisposableTempDir("mux-ipc-bash");

          // Create runtime and compute workspace path
          // Runtime owns the path computation logic
          const runtimeConfig = metadata.runtimeConfig ?? {
            type: "local" as const,
            srcBaseDir: this.config.srcDir,
          };
          const runtime = createRuntime(runtimeConfig);
          const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);

          // Create bash tool with workspace's cwd and secrets
          // All IPC bash calls are from UI (background operations) - use truncate to avoid temp file spam
          // No init wait needed - IPC calls are user-initiated, not AI tool use
          const bashTool = createBashTool({
            cwd: workspacePath, // Bash executes in the workspace directory
            runtime,
            secrets: secretsToRecord(projectSecrets),
            niceness: options?.niceness,
            runtimeTempDir: tempDir.path,
            overflow_policy: "truncate",
          });

          // Execute the script with provided options
          const result = (await bashTool.execute!(
            {
              script,
              timeout_secs: options?.timeout_secs ?? 120,
            },
            {
              toolCallId: `bash-${Date.now()}`,
              messages: [],
            }
          )) as BashToolResult;

          return Ok(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Err(`Failed to execute bash command: ${message}`);
        }
      }
    );

    ipcMain.handle(IPC_CHANNELS.WORKSPACE_OPEN_TERMINAL, async (_event, workspaceId: string) => {
      try {
        // Look up workspace metadata to get runtime config
        const allMetadata = await this.config.getAllWorkspaceMetadata();
        const workspace = allMetadata.find((w) => w.id === workspaceId);

        if (!workspace) {
          log.error(`Workspace not found: ${workspaceId}`);
          return;
        }

        const runtimeConfig = workspace.runtimeConfig;

        if (isSSHRuntime(runtimeConfig)) {
          // SSH workspace - spawn local terminal that SSHs into remote host
          await this.openTerminal({
            type: "ssh",
            sshConfig: runtimeConfig,
            remotePath: workspace.namedWorkspacePath,
          });
        } else {
          // Local workspace - spawn terminal with cwd set
          await this.openTerminal({ type: "local", workspacePath: workspace.namedWorkspacePath });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed to open terminal: ${message}`);
      }
    });

    // Debug IPC - only for testing
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_TRIGGER_STREAM_ERROR,
      (_event, workspaceId: string, errorMessage: string) => {
        try {
          // eslint-disable-next-line @typescript-eslint/dot-notation -- accessing private member for testing
          const triggered = this.aiService["streamManager"].debugTriggerStreamError(
            workspaceId,
            errorMessage
          );
          return { success: triggered };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error(`Failed to trigger stream error: ${message}`);
          return { success: false, error: message };
        }
      }
    );
  }

  /**
   * Internal workspace removal logic shared by both force and non-force deletion
   */
  private async removeWorkspaceInternal(
    workspaceId: string,
    options: { force: boolean }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get workspace metadata
      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        // If metadata doesn't exist, workspace is already gone - consider it success
        log.info(`Workspace ${workspaceId} metadata not found, considering removal successful`);
        return { success: true };
      }
      const metadata = metadataResult.data;

      // Get workspace from config to get projectPath
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        log.info(`Workspace ${workspaceId} metadata exists but not found in config`);
        return { success: true }; // Consider it already removed
      }
      const { projectPath, workspacePath } = workspace;

      // Create runtime instance for this workspace
      // For local runtimes, workdir should be srcDir, not the individual workspace path
      const runtime = createRuntime(
        metadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir }
      );

      // Delegate deletion to runtime - it handles all path computation, existence checks, and pruning
      const deleteResult = await runtime.deleteWorkspace(projectPath, metadata.name, options.force);

      if (!deleteResult.success) {
        // Real error (e.g., dirty workspace without force) - return it
        return { success: false, error: deleteResult.error };
      }

      // Remove the workspace from AI service
      const aiResult = await this.aiService.deleteWorkspace(workspaceId);
      if (!aiResult.success) {
        return { success: false, error: aiResult.error };
      }

      // Delete workspace metadata (fire and forget)
      void this.extensionMetadata.deleteWorkspace(workspaceId);

      // Update config to remove the workspace from all projects
      const projectsConfig = this.config.loadConfigOrDefault();
      let configUpdated = false;
      for (const [_projectPath, projectConfig] of projectsConfig.projects.entries()) {
        const initialCount = projectConfig.workspaces.length;
        projectConfig.workspaces = projectConfig.workspaces.filter((w) => w.path !== workspacePath);
        if (projectConfig.workspaces.length < initialCount) {
          configUpdated = true;
        }
      }
      if (configUpdated) {
        await this.config.saveConfig(projectsConfig);
      }

      // Emit metadata event for workspace removal (with null metadata to indicate deletion)
      const existingSession = this.sessions.get(workspaceId);
      if (existingSession) {
        existingSession.emitMetadata(null);
      } else if (this.mainWindow) {
        this.mainWindow.webContents.send(IPC_CHANNELS.WORKSPACE_METADATA, {
          workspaceId,
          metadata: null,
        });
      }

      this.disposeSession(workspaceId);

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to remove workspace: ${message}` };
    }
  }

  private registerProviderHandlers(ipcMain: ElectronIpcMain): void {
    ipcMain.handle(
      IPC_CHANNELS.PROVIDERS_SET_CONFIG,
      (_event, provider: string, keyPath: string[], value: string) => {
        try {
          // Load current providers config or create empty
          const providersConfig = this.config.loadProvidersConfig() ?? {};

          // Ensure provider exists
          if (!providersConfig[provider]) {
            providersConfig[provider] = {};
          }

          // Set nested property value
          let current = providersConfig[provider] as Record<string, unknown>;
          for (let i = 0; i < keyPath.length - 1; i++) {
            const key = keyPath[i];
            if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
              current[key] = {};
            }
            current = current[key] as Record<string, unknown>;
          }

          if (keyPath.length > 0) {
            current[keyPath[keyPath.length - 1]] = value;
          }

          // Save updated config
          this.config.saveProvidersConfig(providersConfig);

          return { success: true, data: undefined };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { success: false, error: `Failed to set provider config: ${message}` };
        }
      }
    );

    ipcMain.handle(IPC_CHANNELS.PROVIDERS_LIST, () => {
      try {
        // Return all supported providers from centralized registry
        // This automatically stays in sync as new providers are added
        return [...SUPPORTED_PROVIDERS];
      } catch (error) {
        log.error("Failed to list providers:", error);
        return [];
      }
    });
  }

  private registerProjectHandlers(ipcMain: ElectronIpcMain): void {
    ipcMain.handle(
      IPC_CHANNELS.PROJECT_PICK_DIRECTORY,
      async (event: IpcMainInvokeEvent | null) => {
        if (!event?.sender || !this.projectDirectoryPicker) {
          // In server mode (HttpIpcMainAdapter), there is no BrowserWindow / sender.
          // The browser uses the web-based directory picker instead.
          return null;
        }

        try {
          return await this.projectDirectoryPicker(event);
        } catch (error) {
          log.error("Failed to pick directory:", error);
          return null;
        }
      }
    );

    ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, projectPath: string) => {
      try {
        // Validate and expand path (handles tilde, checks existence and directory status)
        const validation = await validateProjectPath(projectPath);
        if (!validation.valid) {
          return Err(validation.error ?? "Invalid project path");
        }

        // Use the expanded/normalized path
        const normalizedPath = validation.expandedPath!;

        const config = this.config.loadConfigOrDefault();

        // Check if project already exists (using normalized path)
        if (config.projects.has(normalizedPath)) {
          return Err("Project already exists");
        }

        // Create new project config
        const projectConfig: ProjectConfig = {
          workspaces: [],
        };

        // Add to config with normalized path
        config.projects.set(normalizedPath, projectConfig);
        await this.config.saveConfig(config);

        // Return both the config and the normalized path so frontend can use it
        return Ok({ projectConfig, normalizedPath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to create project: ${message}`);
      }
    });

    ipcMain.handle(IPC_CHANNELS.PROJECT_REMOVE, async (_event, projectPath: string) => {
      try {
        const config = this.config.loadConfigOrDefault();
        const projectConfig = config.projects.get(projectPath);

        if (!projectConfig) {
          return Err("Project not found");
        }

        // Check if project has any workspaces
        if (projectConfig.workspaces.length > 0) {
          return Err(
            `Cannot remove project with active workspaces. Please remove all ${projectConfig.workspaces.length} workspace(s) first.`
          );
        }

        // Remove project from config
        config.projects.delete(projectPath);
        await this.config.saveConfig(config);

        // Also remove project secrets if any
        try {
          await this.config.updateProjectSecrets(projectPath, []);
        } catch (error) {
          log.error(`Failed to clean up secrets for project ${projectPath}:`, error);
          // Continue - don't fail the whole operation if secrets cleanup fails
        }

        return Ok(undefined);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Err(`Failed to remove project: ${message}`);
      }
    });

    ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, () => {
      try {
        const config = this.config.loadConfigOrDefault();
        // Return array of [projectPath, projectConfig] tuples
        return Array.from(config.projects.entries());
      } catch (error) {
        log.error("Failed to list projects:", error);
        return [];
      }
    });

    ipcMain.handle(IPC_CHANNELS.PROJECT_LIST_BRANCHES, async (_event, projectPath: string) => {
      if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
        throw new Error("Project path is required to list branches");
      }

      try {
        // Validate and expand path (handles tilde)
        const validation = await validateProjectPath(projectPath);
        if (!validation.valid) {
          throw new Error(validation.error ?? "Invalid project path");
        }

        const normalizedPath = validation.expandedPath!;
        const branches = await listLocalBranches(normalizedPath);
        const recommendedTrunk = await detectDefaultTrunkBranch(normalizedPath, branches);
        return { branches, recommendedTrunk };
      } catch (error) {
        log.error("Failed to list branches:", error);
        throw error instanceof Error ? error : new Error(String(error));
      }
    });

    ipcMain.handle(IPC_CHANNELS.PROJECT_SECRETS_GET, (_event, projectPath: string) => {
      try {
        return this.config.getProjectSecrets(projectPath);
      } catch (error) {
        log.error("Failed to get project secrets:", error);
        return [];
      }
    });

    ipcMain.handle(
      IPC_CHANNELS.PROJECT_SECRETS_UPDATE,
      async (_event, projectPath: string, secrets: Array<{ key: string; value: string }>) => {
        try {
          await this.config.updateProjectSecrets(projectPath, secrets);
          return Ok(undefined);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return Err(`Failed to update project secrets: ${message}`);
        }
      }
    );
  }

  private registerTerminalHandlers(ipcMain: ElectronIpcMain, mainWindow: BrowserWindow): void {
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, async (event, params: TerminalCreateParams) => {
      try {
        let senderWindow: Electron.BrowserWindow | null = null;
        // Get the window that requested this terminal
        // In Electron, use the actual sender window. In browser mode, event is null,
        // so we use the mainWindow (mockWindow) which broadcasts to all WebSocket clients
        if (event?.sender) {
          // We must dynamically import here because the browser distribution
          // does not include the electron module.
          // eslint-disable-next-line no-restricted-syntax
          const { BrowserWindow } = await import("electron");
          senderWindow = BrowserWindow.fromWebContents(event.sender);
        } else {
          senderWindow = mainWindow;
        }
        if (!senderWindow) {
          throw new Error("Could not find sender window for terminal creation");
        }

        // Get workspace metadata
        const allMetadata = await this.config.getAllWorkspaceMetadata();
        const workspaceMetadata = allMetadata.find((ws) => ws.id === params.workspaceId);

        if (!workspaceMetadata) {
          throw new Error(`Workspace ${params.workspaceId} not found`);
        }

        // Create runtime for this workspace (default to local if not specified)
        const runtime = createRuntime(
          workspaceMetadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir }
        );

        // Compute workspace path
        const workspacePath = runtime.getWorkspacePath(
          workspaceMetadata.projectPath,
          workspaceMetadata.name
        );

        // Create terminal session with callbacks that send IPC events
        // Note: callbacks capture sessionId from returned session object
        const capturedSessionId = { current: "" };
        const session = await this.ptyService.createSession(
          params,
          runtime,
          workspacePath,
          // onData callback - send output to the window that created the session
          (data: string) => {
            senderWindow.webContents.send(`terminal:output:${capturedSessionId.current}`, data);
          },
          // onExit callback - send exit event and clean up
          (exitCode: number) => {
            senderWindow.webContents.send(`terminal:exit:${capturedSessionId.current}`, exitCode);
          }
        );
        capturedSessionId.current = session.sessionId;

        return session;
      } catch (err) {
        log.error("Error creating terminal session:", err);
        throw err;
      }
    });

    // Handle terminal input (keyboard, etc.)
    // Use handle() for both Electron and browser mode
    ipcMain.handle(IPC_CHANNELS.TERMINAL_INPUT, (_event, sessionId: string, data: string) => {
      try {
        this.ptyService.sendInput(sessionId, data);
      } catch (err) {
        log.error(`Error sending input to terminal ${sessionId}:`, err);
        throw err;
      }
    });

    ipcMain.handle(IPC_CHANNELS.TERMINAL_CLOSE, (_event, sessionId: string) => {
      try {
        this.ptyService.closeSession(sessionId);
      } catch (err) {
        log.error("Error closing terminal session:", err);
        throw err;
      }
    });

    ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, (_event, params: TerminalResizeParams) => {
      try {
        this.ptyService.resize(params);
      } catch (err) {
        log.error("Error resizing terminal:", err);
        throw err;
      }
    });

    ipcMain.handle(IPC_CHANNELS.TERMINAL_WINDOW_OPEN, async (_event, workspaceId: string) => {
      console.log(`[BACKEND] TERMINAL_WINDOW_OPEN handler called with: ${workspaceId}`);
      try {
        // Look up workspace to determine runtime type
        const allMetadata = await this.config.getAllWorkspaceMetadata();
        const workspace = allMetadata.find((w) => w.id === workspaceId);

        if (!workspace) {
          log.error(`Workspace not found: ${workspaceId}`);
          throw new Error(`Workspace not found: ${workspaceId}`);
        }

        const runtimeConfig = workspace.runtimeConfig;
        const isSSH = isSSHRuntime(runtimeConfig);
        const isDesktop = !!this.terminalWindowManager;

        // Terminal routing logic:
        // - Desktop + Local: Native terminal
        // - Desktop + SSH: Web terminal (ghostty-web Electron window)
        // - Browser + Local: Web terminal (browser tab)
        // - Browser + SSH: Web terminal (browser tab)
        if (isDesktop && !isSSH) {
          // Desktop + Local: Native terminal
          log.info(`Opening native terminal for local workspace: ${workspaceId}`);
          await this.openTerminal({ type: "local", workspacePath: workspace.namedWorkspacePath });
        } else if (isDesktop && isSSH) {
          // Desktop + SSH: Web terminal (ghostty-web Electron window)
          log.info(`Opening ghostty-web terminal for SSH workspace: ${workspaceId}`);
          await this.terminalWindowManager!.openTerminalWindow(workspaceId);
        } else {
          // Browser mode (local or SSH): Web terminal (browser window)
          // Browser will handle opening the terminal window via window.open()
          log.info(
            `Browser mode: terminal UI handled by browser for ${isSSH ? "SSH" : "local"} workspace: ${workspaceId}`
          );
        }

        log.info(`Terminal opened successfully for workspace: ${workspaceId}`);
      } catch (err) {
        log.error("Error opening terminal window:", err);
        throw err;
      }
    });

    ipcMain.handle(IPC_CHANNELS.TERMINAL_WINDOW_CLOSE, (_event, workspaceId: string) => {
      try {
        if (!this.terminalWindowManager) {
          throw new Error("Terminal window manager not available (desktop mode only)");
        }
        this.terminalWindowManager.closeTerminalWindow(workspaceId);
      } catch (err) {
        log.error("Error closing terminal window:", err);
        throw err;
      }
    });
  }

  private registerSubscriptionHandlers(ipcMain: ElectronIpcMain): void {
    // Handle subscription events for chat history
    ipcMain.on(`workspace:chat:subscribe`, (_event, workspaceId: string) => {
      void (async () => {
        const session = this.getOrCreateSession(workspaceId);
        const chatChannel = getChatChannel(workspaceId);

        await session.replayHistory((event) => {
          if (!this.mainWindow) {
            return;
          }
          this.mainWindow.webContents.send(chatChannel, event.message);
        });
      })();
    });

    // Handle subscription events for metadata
    ipcMain.on(IPC_CHANNELS.WORKSPACE_METADATA_SUBSCRIBE, () => {
      void (async () => {
        try {
          const workspaceMetadata = await this.config.getAllWorkspaceMetadata();

          // Emit current metadata for each workspace
          for (const metadata of workspaceMetadata) {
            this.mainWindow?.webContents.send(IPC_CHANNELS.WORKSPACE_METADATA, {
              workspaceId: metadata.id,
              metadata,
            });
          }
        } catch (error) {
          console.error("Failed to emit current metadata:", error);
        }
      })();
    });

    ipcMain.on(IPC_CHANNELS.WORKSPACE_ACTIVITY_SUBSCRIBE, () => {
      void (async () => {
        try {
          const snapshots = await this.extensionMetadata.getAllSnapshots();
          for (const [workspaceId, activity] of snapshots.entries()) {
            this.mainWindow?.webContents.send(IPC_CHANNELS.WORKSPACE_ACTIVITY, {
              workspaceId,
              activity,
            });
          }
        } catch (error) {
          log.error("Failed to emit current workspace activity", error);
        }
      })();
    });

    ipcMain.on(IPC_CHANNELS.WORKSPACE_ACTIVITY_UNSUBSCRIBE, () => {
      // No-op; included for API completeness
    });
  }

  /**
   * Check if a command is available in the system PATH or known locations
   */
  private async isCommandAvailable(command: string): Promise<boolean> {
    // Special handling for ghostty on macOS - check common installation paths
    if (command === "ghostty" && process.platform === "darwin") {
      const ghosttyPaths = [
        "/opt/homebrew/bin/ghostty",
        "/Applications/Ghostty.app/Contents/MacOS/ghostty",
        "/usr/local/bin/ghostty",
      ];

      for (const ghosttyPath of ghosttyPaths) {
        try {
          const stats = await fsPromises.stat(ghosttyPath);
          // Check if it's a file and any executable bit is set (owner, group, or other)
          if (stats.isFile() && (stats.mode & 0o111) !== 0) {
            return true;
          }
        } catch {
          // Try next path
        }
      }
      // If none of the known paths work, fall through to which check
    }

    try {
      const result = spawnSync("which", [command], { encoding: "utf8" });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Open a terminal (local or SSH) with platform-specific handling
   */
  private async openTerminal(
    config:
      | { type: "local"; workspacePath: string }
      | {
          type: "ssh";
          sshConfig: Extract<RuntimeConfig, { type: "ssh" }>;
          remotePath: string;
        }
  ): Promise<void> {
    const isSSH = config.type === "ssh";

    // Build SSH args if needed
    let sshArgs: string[] | null = null;
    if (isSSH) {
      sshArgs = [];
      // Add port if specified
      if (config.sshConfig.port) {
        sshArgs.push("-p", String(config.sshConfig.port));
      }
      // Add identity file if specified
      if (config.sshConfig.identityFile) {
        sshArgs.push("-i", config.sshConfig.identityFile);
      }
      // Force pseudo-terminal allocation
      sshArgs.push("-t");
      // Add host
      sshArgs.push(config.sshConfig.host);
      // Add remote command to cd into directory and start shell
      // Use single quotes to prevent local shell expansion
      // exec $SHELL replaces the SSH process with the shell, avoiding nested processes
      sshArgs.push(`cd '${config.remotePath.replace(/'/g, "'\\''")}' && exec $SHELL`);
    }

    const logPrefix = isSSH ? "SSH terminal" : "terminal";

    if (process.platform === "darwin") {
      // macOS - try Ghostty first, fallback to Terminal.app
      const terminal = await this.findAvailableCommand(["ghostty", "terminal"]);
      if (terminal === "ghostty") {
        const cmd = "open";
        let args: string[];
        if (isSSH && sshArgs) {
          // Ghostty: Use --command flag to run SSH
          // Build the full SSH command as a single string
          const sshCommand = ["ssh", ...sshArgs].join(" ");
          args = ["-n", "-a", "Ghostty", "--args", `--command=${sshCommand}`];
        } else {
          // Ghostty: Pass workspacePath to 'open -a Ghostty' to avoid regressions
          if (config.type !== "local") throw new Error("Expected local config");
          args = ["-a", "Ghostty", config.workspacePath];
        }
        log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
        const child = spawn(cmd, args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } else {
        // Terminal.app
        const cmd = isSSH ? "osascript" : "open";
        let args: string[];
        if (isSSH && sshArgs) {
          // Terminal.app: Use osascript with proper AppleScript structure
          // Properly escape single quotes in args before wrapping in quotes
          const sshCommand = `ssh ${sshArgs
            .map((arg) => {
              if (arg.includes(" ") || arg.includes("'")) {
                // Escape single quotes by ending quote, adding escaped quote, starting quote again
                return `'${arg.replace(/'/g, "'\\''")}'`;
              }
              return arg;
            })
            .join(" ")}`;
          // Escape double quotes for AppleScript string
          const escapedCommand = sshCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const script = `tell application "Terminal"\nactivate\ndo script "${escapedCommand}"\nend tell`;
          args = ["-e", script];
        } else {
          // Terminal.app opens in the directory when passed as argument
          if (config.type !== "local") throw new Error("Expected local config");
          args = ["-a", "Terminal", config.workspacePath];
        }
        log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
        const child = spawn(cmd, args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      }
    } else if (process.platform === "win32") {
      // Windows
      const cmd = "cmd";
      let args: string[];
      if (isSSH && sshArgs) {
        // Windows - use cmd to start ssh
        args = ["/c", "start", "cmd", "/K", "ssh", ...sshArgs];
      } else {
        if (config.type !== "local") throw new Error("Expected local config");
        args = ["/c", "start", "cmd", "/K", "cd", "/D", config.workspacePath];
      }
      log.info(`Opening ${logPrefix}: ${cmd} ${args.join(" ")}`);
      const child = spawn(cmd, args, {
        detached: true,
        shell: true,
        stdio: "ignore",
      });
      child.unref();
    } else {
      // Linux - try terminal emulators in order of preference
      let terminals: Array<{ cmd: string; args: string[]; cwd?: string }>;

      if (isSSH && sshArgs) {
        // x-terminal-emulator is checked first as it respects user's system-wide preference
        terminals = [
          { cmd: "x-terminal-emulator", args: ["-e", "ssh", ...sshArgs] },
          { cmd: "ghostty", args: ["ssh", ...sshArgs] },
          { cmd: "alacritty", args: ["-e", "ssh", ...sshArgs] },
          { cmd: "kitty", args: ["ssh", ...sshArgs] },
          { cmd: "wezterm", args: ["start", "--", "ssh", ...sshArgs] },
          { cmd: "gnome-terminal", args: ["--", "ssh", ...sshArgs] },
          { cmd: "konsole", args: ["-e", "ssh", ...sshArgs] },
          { cmd: "xfce4-terminal", args: ["-e", `ssh ${sshArgs.join(" ")}`] },
          { cmd: "xterm", args: ["-e", "ssh", ...sshArgs] },
        ];
      } else {
        if (config.type !== "local") throw new Error("Expected local config");
        const workspacePath = config.workspacePath;
        terminals = [
          { cmd: "x-terminal-emulator", args: [], cwd: workspacePath },
          { cmd: "ghostty", args: ["--working-directory=" + workspacePath] },
          { cmd: "alacritty", args: ["--working-directory", workspacePath] },
          { cmd: "kitty", args: ["--directory", workspacePath] },
          { cmd: "wezterm", args: ["start", "--cwd", workspacePath] },
          { cmd: "gnome-terminal", args: ["--working-directory", workspacePath] },
          { cmd: "konsole", args: ["--workdir", workspacePath] },
          { cmd: "xfce4-terminal", args: ["--working-directory", workspacePath] },
          { cmd: "xterm", args: [], cwd: workspacePath },
        ];
      }

      const availableTerminal = await this.findAvailableTerminal(terminals);

      if (availableTerminal) {
        const cwdInfo = availableTerminal.cwd ? ` (cwd: ${availableTerminal.cwd})` : "";
        log.info(
          `Opening ${logPrefix}: ${availableTerminal.cmd} ${availableTerminal.args.join(" ")}${cwdInfo}`
        );
        const child = spawn(availableTerminal.cmd, availableTerminal.args, {
          cwd: availableTerminal.cwd,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } else {
        log.error("No terminal emulator found. Tried: " + terminals.map((t) => t.cmd).join(", "));
      }
    }
  }

  /**
   * Find the first available command from a list of commands
   */
  private async findAvailableCommand(commands: string[]): Promise<string | null> {
    for (const cmd of commands) {
      if (await this.isCommandAvailable(cmd)) {
        return cmd;
      }
    }
    return null;
  }

  /**
   * Find the first available terminal emulator from a list
   */
  private async findAvailableTerminal(
    terminals: Array<{ cmd: string; args: string[]; cwd?: string }>
  ): Promise<{ cmd: string; args: string[]; cwd?: string } | null> {
    for (const terminal of terminals) {
      if (await this.isCommandAvailable(terminal.cmd)) {
        return terminal;
      }
    }
    return null;
  }

  private async getWorkspaceChatHistory(workspaceId: string): Promise<WorkspaceChatMessage[]> {
    const historyResult = await this.historyService.getHistory(workspaceId);
    if (historyResult.success) {
      return historyResult.data;
    }
    return [];
  }

  private async getFullReplayEvents(workspaceId: string): Promise<WorkspaceChatMessage[]> {
    const session = this.getOrCreateSession(workspaceId);
    const events: WorkspaceChatMessage[] = [];
    await session.replayHistory(({ message }) => {
      events.push(message);
    });
    return events;
  }
}
