import { EventEmitter } from "events";
import * as path from "path";
import * as fsPromises from "fs/promises";
import assert from "@/common/utils/assert";
import type { Config } from "@/node/config";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import { askUserQuestionManager } from "@/node/services/askUserQuestionManager";
import { log } from "@/node/services/log";
import { AgentSession } from "@/node/services/agentSession";
import type { HistoryService } from "@/node/services/historyService";
import type { PartialService } from "@/node/services/partialService";
import type { AIService } from "@/node/services/aiService";
import type { InitStateManager } from "@/node/services/initStateManager";
import type { ExtensionMetadataService } from "@/node/services/ExtensionMetadataService";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import { createRuntime, IncompatibleRuntimeError } from "@/node/runtime/runtimeFactory";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { getPlanFilePath, getLegacyPlanFilePath } from "@/common/utils/planStorage";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { extractEditedFilePaths } from "@/common/utils/messages/extractEditedFiles";
import { fileExists } from "@/node/utils/runtime/fileExists";
import { expandTilde, expandTildeForSSH } from "@/node/runtime/tildeExpansion";

import type { PostCompactionExclusions } from "@/common/types/attachment";
import type {
  SendMessageOptions,
  DeleteMessage,
  ImagePart,
  WorkspaceChatMessage,
} from "@/common/orpc/types";
import type { workspace as workspaceSchemas } from "@/common/orpc/schemas/api";
import type { z } from "zod";
import type { SendMessageError } from "@/common/types/errors";
import type {
  FrontendWorkspaceMetadata,
  WorkspaceActivitySnapshot,
} from "@/common/types/workspace";
import { isDynamicToolPart } from "@/common/types/toolParts";
import {
  AskUserQuestionToolArgsSchema,
  AskUserQuestionToolResultSchema,
} from "@/common/utils/tools/toolDefinitions";
import type { MuxMessage } from "@/common/types/message";
import type { RuntimeConfig } from "@/common/types/runtime";
import { hasSrcBaseDir, getSrcBaseDir, isSSHRuntime } from "@/common/types/runtime";
import { defaultModel } from "@/common/utils/ai/models";
import type { StreamEndEvent, StreamAbortEvent } from "@/common/types/stream";
import type { TerminalService } from "@/node/services/terminalService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

import { DisposableTempDir } from "@/node/services/tempDir";
import { createBashTool } from "@/node/services/tools/bash";
import type { AskUserQuestionToolSuccessResult, BashToolResult } from "@/common/types/tools";
import { secretsToRecord } from "@/common/types/secrets";

import { movePlanFile } from "@/node/utils/runtime/helpers";

/** Maximum number of retry attempts when workspace name collides */
const MAX_WORKSPACE_NAME_COLLISION_RETRIES = 3;

// Keep short to feel instant, but debounce bursts of file_edit_* tool calls.
const POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS = 100;

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

  // Debounce post-compaction metadata refreshes (file_edit_* can fire rapidly)
  private readonly postCompactionRefreshTimers = new Map<string, NodeJS.Timeout>();
  // Tracks workspaces currently being renamed to prevent streaming during rename
  private readonly renamingWorkspaces = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly partialService: PartialService,
    private readonly aiService: AIService,
    private readonly initStateManager: InitStateManager,
    private readonly extensionMetadata: ExtensionMetadataService,
    private readonly backgroundProcessManager: BackgroundProcessManager
  ) {
    super();
    this.setupMetadataListeners();
  }

  private mcpServerManager?: MCPServerManager;
  // Optional terminal service for cleanup on workspace removal
  private terminalService?: TerminalService;

  /**
   * Set the MCP server manager for tool access.
   * Called after construction due to circular dependency.
   */
  setMCPServerManager(manager: MCPServerManager): void {
    this.mcpServerManager = manager;
  }

  /**
   * Set the terminal service for cleanup on workspace removal.
   */
  setTerminalService(terminalService: TerminalService): void {
    this.terminalService = terminalService;
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(workspaceId: string, errorMessage?: string): Promise<boolean> {
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

  private schedulePostCompactionMetadataRefresh(workspaceId: string): void {
    assert(typeof workspaceId === "string", "workspaceId must be a string");
    const trimmed = workspaceId.trim();
    assert(trimmed.length > 0, "workspaceId must not be empty");

    const existing = this.postCompactionRefreshTimers.get(trimmed);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.postCompactionRefreshTimers.delete(trimmed);
      void this.emitPostCompactionMetadata(trimmed);
    }, POST_COMPACTION_METADATA_REFRESH_DEBOUNCE_MS);

    this.postCompactionRefreshTimers.set(trimmed, timer);
  }

  private async emitPostCompactionMetadata(workspaceId: string): Promise<void> {
    try {
      const session = this.sessions.get(workspaceId);
      if (!session) {
        return;
      }

      const metadata = await this.getInfo(workspaceId);
      if (!metadata) {
        return;
      }

      const postCompaction = await this.getPostCompactionState(workspaceId);
      const enrichedMetadata = { ...metadata, postCompaction };
      session.emitMetadata(enrichedMetadata);
    } catch (error) {
      // Workspace runtime unavailable (e.g., SSH unreachable) - skip emitting post-compaction state.
      log.debug("Failed to emit post-compaction metadata", { workspaceId, error });
    }
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
      backgroundProcessManager: this.backgroundProcessManager,
      onCompactionComplete: () => {
        this.schedulePostCompactionMetadataRefresh(trimmed);
      },
      onPostCompactionStateChange: () => {
        this.schedulePostCompactionMetadataRefresh(trimmed);
      },
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
    const trimmed = workspaceId.trim();
    const session = this.sessions.get(trimmed);
    const refreshTimer = this.postCompactionRefreshTimers.get(trimmed);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      this.postCompactionRefreshTimers.delete(trimmed);
    }

    if (!session) {
      return;
    }

    const subscriptions = this.sessionSubscriptions.get(trimmed);
    if (subscriptions) {
      subscriptions.chat();
      subscriptions.metadata();
      this.sessionSubscriptions.delete(trimmed);
    }

    session.dispose();
    this.sessions.delete(trimmed);
  }

  /**
   * Get post-compaction context state for a workspace.
   * Returns info about what will be injected after compaction.
   * Prefers cached paths from pending compaction, falls back to history extraction.
   */
  public async getPostCompactionState(workspaceId: string): Promise<{
    planPath: string | null;
    trackedFilePaths: string[];
    excludedItems: string[];
  }> {
    // Get workspace metadata to create runtime for plan file check
    const metadata = await this.getInfo(workspaceId);
    if (!metadata) {
      // Can't get metadata, return empty state
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      return { planPath: null, trackedFilePaths: [], excludedItems: exclusions.excludedItems };
    }

    const planPath = getPlanFilePath(metadata.name, metadata.projectName);
    // Expand tilde for comparison with absolute paths from message history
    const expandedPlanPath = expandTilde(planPath);
    // Also get legacy plan path (stored by workspace ID) for filtering
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);
    const expandedLegacyPlanPath = expandTilde(legacyPlanPath);
    const runtime = createRuntime(metadata.runtimeConfig, { projectPath: metadata.projectPath });

    // Check both new and legacy plan paths, prefer new path
    const newPlanExists = await fileExists(runtime, planPath);
    const legacyPlanExists = !newPlanExists && (await fileExists(runtime, legacyPlanPath));
    const activePlanPath = newPlanExists ? planPath : legacyPlanExists ? legacyPlanPath : null;

    // Load exclusions
    const exclusions = await this.getPostCompactionExclusions(workspaceId);

    // Helper to check if a path is a plan file (new or legacy format)
    const isPlanPath = (p: string) =>
      p === planPath ||
      p === expandedPlanPath ||
      p === legacyPlanPath ||
      p === expandedLegacyPlanPath;

    // If session has pending compaction attachments, use cached paths
    // (history is cleared after compaction, but cache survives)
    const session = this.sessions.get(workspaceId);
    const pendingPaths = session?.getPendingTrackedFilePaths();
    if (pendingPaths) {
      // Filter out both new and legacy plan file paths
      const trackedFilePaths = pendingPaths.filter((p) => !isPlanPath(p));
      return {
        planPath: activePlanPath,
        trackedFilePaths,
        excludedItems: exclusions.excludedItems,
      };
    }

    // Fallback: compute tracked files from message history (survives reloads)
    const historyResult = await this.historyService.getHistory(workspaceId);
    const messages = historyResult.success ? historyResult.data : [];
    const allPaths = extractEditedFilePaths(messages);

    // Exclude plan file from tracked files since it has its own section
    // Filter out both new and legacy plan file paths
    const trackedFilePaths = allPaths.filter((p) => !isPlanPath(p));
    return {
      planPath: activePlanPath,
      trackedFilePaths,
      excludedItems: exclusions.excludedItems,
    };
  }

  /**
   * Get post-compaction exclusions for a workspace.
   * Returns empty exclusions if file doesn't exist.
   */
  public async getPostCompactionExclusions(workspaceId: string): Promise<PostCompactionExclusions> {
    const exclusionsPath = path.join(this.config.getSessionDir(workspaceId), "exclusions.json");
    try {
      const data = await fsPromises.readFile(exclusionsPath, "utf-8");
      return JSON.parse(data) as PostCompactionExclusions;
    } catch {
      return { excludedItems: [] };
    }
  }

  /**
   * Set whether an item is excluded from post-compaction context.
   * Item IDs: "plan" for plan file, "file:<path>" for tracked files.
   */
  public async setPostCompactionExclusion(
    workspaceId: string,
    itemId: string,
    excluded: boolean
  ): Promise<Result<void>> {
    try {
      const exclusions = await this.getPostCompactionExclusions(workspaceId);
      const set = new Set(exclusions.excludedItems);

      if (excluded) {
        set.add(itemId);
      } else {
        set.delete(itemId);
      }

      const sessionDir = this.config.getSessionDir(workspaceId);
      await fsPromises.mkdir(sessionDir, { recursive: true });
      const exclusionsPath = path.join(sessionDir, "exclusions.json");
      await fsPromises.writeFile(
        exclusionsPath,
        JSON.stringify({ excludedItems: [...set] }, null, 2)
      );
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to set exclusion: ${message}`);
    }
  }

  async create(
    projectPath: string,
    branchName: string,
    trunkBranch: string | undefined,
    title?: string,
    runtimeConfig?: RuntimeConfig
  ): Promise<Result<{ metadata: FrontendWorkspaceMetadata }>> {
    // Validate workspace name
    const validation = validateWorkspaceName(branchName);
    if (!validation.valid) {
      return Err(validation.error ?? "Invalid workspace name");
    }

    // Generate stable workspace ID
    const workspaceId = this.config.generateStableId();

    // Create runtime for workspace creation
    // Default to worktree runtime for backward compatibility
    let finalRuntimeConfig: RuntimeConfig = runtimeConfig ?? {
      type: "worktree",
      srcBaseDir: this.config.srcDir,
    };

    // Local runtime doesn't need a trunk branch; worktree/SSH runtimes require it
    const isLocalRuntime = finalRuntimeConfig.type === "local";
    const normalizedTrunkBranch = trunkBranch?.trim() ?? "";
    if (!isLocalRuntime && normalizedTrunkBranch.length === 0) {
      return Err("Trunk branch is required for worktree and SSH runtimes");
    }

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
        title,
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
          title,
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

      // Stop MCP servers for this workspace
      if (this.mcpServerManager) {
        await this.mcpServerManager.stopServers(workspaceId);
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

  async list(
    options?: z.infer<typeof workspaceSchemas.list.input>
  ): Promise<FrontendWorkspaceMetadata[]> {
    try {
      const metadata = await this.config.getAllWorkspaceMetadata();

      if (!options?.includePostCompaction) {
        return metadata;
      }

      // Fetch post-compaction state for all workspaces in parallel
      // Catch per-workspace errors to avoid failing the entire list if one workspace is unreachable
      return Promise.all(
        metadata.map(async (ws) => {
          try {
            const postCompaction = await this.getPostCompactionState(ws.id);
            return { ...ws, postCompaction };
          } catch {
            // Workspace runtime unavailable (e.g., SSH unreachable) - return without post-compaction state
            return ws;
          }
        })
      );
    } catch (error) {
      log.error("Failed to list workspaces:", error);
      return [];
    }
  }

  async getInfo(workspaceId: string): Promise<FrontendWorkspaceMetadata | null> {
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    return allMetadata.find((m) => m.id === workspaceId) ?? null;
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

      // Mark workspace as renaming to block new streams during the rename operation
      this.renamingWorkspaces.add(workspaceId);

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

      // Rename plan file if it exists (uses workspace name, not ID)
      await movePlanFile(runtime, oldName, newName, oldMetadata.projectName);

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
    } finally {
      // Always clear renaming flag, even on error
      this.renamingWorkspaces.delete(workspaceId);
    }
  }

  /**
   * Update workspace title without affecting the filesystem name.
   * Unlike rename(), this can be called even while streaming is active.
   */
  async updateTitle(workspaceId: string, title: string): Promise<Result<void>> {
    try {
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err("Workspace not found");
      }
      const { projectPath, workspacePath } = workspace;

      await this.config.editConfig((config) => {
        const projectConfig = config.projects.get(projectPath);
        if (projectConfig) {
          const workspaceEntry = projectConfig.workspaces.find((w) => w.path === workspacePath);
          if (workspaceEntry) {
            workspaceEntry.title = title;
          }
        }
        return config;
      });

      // Emit updated metadata
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const updatedMetadata = allMetadata.find((m) => m.id === workspaceId);
      if (updatedMetadata) {
        const session = this.sessions.get(workspaceId);
        if (session) {
          session.emitMetadata(updatedMetadata);
        } else {
          this.emit("metadata", { workspaceId, metadata: updatedMetadata });
        }
      }

      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to update workspace title: ${message}`);
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

        const sourceUsagePath = path.join(sourceSessionDir, "session-usage.json");
        const newUsagePath = path.join(newSessionDir, "session-usage.json");
        try {
          await fsPromises.copyFile(sourceUsagePath, newUsagePath);
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
    workspaceId: string,
    message: string,
    options:
      | (SendMessageOptions & {
          imageParts?: ImagePart[];
        })
      | undefined = { model: defaultModel }
  ): Promise<Result<void, SendMessageError>> {
    log.debug("sendMessage handler: Received", {
      workspaceId,
      messagePreview: message.substring(0, 50),
      mode: options?.mode,
      options,
    });

    try {
      // Block streaming while workspace is being renamed to prevent path conflicts
      if (this.renamingWorkspaces.has(workspaceId)) {
        log.debug("sendMessage blocked: workspace is being renamed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being renamed. Please wait and try again.",
        });
      }

      const session = this.getOrCreateSession(workspaceId);

      // Skip recency update for idle compaction - preserve original "last used" time
      const muxMeta = options?.muxMetadata as { type?: string; source?: string } | undefined;
      const isIdleCompaction =
        muxMeta?.type === "compaction-request" && muxMeta?.source === "idle-compaction";
      // Use current time for recency - this matches the timestamp used on the message
      // in agentSession.sendMessage(). Keeps ExtensionMetadata in sync with chat.jsonl.
      const messageTimestamp = Date.now();
      if (!isIdleCompaction) {
        void this.updateRecencyTimestamp(workspaceId, messageTimestamp);
      }

      if (this.aiService.isStreaming(workspaceId) && !options?.editMessageId) {
        const pendingAskUserQuestion = askUserQuestionManager.getLatestPending(workspaceId);
        if (pendingAskUserQuestion) {
          try {
            askUserQuestionManager.cancel(
              workspaceId,
              pendingAskUserQuestion.toolCallId,
              "User responded in chat; questions canceled"
            );
          } catch (error) {
            log.debug("Failed to cancel pending ask_user_question", {
              workspaceId,
              toolCallId: pendingAskUserQuestion.toolCallId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

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
      // Block streaming while workspace is being renamed to prevent path conflicts
      if (this.renamingWorkspaces.has(workspaceId)) {
        log.debug("resumeStream blocked: workspace is being renamed", { workspaceId });
        return Err({
          type: "unknown",
          raw: "Workspace is being renamed. Please wait and try again.",
        });
      }

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

  async answerAskUserQuestion(
    workspaceId: string,
    toolCallId: string,
    answers: Record<string, string>
  ): Promise<Result<void>> {
    try {
      // Fast path: normal in-memory execution (stream still running, tool is awaiting input).
      askUserQuestionManager.answer(workspaceId, toolCallId, answers);
      return Ok(undefined);
    } catch (error) {
      // Fallback path: app restart (or other process death) means the in-memory
      // AskUserQuestionManager has no pending entry anymore.
      //
      // In that case we persist the tool result into partial.json or chat.jsonl,
      // then emit a synthetic tool-call-end so the renderer updates immediately.
      try {
        // Helper: update a message in-place if it contains this ask_user_question tool call.
        const tryFinalizeMessage = (
          msg: MuxMessage
        ): Result<{ updated: MuxMessage; output: AskUserQuestionToolSuccessResult }> => {
          let foundToolCall = false;
          let output: AskUserQuestionToolSuccessResult | null = null;
          let errorMessage: string | null = null;

          const updatedParts = msg.parts.map((part) => {
            if (!isDynamicToolPart(part) || part.toolCallId !== toolCallId) {
              return part;
            }

            foundToolCall = true;

            if (part.toolName !== "ask_user_question") {
              errorMessage = `toolCallId=${toolCallId} is toolName=${part.toolName}, expected ask_user_question`;
              return part;
            }

            // Already answered - treat as idempotent.
            if (part.state === "output-available") {
              const parsedOutput = AskUserQuestionToolResultSchema.safeParse(part.output);
              if (!parsedOutput.success) {
                errorMessage = `ask_user_question output validation failed: ${parsedOutput.error.message}`;
                return part;
              }
              output = parsedOutput.data;
              return part;
            }

            const parsedArgs = AskUserQuestionToolArgsSchema.safeParse(part.input);
            if (!parsedArgs.success) {
              errorMessage = `ask_user_question input validation failed: ${parsedArgs.error.message}`;
              return part;
            }

            const nextOutput: AskUserQuestionToolSuccessResult = {
              questions: parsedArgs.data.questions,
              answers,
            };
            output = nextOutput;

            return {
              ...part,
              state: "output-available" as const,
              output: nextOutput,
            };
          });

          if (errorMessage) {
            return Err(errorMessage);
          }
          if (!foundToolCall) {
            return Err("ask_user_question toolCallId not found in message");
          }
          if (!output) {
            return Err("ask_user_question output missing after update");
          }

          return Ok({ updated: { ...msg, parts: updatedParts }, output });
        };

        // 1) Prefer partial.json (most common after restart while waiting)
        const partial = await this.partialService.readPartial(workspaceId);
        if (partial) {
          const finalized = tryFinalizeMessage(partial);
          if (finalized.success) {
            const writeResult = await this.partialService.writePartial(
              workspaceId,
              finalized.data.updated
            );
            if (!writeResult.success) {
              return Err(writeResult.error);
            }

            const session = this.getOrCreateSession(workspaceId);
            session.emitChatEvent({
              type: "tool-call-end",
              workspaceId,
              messageId: finalized.data.updated.id,
              toolCallId,
              toolName: "ask_user_question",
              result: finalized.data.output,
              timestamp: Date.now(),
            });

            return Ok(undefined);
          }
        }

        // 2) Fall back to chat history (partial may have already been committed)
        const historyResult = await this.historyService.getHistory(workspaceId);
        if (!historyResult.success) {
          return Err(historyResult.error);
        }

        // Find the newest message containing this tool call.
        let best: MuxMessage | null = null;
        let bestSeq = -Infinity;
        for (const msg of historyResult.data) {
          const seq = msg.metadata?.historySequence;
          if (seq === undefined) continue;

          const hasTool = msg.parts.some(
            (p) => isDynamicToolPart(p) && p.toolCallId === toolCallId
          );
          if (hasTool && seq > bestSeq) {
            best = msg;
            bestSeq = seq;
          }
        }

        if (!best) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return Err(`Failed to answer ask_user_question: ${errorMessage}`);
        }

        // Guard against answering stale tool calls.
        const maxSeq = Math.max(
          ...historyResult.data
            .map((m) => m.metadata?.historySequence)
            .filter((n): n is number => typeof n === "number")
        );
        if (bestSeq !== maxSeq) {
          return Err(
            `Refusing to answer ask_user_question: tool call is not the latest message (toolSeq=${bestSeq}, latestSeq=${maxSeq})`
          );
        }

        const finalized = tryFinalizeMessage(best);
        if (!finalized.success) {
          return Err(finalized.error);
        }

        const updateResult = await this.historyService.updateHistory(
          workspaceId,
          finalized.data.updated
        );
        if (!updateResult.success) {
          return Err(updateResult.error);
        }

        const session = this.getOrCreateSession(workspaceId);
        session.emitChatEvent({
          type: "tool-call-end",
          workspaceId,
          messageId: finalized.data.updated.id,
          toolCallId,
          toolName: "ask_user_question",
          result: finalized.data.output,
          timestamp: Date.now(),
        });

        return Ok(undefined);
      } catch (innerError) {
        const errorMessage = innerError instanceof Error ? innerError.message : String(innerError);
        return Err(errorMessage);
      }
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

  /**
   * Best-effort delete of plan files (new + legacy paths) for a workspace.
   *
   * Why best-effort: plan files may not exist yet, or deletion may fail due to permissions.
   */
  private async deletePlanFilesForWorkspace(
    workspaceId: string,
    metadata: FrontendWorkspaceMetadata
  ): Promise<void> {
    // Delete both new and legacy plan paths to handle migrated workspaces
    const planPath = getPlanFilePath(metadata.name, metadata.projectName);
    const legacyPlanPath = getLegacyPlanFilePath(workspaceId);

    // For SSH: use $HOME expansion so remote shell resolves to remote home directory
    // For local: expand tilde locally since shellQuote prevents shell expansion
    const quotedPlanPath = isSSHRuntime(metadata.runtimeConfig)
      ? expandTildeForSSH(planPath)
      : shellQuote(expandTilde(planPath));
    const quotedLegacyPlanPath = isSSHRuntime(metadata.runtimeConfig)
      ? expandTildeForSSH(legacyPlanPath)
      : shellQuote(expandTilde(legacyPlanPath));

    // SSH runtime: delete via remote shell so $HOME expands on the remote.
    if (isSSHRuntime(metadata.runtimeConfig)) {
      const runtime = createRuntime(metadata.runtimeConfig, {
        projectPath: metadata.projectPath,
      });

      try {
        // Use exec to delete files since runtime doesn't have a deleteFile method.
        // Delete both paths in one command for efficiency.
        const execStream = await runtime.exec(`rm -f ${quotedPlanPath} ${quotedLegacyPlanPath}`, {
          cwd: metadata.projectPath,
          timeout: 10,
        });
        // Wait for completion so callers can rely on the plan file actually being removed.
        await execStream.exitCode;
      } catch {
        // Plan files don't exist or can't be deleted - ignore
      }

      return;
    }

    // Local runtimes: delete directly on the local filesystem.
    const planPathAbs = expandTilde(planPath);
    const legacyPlanPathAbs = expandTilde(legacyPlanPath);

    await Promise.allSettled([
      fsPromises.rm(planPathAbs, { force: true }),
      fsPromises.rm(legacyPlanPathAbs, { force: true }),
    ]);
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

    // On full clear, also delete plan file and clear file change tracking
    if ((percentage ?? 1.0) === 1.0) {
      const metadata = await this.getInfo(workspaceId);
      if (metadata) {
        await this.deletePlanFilesForWorkspace(workspaceId, metadata);
      }
      this.sessions.get(workspaceId)?.clearFileState();
    }

    return Ok(undefined);
  }

  async replaceHistory(
    workspaceId: string,
    summaryMessage: MuxMessage,
    options?: { deletePlanFile?: boolean }
  ): Promise<Result<void>> {
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

      // Optional cleanup: delete plan file when caller explicitly requests it.
      // Used by propose_plan "Start Here" to prevent stale plans from lingering on disk.
      if (options?.deletePlanFile === true) {
        const metadata = await this.getInfo(workspaceId);
        if (metadata) {
          await this.deletePlanFilesForWorkspace(workspaceId, metadata);
        }
        this.sessions.get(workspaceId)?.clearFileState();
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

  /**
   * List background processes for a workspace.
   * Returns process info suitable for UI display (excludes handle).
   */
  async listBackgroundProcesses(workspaceId: string): Promise<
    Array<{
      id: string;
      pid: number;
      script: string;
      displayName?: string;
      startTime: number;
      status: "running" | "exited" | "killed" | "failed";
      exitCode?: number;
    }>
  > {
    const processes = await this.backgroundProcessManager.list(workspaceId);
    return processes.map((p) => ({
      id: p.id,
      pid: p.pid,
      script: p.script,
      displayName: p.displayName,
      startTime: p.startTime,
      status: p.status,
      exitCode: p.exitCode,
    }));
  }

  /**
   * Terminate a background process by ID.
   * Verifies the process belongs to the specified workspace.
   */
  async terminateBackgroundProcess(workspaceId: string, processId: string): Promise<Result<void>> {
    // Get process to verify workspace ownership
    const proc = await this.backgroundProcessManager.getProcess(processId);
    if (!proc) {
      return Err(`Process not found: ${processId}`);
    }
    if (proc.workspaceId !== workspaceId) {
      return Err(`Process ${processId} does not belong to workspace ${workspaceId}`);
    }

    const result = await this.backgroundProcessManager.terminate(processId);
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(undefined);
  }

  /**
   * Get the tool call IDs of foreground bash processes for a workspace.
   * Returns empty array if no foreground bashes are running.
   */
  getForegroundToolCallIds(workspaceId: string): string[] {
    return this.backgroundProcessManager.getForegroundToolCallIds(workspaceId);
  }

  /**
   * Send a foreground bash process to background by its tool call ID.
   * The process continues running but the agent stops waiting for it.
   */
  sendToBackground(toolCallId: string): Result<void> {
    const result = this.backgroundProcessManager.sendToBackground(toolCallId);
    if (!result.success) {
      return Err(result.error);
    }
    return Ok(undefined);
  }

  /**
   * Subscribe to background bash state changes.
   */
  onBackgroundBashChange(callback: (workspaceId: string) => void): void {
    this.backgroundProcessManager.on("change", callback);
  }

  /**
   * Unsubscribe from background bash state changes.
   */
  offBackgroundBashChange(callback: (workspaceId: string) => void): void {
    this.backgroundProcessManager.off("change", callback);
  }

  /**
   * Emit an idle-compaction-needed event to a workspace's stream.
   * Called by IdleCompactionService when a workspace becomes eligible while connected.
   */
  emitIdleCompactionNeeded(workspaceId: string): void {
    const session = this.sessions.get(workspaceId);
    if (session) {
      session.emitChatEvent({ type: "idle-compaction-needed" });
    }
  }
}
