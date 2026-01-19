import type {
  RuntimeCreateFlags,
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
} from "./Runtime";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { WorktreeManager } from "@/node/worktree/WorktreeManager";

export interface DevcontainerRuntimeOptions {
  srcBaseDir: string;
  configPath: string;
}

export class DevcontainerRuntime extends LocalBaseRuntime {
  private readonly worktreeManager: WorktreeManager;
  private readonly configPath: string;

  readonly createFlags: RuntimeCreateFlags = {
    deferredRuntimeAccess: true,
  };

  constructor(options: DevcontainerRuntimeOptions) {
    super();
    this.worktreeManager = new WorktreeManager(options.srcBaseDir);
    this.configPath = options.configPath;
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    return this.worktreeManager.getWorkspacePath(projectPath, workspaceName);
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    return this.worktreeManager.createWorkspace({
      projectPath: params.projectPath,
      branchName: params.branchName,
      trunkBranch: params.trunkBranch,
      initLogger: params.initLogger,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- stub for Phase 1; will have real async logic
  async initWorkspace(_params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    return { success: true };
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
