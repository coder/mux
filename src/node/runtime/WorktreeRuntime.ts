import * as fsPromises from "fs/promises";
import * as path from "path";
import type {
  WorkspaceCreationParams,
  WorkspaceCreationResult,
  WorkspaceInitParams,
  WorkspaceInitResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "./Runtime";
import { listLocalBranches, cleanStaleLock } from "@/node/git";
import { checkInitHookExists, getMuxEnv } from "./initHook";
import { execAsync } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { expandTilde } from "./tildeExpansion";
import { LocalBaseRuntime } from "./LocalBaseRuntime";
import { toPosixPath } from "@/node/utils/paths";
import { log } from "@/node/services/log";

/**
 * Worktree runtime implementation that executes commands and file operations
 * directly on the host machine using Node.js APIs.
 *
 * This runtime uses git worktrees for workspace isolation:
 * - Workspaces are created in {srcBaseDir}/{projectName}/{workspaceName}
 * - Each workspace is a git worktree with its own branch
 */
export class WorktreeRuntime extends LocalBaseRuntime {
  private readonly srcBaseDir: string;

  constructor(srcBaseDir: string) {
    super();
    // Expand tilde to actual home directory path for local file system operations
    this.srcBaseDir = expandTilde(srcBaseDir);
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    const projectName = getProjectName(projectPath);
    return path.join(this.srcBaseDir, projectName, workspaceName);
  }

  async createWorkspace(params: WorkspaceCreationParams): Promise<WorkspaceCreationResult> {
    const { projectPath, branchName, trunkBranch, initLogger } = params;

    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    try {
      // Compute workspace path using the canonical method
      const workspacePath = this.getWorkspacePath(projectPath, branchName);
      initLogger.logStep("Creating git worktree...");

      // Create parent directory if needed
      const parentDir = path.dirname(workspacePath);
      try {
        await fsPromises.access(parentDir);
      } catch {
        await fsPromises.mkdir(parentDir, { recursive: true });
      }

      // Check if workspace already exists
      try {
        await fsPromises.access(workspacePath);
        return {
          success: false,
          error: `Workspace already exists at ${workspacePath}`,
        };
      } catch {
        // Workspace doesn't exist, proceed with creation
      }

      // Check if branch exists locally
      const localBranches = await listLocalBranches(projectPath);
      const branchExists = localBranches.includes(branchName);

      // Create worktree (git worktree is typically fast)
      if (branchExists) {
        // Branch exists, just add worktree pointing to it
        using proc = execAsync(
          `git -C "${projectPath}" worktree add "${workspacePath}" "${branchName}"`
        );
        await proc.result;
      } else {
        // Branch doesn't exist, create it from trunk
        using proc = execAsync(
          `git -C "${projectPath}" worktree add -b "${branchName}" "${workspacePath}" "${trunkBranch}"`
        );
        await proc.result;
      }

      initLogger.logStep("Worktree created successfully");

      // Pull latest from origin (best-effort, non-blocking on failure)
      await this.pullLatestFromOrigin(workspacePath, trunkBranch, initLogger);

      return { success: true, workspacePath };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Fetch and rebase on latest origin/<trunkBranch>
   * Best-effort operation - logs status but doesn't fail workspace creation
   */
  private async pullLatestFromOrigin(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger
  ): Promise<void> {
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

      // Fetch the trunk branch from origin
      using fetchProc = execAsync(`git -C "${workspacePath}" fetch origin "${trunkBranch}"`);
      await fetchProc.result;

      initLogger.logStep("Fast-forward merging...");

      // Attempt fast-forward merge from origin/<trunkBranch>
      try {
        using mergeProc = execAsync(
          `git -C "${workspacePath}" merge --ff-only "origin/${trunkBranch}"`
        );
        await mergeProc.result;
        initLogger.logStep("Fast-forwarded to latest origin successfully");
      } catch (mergeError) {
        // Fast-forward not possible (diverged branches) - just warn
        const errorMsg = getErrorMessage(mergeError);
        initLogger.logStderr(`Note: Fast-forward skipped (${errorMsg}), using local branch state`);
      }
    } catch (error) {
      // Fetch failed - log and continue (common for repos without remote)
      const errorMsg = getErrorMessage(error);
      initLogger.logStderr(
        `Note: Could not fetch from origin (${errorMsg}), using local branch state`
      );
    }
  }

  async initWorkspace(params: WorkspaceInitParams): Promise<WorkspaceInitResult> {
    const { projectPath, branchName, workspacePath, initLogger } = params;

    try {
      // Run .mux/init hook if it exists
      // Note: runInitHook calls logComplete() internally if hook exists
      const hookExists = await checkInitHookExists(projectPath);
      if (hookExists) {
        const muxEnv = getMuxEnv(projectPath, "worktree", branchName);
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
    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    // Compute workspace paths using canonical method
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    const newPath = this.getWorkspacePath(projectPath, newName);

    try {
      // Move the worktree directory (updates git's internal worktree metadata)
      using moveProc = execAsync(`git -C "${projectPath}" worktree move "${oldPath}" "${newPath}"`);
      await moveProc.result;

      // Rename the git branch to match the new workspace name
      // In mux, branch name and workspace name are always kept in sync.
      // Run from the new worktree path since that's where the branch is checked out.
      // Best-effort: ignore errors (e.g., branch might have a different name in test scenarios).
      try {
        using branchProc = execAsync(`git -C "${newPath}" branch -m "${oldName}" "${newName}"`);
        await branchProc.result;
      } catch {
        // Branch rename failed - this is fine, the directory was still moved
        // This can happen if the branch name doesn't match the old directory name
      }

      return { success: true, oldPath, newPath };
    } catch (error) {
      return { success: false, error: `Failed to rename workspace: ${getErrorMessage(error)}` };
    }
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    _abortSignal?: AbortSignal
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Note: _abortSignal ignored for local operations (fast, no need for cancellation)
    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    // In-place workspaces are identified by projectPath === workspaceName
    // These are direct workspace directories (e.g., CLI/benchmark sessions), not git worktrees
    const isInPlace = projectPath === workspaceName;
    const shouldDeleteBranch = !isInPlace && workspaceName.startsWith("agent_");

    const tryDeleteBranch = async () => {
      if (!shouldDeleteBranch) return;
      const deleteFlag = force ? "-D" : "-d";
      try {
        using deleteProc = execAsync(
          `git -C "${projectPath}" branch ${deleteFlag} "${workspaceName}"`
        );
        await deleteProc.result;
      } catch (error) {
        // Best-effort: workspace deletion should not fail just because branch cleanup failed.
        log.debug("Failed to delete git branch after removing worktree", {
          projectPath,
          workspaceName,
          error: getErrorMessage(error),
        });
      }
    };

    // Compute workspace path using the canonical method
    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);

    // Check if directory exists - if not, operation is idempotent
    try {
      await fsPromises.access(deletedPath);
    } catch {
      // Directory doesn't exist - operation is idempotent
      // For standard worktrees, prune stale git records (best effort)
      if (!isInPlace) {
        try {
          using pruneProc = execAsync(`git -C "${projectPath}" worktree prune`);
          await pruneProc.result;
        } catch {
          // Ignore prune errors - directory is already deleted, which is the goal
        }
      }

      // Best-effort: if this looks like an agent workspace, also delete the branch.
      await tryDeleteBranch();
      return { success: true, deletedPath };
    }

    // For in-place workspaces, there's no worktree to remove
    // Just return success - the workspace directory itself should not be deleted
    // as it may contain the user's actual project files
    if (isInPlace) {
      return { success: true, deletedPath };
    }

    try {
      // Use git worktree remove to delete the worktree
      // This updates git's internal worktree metadata correctly
      // Only use --force if explicitly requested by the caller
      const forceFlag = force ? " --force" : "";
      using proc = execAsync(
        `git -C "${projectPath}" worktree remove${forceFlag} "${deletedPath}"`
      );
      await proc.result;

      // Best-effort: if this looks like an agent workspace, also delete the branch.
      await tryDeleteBranch();
      return { success: true, deletedPath };
    } catch (error) {
      const message = getErrorMessage(error);

      // Check if the error is due to missing/stale worktree
      const normalizedError = message.toLowerCase();
      const looksLikeMissingWorktree =
        normalizedError.includes("not a working tree") ||
        normalizedError.includes("does not exist") ||
        normalizedError.includes("no such file");

      if (looksLikeMissingWorktree) {
        // Worktree records are stale - prune them
        try {
          using pruneProc = execAsync(`git -C "${projectPath}" worktree prune`);
          await pruneProc.result;
        } catch {
          // Ignore prune errors
        }
        // Treat as success - workspace is gone (idempotent)
        await tryDeleteBranch();
        return { success: true, deletedPath };
      }

      // If force is enabled and git worktree remove failed, fall back to rm -rf
      // This handles edge cases like submodules where git refuses to delete
      if (force) {
        try {
          // Prune git's worktree records first (best effort)
          try {
            using pruneProc = execAsync(`git -C "${projectPath}" worktree prune`);
            await pruneProc.result;
          } catch {
            // Ignore prune errors - we'll still try rm -rf
          }

          // Force delete the directory (use bash shell for rm -rf on Windows)
          // Convert to POSIX path for Git Bash compatibility on Windows
          using rmProc = execAsync(`rm -rf "${toPosixPath(deletedPath)}"`, {
            shell: getBashPath(),
          });
          await rmProc.result;

          // Best-effort: if this looks like an agent workspace, also delete the branch.
          await tryDeleteBranch();
          return { success: true, deletedPath };
        } catch (rmError) {
          return {
            success: false,
            error: `Failed to remove worktree via git and rm: ${getErrorMessage(rmError)}`,
          };
        }
      }

      // force=false - return the git error without attempting rm -rf
      return { success: false, error: `Failed to remove worktree: ${message}` };
    }
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger } = params;

    // Get source workspace path
    const sourceWorkspacePath = this.getWorkspacePath(projectPath, sourceWorkspaceName);

    // Get current branch from source workspace
    try {
      using proc = execAsync(`git -C "${sourceWorkspacePath}" branch --show-current`);
      const { stdout } = await proc.result;
      const sourceBranch = stdout.trim();

      if (!sourceBranch) {
        return {
          success: false,
          error: "Failed to detect branch in source workspace",
        };
      }

      // Use createWorkspace with sourceBranch as trunk to fork from source branch
      const createResult = await this.createWorkspace({
        projectPath,
        branchName: newWorkspaceName,
        trunkBranch: sourceBranch, // Fork from source branch instead of main/master
        directoryName: newWorkspaceName,
        initLogger,
      });

      if (!createResult.success || !createResult.workspacePath) {
        return {
          success: false,
          error: createResult.error ?? "Failed to create workspace",
        };
      }

      return {
        success: true,
        workspacePath: createResult.workspacePath,
        sourceBranch,
      };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }
}
