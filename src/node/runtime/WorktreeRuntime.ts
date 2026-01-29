import type {
  EnsureReadyOptions,
  EnsureReadyResult,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
} from "./Runtime";
import { WORKSPACE_REPO_MISSING_ERROR } from "./Runtime";
import { checkInitHookExists, getMuxEnv } from "./initHook";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { getErrorMessage } from "@/common/utils/errors";
import { isGitRepository } from "@/node/utils/pathUtils";
import { WorktreeManager } from "@/node/worktree/WorktreeManager";

/**
 * Worktree runtime implementation that executes commands and file operations
 * directly on the host machine using Node.js APIs.
 *
 * This runtime uses git worktrees for workspace isolation:
 * - Workspaces are created in {srcBaseDir}/{projectName}/{workspaceName}
 * - Each workspace is a git worktree with its own branch
 */
export class WorktreeRuntime extends LocalBaseRuntime {
  private readonly worktreeManager: WorktreeManager;
  private readonly currentProjectPath?: string;
  private readonly currentWorkspaceName?: string;

  constructor(
    srcBaseDir: string,
    options?: {
      projectPath?: string;
      workspaceName?: string;
    }
  ) {
    super();
    this.worktreeManager = new WorktreeManager(srcBaseDir);
    this.currentProjectPath = options?.projectPath;
    this.currentWorkspaceName = options?.workspaceName;
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    return this.worktreeManager.getWorkspacePath(projectPath, workspaceName);
  }

  override async ensureReady(options?: EnsureReadyOptions): Promise<EnsureReadyResult> {
    if (!this.currentProjectPath || !this.currentWorkspaceName) {
      return { ready: true };
    }

    const statusSink = options?.statusSink;
    statusSink?.({
      phase: "checking",
      runtimeType: "worktree",
      detail: "Checking repository...",
    });

    const workspacePath = this.getWorkspacePath(this.currentProjectPath, this.currentWorkspaceName);
    const hasRepo = await isGitRepository(workspacePath);
    if (!hasRepo) {
      statusSink?.({
        phase: "error",
        runtimeType: "worktree",
        detail: WORKSPACE_REPO_MISSING_ERROR,
      });
      return {
        ready: false,
        error: WORKSPACE_REPO_MISSING_ERROR,
        errorType: "runtime_not_ready",
      };
    }

    statusSink?.({ phase: "ready", runtimeType: "worktree" });
    return { ready: true };
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return this.worktreeManager.createWorkspace({
      projectPath: params.projectPath,
      branchName: params.branchName,
      trunkBranch: params.trunkBranch,
      initLogger: params.initLogger,
    });
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    const { projectPath, branchName, workspacePath, initLogger, env, skipInitHook } = params;

    try {
      if (skipInitHook) {
        initLogger.logStep("Skipping .mux/init hook (disabled for this task)");
        initLogger.logComplete(0);
        return { success: true };
      }

      // Run .mux/init hook if it exists
      // Note: runInitHook calls logComplete() internally if hook exists
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        const muxEnv = { ...env, ...getMuxEnv(projectPath, "worktree", branchName) };
        await this.runInitHook(workspacePath, muxEnv, initLogger);
      } else {
        // No hook - signal completion immediately
        initLogger.logComplete(0);
      }
      return { success: true };
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      initLogger.logStderr(`Initialization failed: ${errorMsg}`);
      initLogger.logComplete(-1);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string,
    _abortSignal?: AbortSignal
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    return this.worktreeManager.renameWorkspace(projectPath, oldName, newName);
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    _abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    return this.worktreeManager.deleteWorkspace(projectPath, workspaceName, force);
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    return this.worktreeManager.forkWorkspace(params);
  }
}
