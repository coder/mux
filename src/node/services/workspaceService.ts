import { EventEmitter } from "events";
import * as path from "path";
import * as fsPromises from "fs/promises";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { log } from "@/node/services/log";
import { AgentSession } from "@/node/services/agentSession";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { AIService } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import { listLocalBranches, detectDefaultTrunkBranch } from "@/node/git";
import { createRuntime, IncompatibleRuntimeError } from "@/node/runtime/runtimeFactory";
import { generateWorkspaceName } from "./workspaceTitleGenerator";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";

import type {
  SendMessageOptions,
  DeleteMessage,
  ImagePart,
  WorkspaceChatMessage,
} from "@/common/orpc/types";
import type { SendMessageError } from "@/common/types/errors";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import type { MuxMessage } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { hasSrcBaseDir, getSrcBaseDir } from "@/common/types/runtime";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import type { TerminalService } from "@/node/services/terminalService";

import { DisposableTempDir } from "@/node/services/tempDir";
import { createBashTool } from "@/node/services/tools/bash";
import type { BashToolResult } from "@/common/types/tools";
import { secretsToRecord } from "@/common/types/secrets";

/** Maximum number of retry attempts when workspace name collides */
const MAX_WORKSPACE_NAME_COLLISION_RETRIES = 3;

/**
 * Checks if an error indicates a workspace name collision
 */
function isWorkspaceNameCollision(error: string | undefined): boolean {
  return error?.includes("Workspace already exists") ?? false;
}

/**
 * Generates a unique workspace name by appending a random suffix
 */
function appendCollisionSuffix(baseName: string): string {
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${baseName}-${suffix}`;
}

export interface WorkspaceServiceEvents {
  chat: (event: { workspaceId: string; message: WorkspaceChatMessage }) => void;
  metadata: (event: { workspaceId: string; metadata: FrontendWorkspaceMetadata | null }) => void;
  activity: (event: { workspaceId: string; activity: WorkspaceActivitySnapshot | null }) => void;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface WorkspaceService {
  on<U extends keyof WorkspaceServiceEvents>(event: U, listener: WorkspaceServiceEvents[U]): this;
  emit<U extends keyof WorkspaceServiceEvents>(
    event: U,
    ...args: Parameters<WorkspaceServiceEvents[U]>
  ): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class WorkspaceService extends EventEmitter {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly sessionSubscriptions = new Map<
    string,
    { chat: () => void; metadata: () => void }
  >();

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly partialService: PartialService,
    private readonly aiService: AIService,
    private readonly initStateManager: InitStateManager,
    private readonly extensionMetadata: ExtensionMetadataService
  ) {
    super();
    this.setupMetadataListeners();
  }

  // Optional terminal service for cleanup on workspace removal
  private terminalService?: TerminalService;

  /**
   * Set the terminal service for cleanup on workspace removal.
   * Called after construction due to circular dependency.
   */
  setTerminalService(terminalService: TerminalService): void {
    this.terminalService = terminalService;
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(workspaceId: string, errorMessage?: string): boolean {
    return this.aiService.debugTriggerStreamError(workspaceId, errorMessage);
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
    this.emit("activity", { workspaceId, activity: snapshot });
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

  public getOrCreateSession(workspaceId: string): AgentSession {
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
      this.emit("chat", { workspaceId: event.workspaceId, message: event.message });
    });

    const metadataUnsubscribe = session.onMetadataEvent((event) => {
      this.emit("metadata", {
        workspaceId: event.workspaceId,
        metadata: event.metadata!,
      });
    });

    this.sessions.set(trimmed, session);
    this.sessionSubscriptions.set(trimmed, {
      chat: chatUnsubscribe,
      metadata: metadataUnsubscribe,
    });

    return session;
  }

  public disposeSession(workspaceId: string): void {
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

  async create(
    projectPath: string,
    branchName: string,
    trunkBranch: string,
    runtimeConfig?: RuntimeConfig
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata }>> {
    // Validate workspace name
    const validation = validateWorkspaceName(branchName);
    if (!validation.valid) {
      return Err(validation.error ?? "Invalid workspace name");
    }

    if (typeof trunkBranch !== "string" || trunkBranch.trim().length === 0) {
      return Err("Trunk branch is required");
    }

    const normalizedTrunkBranch = trunkBranch.trim();

    // Generate stable workspace ID
    const workspaceId = this.config.generateStableId();

    // Create runtime for workspace creation
    // Default to worktree runtime for backward compatibility
    let finalRuntimeConfig: RuntimeConfig = runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: this.config.srcDir,
    };

    let runtime;
    try {
      runtime = createRuntime(finalRuntimeConfig, { projectPath });
      // Resolve srcBaseDir path if the config has one
      const srcBaseDir = getSrcBaseDir(finalRuntimeConfig);
      if (srcBaseDir) {
        const resolvedSrcBaseDir = await runtime.resolvePath(srcBaseDir);
        if (resolvedSrcBaseDir !== srcBaseDir && hasSrcBaseDir(finalRuntimeConfig)) {
          finalRuntimeConfig = {
            ...finalRuntimeConfig,
            srcBaseDir: resolvedSrcBaseDir,
          };
          runtime = createRuntime(finalRuntimeConfig, { projectPath });
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return Err(errorMsg);
    }

    const session = this.getOrCreateSession(workspaceId);
    this.initStateManager.startInit(workspaceId, projectPath);
    const initLogger = this.createInitLogger(workspaceId);

    try {
      // Create workspace with automatic collision retry
      let finalBranchName = branchName;
      let createResult: { success: boolean; workspacePath?: string; error?: string };

      for (let attempt = 0; attempt <= MAX_WORKSPACE_NAME_COLLISION_RETRIES; attempt++) {
        createResult = await runtime.createWorkspace({
          projectPath,
          branchName: finalBranchName,
          trunkBranch: normalizedTrunkBranch,
          directoryName: finalBranchName,
          initLogger,
        });

        if (createResult.success) break;

        // If collision and not last attempt, retry with suffix
        if (
          isWorkspaceNameCollision(createResult.error) &&
          attempt < MAX_WORKSPACE_NAME_COLLISION_RETRIES
        ) {
          log.debug(`Workspace name collision for "${finalBranchName}", retrying with suffix`);
          finalBranchName = appendCollisionSuffix(branchName);
          continue;
        }
        break;
      }

      if (!createResult!.success || !createResult!.workspacePath) {
        return Err(createResult!.error ?? "Failed to create workspace");
      }

      const projectName =
        projectPath.split("/").pop() ?? projectPath.split("\\").pop() ?? "unknown";

      const metadata = {
        id: workspaceId,
        name: finalBranchName,
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
          path: createResult!.workspacePath!,
          id: workspaceId,
          name: finalBranchName,
          createdAt: metadata.createdAt,
          runtimeConfig: finalRuntimeConfig,
        });
        return config;
      });

      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const completeMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (!completeMetadata) {
        return Err("Failed to retrieve workspace metadata");
      }

      session.emitMetadata(completeMetadata);

      void runtime
        .initWorkspace({
          projectPath,
          branchName: finalBranchName,
          trunkBranch: normalizedTrunkBranch,
          workspacePath: createResult!.workspacePath,
          initLogger,
        })
        .catch((error: unknown) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`initWorkspace failed for ${workspaceId}:`, error);
          initLogger.logStderr(`Initialization failed: ${errorMsg}`);
          initLogger.logComplete(-1);
        });

      return Ok({ metadata: completeMetadata });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to create workspace: ${message}`);
    }
  }

  async createForFirstMessage(
    message: string,
    projectPath: string,
    options: SendMessageOptions & {
      imageParts?: Array<{ url: string; mediaType: string }>;
      runtimeConfig?: RuntimeConfig;
      trunkBranch?: string;
    } = { model: "claude-3-5-sonnet-20241022" }
  ): Promise<
    | { success: true; workspaceId: string; metadata: FrontendWorkspaceMetadata }
    | { success: false; error: string }
  > {
    try {
      const branchNameResult = await generateWorkspaceName(message, options.model, this.aiService);
      if (!branchNameResult.success) {
        const err = branchNameResult.error;
        const errorMessage =
          "message" in err
            ? err.message
            : err.type === "api_key_not_found"
              ? `API key not found for ${err.provider}`
              : err.type === "provider_not_supported"
                ? `Provider not supported: ${err.provider}`
                : "raw" in err
                  ? err.raw
                  : "Unknown error";
        return { success: false, error: errorMessage };
      }
      const branchName = branchNameResult.data;
      log.debug("Generated workspace name", { branchName });

      const branches = await listLocalBranches(projectPath);
      const recommendedTrunk =
        options.trunkBranch ?? (await detectDefaultTrunkBranch(projectPath, branches)) ?? "main";

      // Default to worktree runtime for backward compatibility
      let finalRuntimeConfig: RuntimeConfig = options.runtimeConfig ?? {
        type: "worktree",
        srcBaseDir: this.config.srcDir,
      };

      const workspaceId = this.config.generateStableId();

      let runtime;
      try {
        runtime = createRuntime(finalRuntimeConfig, { projectPath });
        // Resolve srcBaseDir path if the config has one
        const srcBaseDir = getSrcBaseDir(finalRuntimeConfig);
        if (srcBaseDir) {
          const resolvedSrcBaseDir = await runtime.resolvePath(srcBaseDir);
          if (resolvedSrcBaseDir !== srcBaseDir && hasSrcBaseDir(finalRuntimeConfig)) {
            finalRuntimeConfig = {
              ...finalRuntimeConfig,
              srcBaseDir: resolvedSrcBaseDir,
            };
            runtime = createRuntime(finalRuntimeConfig, { projectPath });
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        return { success: false, error: errorMsg };
      }

      const session = this.getOrCreateSession(workspaceId);
      this.initStateManager.startInit(workspaceId, projectPath);
      const initLogger = this.createInitLogger(workspaceId);

      // Create workspace with automatic collision retry
      let finalBranchName = branchName;
      let createResult: { success: boolean; workspacePath?: string; error?: string };

      for (let attempt = 0; attempt <= MAX_WORKSPACE_NAME_COLLISION_RETRIES; attempt++) {
        createResult = await runtime.createWorkspace({
          projectPath,
          branchName: finalBranchName,
          trunkBranch: recommendedTrunk,
          directoryName: finalBranchName,
          initLogger,
        });

        if (createResult.success) break;

        // If collision and not last attempt, retry with suffix
        if (
          isWorkspaceNameCollision(createResult.error) &&
          attempt < MAX_WORKSPACE_NAME_COLLISION_RETRIES
        ) {
          log.debug(`Workspace name collision for "${finalBranchName}", retrying with suffix`);
          finalBranchName = appendCollisionSuffix(branchName);
          continue;
        }
        break;
      }

      if (!createResult!.success || !createResult!.workspacePath) {
        return { success: false, error: createResult!.error ?? "Failed to create workspace" };
      }

      const projectName =
        projectPath.split("/").pop() ?? projectPath.split("\\").pop() ?? "unknown";

      // Compute namedWorkspacePath
      const namedWorkspacePath = runtime.getWorkspacePath(projectPath, finalBranchName);

      const metadata: FrontendWorkspaceMetadata = {
        id: workspaceId,
        name: finalBranchName,
        projectName,
        projectPath,
        createdAt: new Date().toISOString(),
        namedWorkspacePath,
        runtimeConfig: finalRuntimeConfig,
      };

      await this.config.editConfig((config) => {
        let projectConfig = config.projects.get(projectPath);
        if (!projectConfig) {
          projectConfig = { workspaces: [] };
          config.projects.set(projectPath, projectConfig);
        }
        projectConfig.workspaces.push({
          path: createResult!.workspacePath!,
          id: workspaceId,
          name: finalBranchName,
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
          branchName: finalBranchName,
          trunkBranch: recommendedTrunk,
          workspacePath: createResult!.workspacePath,
          initLogger,
        })
        .catch((error: unknown) => {
          const errorMsg = error instanceof Error ? error.message : String(error);
          log.error(`initWorkspace failed for ${workspaceId}:`, error);
          initLogger.logStderr(`Initialization failed: ${errorMsg}`);
          initLogger.logComplete(-1);
        });

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

  async remove(workspaceId: string, force = false): Promise<Result<void>> {
    // Try to remove from runtime (filesystem)
    try {
      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (metadataResult.success) {
        const metadata = metadataResult.data;
        const projectPath = metadata.projectPath;

        const runtime = createRuntime(
          metadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
          { projectPath }
        );

        // Delete workspace from runtime
        const deleteResult = await runtime.deleteWorkspace(
          projectPath,
          metadata.name, // use branch name
          force
        );

        if (!deleteResult.success) {
          // If force is true, we continue to remove from config even if fs removal failed
          if (!force) {
            return Err(deleteResult.error ?? "Failed to delete workspace from disk");
          }
          log.error(
            `Failed to delete workspace from disk, but force=true. Removing from config. Error: ${deleteResult.error}`
          );
        }
      } else {
        log.error(`Could not find metadata for workspace ${workspaceId}, creating phantom cleanup`);
      }

      // Remove session data
      try {
        const sessionDir = this.config.getSessionDir(workspaceId);
        await fsPromises.rm(sessionDir, { recursive: true, force: true });
      } catch (error) {
        log.error(`Failed to remove session directory for ${workspaceId}:`, error);
      }

      // Dispose session
      this.disposeSession(workspaceId);

      // Close any terminal sessions for this workspace
      this.terminalService?.closeWorkspaceSessions(workspaceId);

      // Remove from config
      await this.config.removeWorkspace(workspaceId);

      this.emit("metadata", { workspaceId, metadata: null });

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to remove workspace: ${message}`);
    }
  }

  async list(): Promise<FrontendWorkspaceMetadata[]> {
    try {
      return await this.config.getAllWorkspaceMetadata();
    } catch (error) {
      console.error("Failed to list workspaces:", error);
      return [];
    }
  }

  async getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null> {
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const metadata = allMetadata.find((m) => m.id === workspaceId);

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
          const textParts = firstUserMessage.parts.filter((p) => p.type === "text");
          const messageText = textParts.map((p) => p.text).join(" ");

          if (messageText.trim()) {
            const branchNameResult = await generateWorkspaceName(
              messageText,
              "anthropic:claude-sonnet-4-5",
              this.aiService
            );

            if (branchNameResult.success) {
              const branchName = branchNameResult.data;
              await this.config.updateWorkspaceMetadata(workspaceId, {
                name: branchName,
              });

              metadata.name = branchName;
              log.info(`Regenerated workspace name: ${branchName}`);
            }
          }
        }
      } catch (error) {
        log.error(`Failed to regenerate workspace names for ${workspaceId}:`, error);
      }
    }

    return metadata! ?? null;
  }

  async rename(workspaceId: string, newName: string): Promise<Result<{ newWorkspaceId: string }>> {
    try {
      if (this.aiService.isStreaming(workspaceId)) {
        return Err(
          "Cannot rename workspace while AI stream is active. Please wait for the stream to complete."
        );
      }

      const validation = validateWorkspaceName(newName);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid workspace name");
      }

      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
      }
      const oldMetadata = metadataResult.data;
      const oldName = oldMetadata.name;

      if (newName === oldName) {
        return Ok({ newWorkspaceId: workspaceId });
      }

      const allWorkspaces = await this.config.getAllWorkspaceMetadata();
      const collision = allWorkspaces.find(
        (ws) => (ws.name === newName || ws.id === newName) && ws.id !== workspaceId
      );
      if (collision) {
        return Err(`Workspace with name "${newName}" already exists`);
      }

      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Failed to find workspace in config");
      }
      const { projectPath } = workspace;

      const runtime = createRuntime(
        oldMetadata.runtimeConfig ?? { type: "local", srcBaseDir: this.config.srcDir },
        { projectPath }
      );

      const renameResult = await runtime.renameWorkspace(projectPath, oldName, newName);

      if (!renameResult.success) {
        return Err(renameResult.error);
      }

      const { oldPath, newPath } = renameResult;

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry = projectConfig.workspaces.find((w) => w.path === oldPath);
          if (workspaceEntry) {
            workspaceEntry.name = newName;
            workspaceEntry.path = newPath;
          }
        }
        return config;
      });

      const allMetadataUpdated = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadataUpdated.find((m) => m.id === workspaceId);
      if (!updatedMetadata) {
        return Err("Failed to retrieve updated workspace metadata");
      }

      const session = this.sessions.get(workspaceId);
      if (session) {
        session.emitMetadata(updatedMetadata);
      } else {
        this.emit("metadata", { workspaceId, metadata: updatedMetadata });
      }

      return Ok({ newWorkspaceId: workspaceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to rename workspace: ${message}`);
    }
  }

  async fork(
    sourceWorkspaceId: string,
    newName: string
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata; projectPath: string }>> {
    try {
      const validation = validateWorkspaceName(newName);
      if (!validation.valid) {
        return Err(validation.error ?? "Invalid workspace name");
      }

      if (this.aiService.isStreaming(sourceWorkspaceId)) {
        await this.partialService.commitToHistory(sourceWorkspaceId);
      }

      const sourceMetadataResult = await this.aiService.getWorkspaceMetadata(sourceWorkspaceId);
      if (!sourceMetadataResult.success) {
        return Err(`Failed to get source workspace metadata: ${sourceMetadataResult.error}`);
      }
      const sourceMetadata = sourceMetadataResult.data;
      const foundProjectPath = sourceMetadata.projectPath;
      const projectName = sourceMetadata.projectName;

      const sourceRuntimeConfig = sourceMetadata.runtimeConfig ?? {
        type: "local",
        srcBaseDir: this.config.srcDir,
      };
      const runtime = createRuntime(sourceRuntimeConfig);

      const newWorkspaceId = this.config.generateStableId();

      const session = this.getOrCreateSession(newWorkspaceId);
      this.initStateManager.startInit(newWorkspaceId, foundProjectPath);
      const initLogger = this.createInitLogger(newWorkspaceId);

      const forkResult = await runtime.forkWorkspace({
        projectPath: foundProjectPath,
        sourceWorkspaceName: sourceMetadata.name,
        newWorkspaceName: newName,
        initLogger,
      });

      if (!forkResult.success) {
        return Err(forkResult.error ?? "Failed to fork workspace");
      }

      const sourceSessionDir = this.config.getSessionDir(sourceWorkspaceId);
      const newSessionDir = this.config.getSessionDir(newWorkspaceId);

      try {
        await fsPromises.mkdir(newSessionDir, { recursive: true });

        const sourceChatPath = path.join(sourceSessionDir, "chat.jsonl");
        const newChatPath = path.join(newSessionDir, "chat.jsonl");
        try {
          await fsPromises.copyFile(sourceChatPath, newChatPath);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }

        const sourcePartialPath = path.join(sourceSessionDir, "partial.json");
        const newPartialPath = path.join(newSessionDir, "partial.json");
        try {
          await fsPromises.copyFile(sourcePartialPath, newPartialPath);
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
      } catch (copyError) {
        await runtime.deleteWorkspace(foundProjectPath, newName, true);
        try {
          await fsPromises.rm(newSessionDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log.error(`Failed to clean up session dir ${newSessionDir}:`, cleanupError);
        }
        const message = copyError instanceof Error ? copyError.message : String(copyError);
        return Err(`Failed to copy chat history: ${message}`);
      }

      // Compute namedWorkspacePath for frontend metadata
      const namedWorkspacePath = runtime.getWorkspacePath(foundProjectPath, newName);

      const metadata: FrontendWorkspaceMetadata = {
        id: newWorkspaceId,
        name: newName,
        projectName,
        projectPath: foundProjectPath,
        createdAt: new Date().toISOString(),
        runtimeConfig: sourceRuntimeConfig,
        namedWorkspacePath,
      };

      await this.config.addWorkspace(foundProjectPath, metadata);
      session.emitMetadata(metadata);

      return Ok({ metadata, projectPath: foundProjectPath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to fork workspace: ${message}`);
    }
  }

  async sendMessage(
    workspaceId: string | null,
    message: string,
    options:
      | (SendMessageOptions & {
          imageParts?: ImagePart[];
          runtimeConfig?: RuntimeConfig;
          projectPath?: string;
          trunkBranch?: string;
        })
      | undefined = { model: "claude-sonnet-4-5-latest" }
  ): Promise<
    | Result<void, SendMessageError>
    | { success: true; workspaceId: string; metadata: FrontendWorkspaceMetadata }
    | { success: false; error: string }
  > {
    if (workspaceId === null) {
      if (!options?.projectPath) {
        return Err("projectPath is required when workspaceId is null");
      }

      log.debug("sendMessage handler: Creating workspace for first message", {
        projectPath: options.projectPath,
        messagePreview: message.substring(0, 50),
      });

      return await this.createForFirstMessage(message, options.projectPath, options);
    }

    log.debug("sendMessage handler: Received", {
      workspaceId,
      messagePreview: message.substring(0, 50),
      mode: options?.mode,
      options,
    });

    try {
      const session = this.getOrCreateSession(workspaceId);
      void this.updateRecencyTimestamp(workspaceId);

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
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error, null, 2);
      log.error("Unexpected error in sendMessage handler:", error);

      // Handle incompatible workspace errors from downgraded configs
      if (error instanceof IncompatibleRuntimeError) {
        const sendError: SendMessageError = {
          type: "incompatible_workspace",
          message: error.message,
        };
        return Err(sendError);
      }

      const sendError: SendMessageError = {
        type: "unknown",
        raw: `Failed to send message: ${errorMessage}`,
      };
      return Err(sendError);
    }
  }

  async resumeStream(
    workspaceId: string,
    options: SendMessageOptions | undefined = { model: "claude-3-5-sonnet-latest" }
  ): Promise<Result<void, SendMessageError>> {
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in resumeStream handler:", error);

      // Handle incompatible workspace errors from downgraded configs
      if (error instanceof IncompatibleRuntimeError) {
        const sendError: SendMessageError = {
          type: "incompatible_workspace",
          message: error.message,
        };
        return Err(sendError);
      }

      const sendError: SendMessageError = {
        type: "unknown",
        raw: `Failed to resume stream: ${errorMessage}`,
      };
      return Err(sendError);
    }
  }

  async interruptStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean; sendQueuedImmediately?: boolean }
  ): Promise<Result<void>> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      const stopResult = await session.interruptStream(options);
      if (!stopResult.success) {
        log.error("Failed to stop stream:", stopResult.error);
        return Err(stopResult.error);
      }

      // For hard interrupts, delete partial immediately. For soft interrupts,
      // defer to stream-abort handler (stream is still running and may recreate partial).
      if (options?.abandonPartial && !options?.soft) {
        log.debug("Abandoning partial for workspace:", workspaceId);
        await this.partialService.deletePartial(workspaceId);
      }

      // Handle queued messages based on option
      if (options?.sendQueuedImmediately) {
        // Send queued messages immediately instead of restoring to input
        session.sendQueuedMessages();
      } else {
        // Restore queued messages to input box for user-initiated interrupts
        session.restoreQueueToInput();
      }

      return Ok(undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in interruptStream handler:", error);
      return Err(`Failed to interrupt stream: ${errorMessage}`);
    }
  }

  clearQueue(workspaceId: string): Result<void> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      session.clearQueue();
      return Ok(undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Unexpected error in clearQueue handler:", error);
      return Err(`Failed to clear queue: ${errorMessage}`);
    }
  }

  async truncateHistory(workspaceId: string, percentage?: number): Promise<Result<void>> {
    if (this.aiService.isStreaming(workspaceId)) {
      return Err(
        "Cannot truncate history while stream is active. Press Esc to stop the stream first."
      );
    }

    const truncateResult = await this.historyService.truncateHistory(
      workspaceId,
      percentage ?? 1.0
    );
    if (!truncateResult.success) {
      return Err(truncateResult.error);
    }

    const deletedSequences = truncateResult.data;
    if (deletedSequences.length > 0) {
      const deleteMessage: DeleteMessage = {
        type: "delete",
        historySequences: deletedSequences,
      };
      // Emit through the session so ORPC subscriptions receive the event
      const session = this.sessions.get(workspaceId);
      if (session) {
        session.emitChatEvent(deleteMessage);
      } else {
        // Fallback to direct emit (legacy path)
        this.emit("chat", { workspaceId, message: deleteMessage });
      }
    }

    return Ok(undefined);
  }

  async replaceHistory(workspaceId: string, summaryMessage: MuxMessage): Promise<Result<void>> {
    const isCompaction = summaryMessage.metadata?.compacted === true;
    if (!isCompaction && this.aiService.isStreaming(workspaceId)) {
      return Err(
        "Cannot replace history while stream is active. Press Esc to stop the stream first."
      );
    }

    try {
      const clearResult = await this.historyService.clearHistory(workspaceId);
      if (!clearResult.success) {
        return Err(`Failed to clear history: ${clearResult.error}`);
      }
      const deletedSequences = clearResult.data;

      const appendResult = await this.historyService.appendToHistory(workspaceId, summaryMessage);
      if (!appendResult.success) {
        return Err(`Failed to append summary message: ${appendResult.error}`);
      }

      // Emit through the session so ORPC subscriptions receive the events
      const session = this.sessions.get(workspaceId);
      if (deletedSequences.length > 0) {
        const deleteMessage: DeleteMessage = {
          type: "delete",
          historySequences: deletedSequences,
        };
        if (session) {
          session.emitChatEvent(deleteMessage);
        } else {
          this.emit("chat", { workspaceId, message: deleteMessage });
        }
      }

      // Add type: "message" for discriminated union (MuxMessage doesn't have it)
      const typedSummaryMessage = { ...summaryMessage, type: "message" as const };
      if (session) {
        session.emitChatEvent(typedSummaryMessage);
      } else {
        this.emit("chat", { workspaceId, message: typedSummaryMessage });
      }

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to replace history: ${message}`);
    }
  }

  async getActivityList(): Promise<Record<string, WorkspaceActivitySnapshot>> {
    try {
      const snapshots = await this.extensionMetadata.getAllSnapshots();
      return Object.fromEntries(snapshots.entries());
    } catch (error) {
      log.error("Failed to list activity:", error);
      return {};
    }
  }
  async getChatHistory(workspaceId: string): Promise<MuxMessage[]> {
    try {
      const history = await this.historyService.getHistory(workspaceId);
      return history.success ? history.data : [];
    } catch (error) {
      log.error("Failed to get chat history:", error);
      return [];
    }
  }

  async getFullReplay(workspaceId: string): Promise<WorkspaceChatMessage[]> {
    try {
      const session = this.getOrCreateSession(workspaceId);
      const events: WorkspaceChatMessage[] = [];
      await session.replayHistory(({ message }) => {
        events.push(message);
      });
      return events;
    } catch (error) {
      log.error("Failed to get full replay:", error);
      return [];
    }
  }

  async executeBash(
    workspaceId: string,
    script: string,
    options?: {
      timeout_secs?: number;
      niceness?: number;
    }
  ): Promise<Result<BashToolResult>> {
    try {
      // Get workspace metadata
      const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err(`Failed to get workspace metadata: ${metadataResult.error}`);
      }

      const metadata = metadataResult.data;

      // Get actual workspace path from config
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err(`Workspace ${workspaceId} not found in config`);
      }

      // Load project secrets
      const projectSecrets = this.config.getProjectSecrets(metadata.projectPath);

      // Create scoped temp directory for this IPC call
      using tempDir = new DisposableTempDir("mux-ipc-bash");

      // Create runtime and compute workspace path
      const runtimeConfig = metadata.runtimeConfig ?? {
        type: "local" as const,
        srcBaseDir: this.config.srcDir,
      };
      const runtime = createRuntime(runtimeConfig, { projectPath: metadata.projectPath });
      const workspacePath = runtime.getWorkspacePath(metadata.projectPath, metadata.name);

      // Create bash tool
      const bashTool = createBashTool({
        cwd: workspacePath,
        runtime,
        secrets: secretsToRecord(projectSecrets),
        niceness: options?.niceness,
        runtimeTempDir: tempDir.path,
        overflow_policy: "truncate",
      });

      // Execute the script
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
}
