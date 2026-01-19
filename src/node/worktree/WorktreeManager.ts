import * as fsPromises from "fs/promises";
import * as path from "path";
import type {
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "@/node/runtime/Runtime";
import { listLocalBranches, cleanStaleLock, getCurrentBranch } from "@/node/git";
import { execAsync } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { toPosixPath } from "@/node/utils/paths";
import { log } from "@/node/services/log";

export class WorktreeManager {
  private readonly srcBaseDir: string;

  constructor(srcBaseDir: string) {
    // Expand tilde to actual home directory path for local file system operations
    this.srcBaseDir = expandTilde(srcBaseDir);
  }

  getWorkspacePath(projectPath: string, workspaceName: string): string {
    const projectName = getProjectName(projectPath);
    return path.join(this.srcBaseDir, projectName, workspaceName);
  }

  async createWorkspace(params: {
    projectPath: string;
    branchName: string;
    trunkBranch: string;
    initLogger: InitLogger;
  }): Promise<WorkspaceCreationResult> {
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

      // Fetch origin before creating worktree (best-effort)
      // This ensures new branches start from the latest origin state
      const fetchedOrigin = await this.fetchOriginTrunk(projectPath, trunkBranch, initLogger);

      // Determine best base for new branches: use origin if local can fast-forward to it,
      // otherwise preserve local state (user may have unpushed work)
      const shouldUseOrigin =
        fetchedOrigin && (await this.canFastForwardToOrigin(projectPath, trunkBranch, initLogger));

      // Create worktree (git worktree is typically fast)
      if (branchExists) {
        // Branch exists, just add worktree pointing to it
        using proc = execAsync(
          `git -C "${projectPath}" worktree add "${workspacePath}" "${branchName}"`
        );
        await proc.result;
      } else {
        // Branch doesn't exist, create from the best available base:
        // - origin/<trunk> if local is behind/equal (ensures fresh starting point)
        // - local <trunk> if local is ahead/diverged (preserves user's work)
        const newBranchBase = shouldUseOrigin ? `origin/${trunkBranch}` : trunkBranch;
        using proc = execAsync(
          `git -C "${projectPath}" worktree add -b "${branchName}" "${workspacePath}" "${newBranchBase}"`
        );
        await proc.result;
      }

      initLogger.logStep("Worktree created successfully");

      // For existing branches, fast-forward to latest origin (best-effort)
      // Only if local can fast-forward (preserves unpushed work)
      if (shouldUseOrigin && branchExists) {
        await this.fastForwardToOrigin(workspacePath, trunkBranch, initLogger);
      }

      return { success: true, workspacePath };
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * Fetch trunk branch from origin before worktree creation.
   * Returns true if fetch succeeded (origin is available for branching).
   */
  private async fetchOriginTrunk(
    projectPath: string,
    trunkBranch: string,
    initLogger: InitLogger
  ): Promise<boolean> {
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

      using fetchProc = execAsync(`git -C "${projectPath}" fetch origin "${trunkBranch}"`);
      await fetchProc.result;

      initLogger.logStep("Fetched latest from origin");
      return true;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      // Branch doesn't exist on origin (common for subagent local-only branches)
      if (errorMsg.includes("couldn't find remote ref")) {
        initLogger.logStep(`Branch "${trunkBranch}" not found on origin; using local state.`);
      } else {
        initLogger.logStderr(
          `Note: Could not fetch from origin (${errorMsg}), using local branch state`
        );
      }
      return false;
    }
  }

  /**
   * Check if local trunk can fast-forward to origin/<trunk>.
   * Returns true if local is behind or equal to origin (safe to use origin).
   * Returns false if local is ahead or diverged (preserve local state).
   */
  private async canFastForwardToOrigin(
    projectPath: string,
    trunkBranch: string,
    initLogger: InitLogger
  ): Promise<boolean> {
    try {
      // Check if local trunk is an ancestor of origin/trunk
      // Exit code 0 = local is ancestor (can fast-forward), non-zero = cannot
      using proc = execAsync(
        `git -C "${projectPath}" merge-base --is-ancestor "${trunkBranch}" "origin/${trunkBranch}"`
      );
      await proc.result;
      return true; // Local is behind or equal to origin
    } catch {
      // Local is ahead or diverged - preserve local state
      initLogger.logStderr(
        `Note: Local ${trunkBranch} is ahead of or diverged from origin, using local state`
      );
      return false;
    }
  }

  /**
   * Fast-forward merge to latest origin/<trunkBranch> after checkout.
   * Best-effort operation for existing branches that may be behind origin.
   */
  private async fastForwardToOrigin(
    workspacePath: string,
    trunkBranch: string,
    initLogger: InitLogger
  ): Promise<void> {
    try {
      initLogger.logStep("Fast-forward merging...");

      using mergeProc = execAsync(
        `git -C "${workspacePath}" merge --ff-only "origin/${trunkBranch}"`
      );
      await mergeProc.result;
      initLogger.logStep("Fast-forwarded to latest origin successfully");
    } catch (mergeError) {
      // Fast-forward not possible (diverged branches) - just warn
      const errorMsg = getErrorMessage(mergeError);
      initLogger.logStderr(`Note: Fast-forward failed (${errorMsg}), using local branch state`);
    }
  }

  async renameWorkspace(
    projectPath: string,
    oldName: string,
    newName: string
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
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
    force: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    // In-place workspaces are identified by projectPath === workspaceName
    // These are direct workspace directories (e.g., CLI/benchmark sessions), not git worktrees
    const isInPlace = projectPath === workspaceName;

    // For git worktree workspaces, workspaceName is the branch name.
    // Now that archiving exists, deleting a workspace should also delete its local branch by default.
    const shouldDeleteBranch = !isInPlace;

    const tryDeleteBranch = async () => {
      if (!shouldDeleteBranch) return;

      const branchToDelete = workspaceName.trim();
      if (!branchToDelete) {
        log.debug("Skipping git branch deletion: empty workspace name", {
          projectPath,
          workspaceName,
        });
        return;
      }

      let localBranches: string[];
      try {
        localBranches = await listLocalBranches(projectPath);
      } catch (error) {
        log.debug("Failed to list local branches; skipping branch deletion", {
          projectPath,
          workspaceName: branchToDelete,
          error: getErrorMessage(error),
        });
        return;
      }

      if (!localBranches.includes(branchToDelete)) {
        log.debug("Skipping git branch deletion: branch does not exist locally", {
          projectPath,
          workspaceName: branchToDelete,
        });
        return;
      }

      // Never delete protected/trunk branches.
      const protectedBranches = new Set<string>(["main", "master", "trunk", "develop", "default"]);

      // If there's only one local branch, treat it as protected (likely trunk).
      if (localBranches.length === 1) {
        protectedBranches.add(localBranches[0]);
      }

      const currentBranch = await getCurrentBranch(projectPath);
      if (currentBranch) {
        protectedBranches.add(currentBranch);
      }

      // If origin/HEAD points at a local branch, also treat it as protected.
      try {
        using originHeadProc = execAsync(
          `git -C "${projectPath}" symbolic-ref refs/remotes/origin/HEAD`
        );
        const { stdout } = await originHeadProc.result;
        const ref = stdout.trim();
        const prefix = "refs/remotes/origin/";
        if (ref.startsWith(prefix)) {
          protectedBranches.add(ref.slice(prefix.length));
        }
      } catch {
        // No origin/HEAD (or not a git repo) - ignore
      }

      if (protectedBranches.has(branchToDelete)) {
        log.debug("Skipping git branch deletion: protected branch", {
          projectPath,
          workspaceName: branchToDelete,
        });
        return;
      }

      // Extra safety: don't delete a branch still checked out by any worktree.
      try {
        using worktreeProc = execAsync(`git -C "${projectPath}" worktree list --porcelain`);
        const { stdout } = await worktreeProc.result;
        const needle = `branch refs/heads/${branchToDelete}`;
        const isCheckedOut = stdout.split("\n").some((line) => line.trim() === needle);
        if (isCheckedOut) {
          log.debug("Skipping git branch deletion: branch still checked out by a worktree", {
            projectPath,
            workspaceName: branchToDelete,
          });
          return;
        }
      } catch (error) {
        // If the worktree list fails, proceed anyway - git itself will refuse to delete a checked-out branch.
        log.debug("Failed to check worktree list before branch deletion; proceeding", {
          projectPath,
          workspaceName: branchToDelete,
          error: getErrorMessage(error),
        });
      }

      const deleteFlag = force ? "-D" : "-d";
      try {
        using deleteProc = execAsync(
          `git -C "${projectPath}" branch ${deleteFlag} "${branchToDelete}"`
        );
        await deleteProc.result;
      } catch (error) {
        // Best-effort: workspace deletion should not fail just because branch cleanup failed.
        log.debug("Failed to delete git branch after removing worktree", {
          projectPath,
          workspaceName: branchToDelete,
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

      // Best-effort: also delete the local branch.
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

      // Best-effort: also delete the local branch.
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

          // Best-effort: also delete the local branch.
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
