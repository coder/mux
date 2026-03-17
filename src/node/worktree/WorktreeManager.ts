import * as fsPromises from "fs/promises";
import * as path from "path";
import type {
  WorkspaceCreationResult,
  WorkspaceForkParams,
  WorkspaceForkResult,
  InitLogger,
} from "@/node/runtime/Runtime";
import { listLocalBranches, cleanStaleLock, getCurrentBranch } from "@/node/git";
import { execAsync, execFileAsync } from "@/node/utils/disposableExec";
import { getBashPath } from "@/node/utils/main/bashPath";
import { getProjectName } from "@/node/utils/runtime/helpers";
import { getErrorMessage } from "@/common/utils/errors";
import { shellQuote } from "@/common/utils/shell";
import { expandTilde } from "@/node/runtime/tildeExpansion";
import { toPosixPath } from "@/node/utils/paths";
import { log } from "@/node/services/log";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";
import { syncLocalGitSubmodules } from "@/node/runtime/submoduleSync";
import { syncMuxignoreFiles } from "./muxignore";

type GitExecOptions = { env: Record<string, string> } | undefined;

const PROTECTED_BRANCH_NAMES = ["main", "master", "trunk", "develop", "default"];
const MISSING_WORKTREE_ERROR_PATTERNS = ["not a working tree", "does not exist", "no such file"];

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

  private getGitExecOptions(trusted?: boolean): GitExecOptions {
    return trusted ? undefined : { env: GIT_NO_HOOKS_ENV };
  }

  private async pruneWorktreesBestEffort(
    projectPath: string,
    noHooksEnv: GitExecOptions
  ): Promise<void> {
    try {
      using pruneProc = execFileAsync("git", ["-C", projectPath, "worktree", "prune"], noHooksEnv);
      await pruneProc.result;
    } catch {
      // Ignore prune errors during cleanup/idempotent flows.
    }
  }

  private async forceRemoveWorkspaceDirectory(workspacePath: string): Promise<void> {
    // Use bash for rm -rf on Windows; shellQuote prevents injection from malicious paths.
    using rmProc = execAsync(`rm -rf ${shellQuote(toPosixPath(workspacePath))}`, {
      shell: getBashPath(),
    });
    await rmProc.result;
  }

  async createWorkspace(params: {
    projectPath: string;
    branchName: string;
    trunkBranch: string;
    initLogger: InitLogger;
    abortSignal?: AbortSignal;
    env?: Record<string, string>;
    trusted?: boolean;
  }): Promise<WorkspaceCreationResult> {
    const { projectPath, branchName, trunkBranch, initLogger } = params;
    // Disable git hooks for untrusted projects (prevents post-checkout execution)
    const noHooksEnv = this.getGitExecOptions(params.trusted);
    const workspacePath = this.getWorkspacePath(projectPath, branchName);
    let worktreeCreated = false;
    let createdBranch = false;

    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    try {
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
      const fetchedOrigin = await this.fetchOriginTrunk(
        projectPath,
        trunkBranch,
        initLogger,
        noHooksEnv
      );

      // Determine best base for new branches: use origin if local can fast-forward to it,
      // otherwise preserve local state (user may have unpushed work)
      const shouldUseOrigin =
        fetchedOrigin && (await this.canFastForwardToOrigin(projectPath, trunkBranch, initLogger));

      // Create worktree (git worktree is typically fast)
      if (branchExists) {
        // Branch exists, just add worktree pointing to it
        using proc = execFileAsync(
          "git",
          ["-C", projectPath, "worktree", "add", workspacePath, branchName],
          noHooksEnv
        );
        await proc.result;
      } else {
        // Branch doesn't exist, create from the best available base:
        // - origin/<trunk> if local is behind/equal (ensures fresh starting point)
        // - local <trunk> if local is ahead/diverged (preserves user's work)
        const newBranchBase = shouldUseOrigin ? `origin/${trunkBranch}` : trunkBranch;
        using proc = execFileAsync(
          "git",
          ["-C", projectPath, "worktree", "add", "-b", branchName, workspacePath, newBranchBase],
          noHooksEnv
        );
        await proc.result;
        createdBranch = true;
      }
      worktreeCreated = true;

      initLogger.logStep("Worktree created successfully");

      // Sync gitignored files declared in .muxignore (e.g. .env)
      // before init hooks run so they have access to secrets/config
      initLogger.logStep("Syncing .muxignore files...");
      await syncMuxignoreFiles(projectPath, workspacePath);

      // For existing branches, fast-forward to latest origin (best-effort)
      // Only if local can fast-forward (preserves unpushed work)
      if (shouldUseOrigin && branchExists) {
        await this.fastForwardToOrigin(workspacePath, trunkBranch, initLogger, noHooksEnv);
      }

      // Worktree creation is responsible for materializing the checkout completely.
      // Skills, docs, and other repo-managed files may live inside submodules, so make
      // them available before any runtime-specific provisioning or init hooks run.
      await syncLocalGitSubmodules({
        workspacePath,
        initLogger,
        abortSignal: params.abortSignal,
        env: params.env,
        trusted: params.trusted,
      });

      return { success: true, workspacePath };
    } catch (error) {
      const errorMessage = getErrorMessage(error);

      if (!worktreeCreated) {
        return {
          success: false,
          error: errorMessage,
        };
      }

      try {
        await this.rollbackFailedWorkspaceCreation({
          projectPath,
          workspacePath,
          branchName,
          createdBranch,
          trusted: params.trusted,
        });
        return {
          success: false,
          error: errorMessage,
        };
      } catch (rollbackError) {
        return {
          success: false,
          error: `${errorMessage} (rollback failed: ${getErrorMessage(rollbackError)})`,
        };
      }
    }
  }

  private async rollbackFailedWorkspaceCreation(args: {
    projectPath: string;
    workspacePath: string;
    branchName: string;
    createdBranch: boolean;
    trusted?: boolean;
  }): Promise<void> {
    const noHooksEnv = this.getGitExecOptions(args.trusted);

    try {
      using removeProc = execFileAsync(
        "git",
        ["-C", args.projectPath, "worktree", "remove", "--force", args.workspacePath],
        noHooksEnv
      );
      await removeProc.result;
    } catch {
      // If git refuses to remove a partially-initialized worktree (for example because a
      // submodule checkout left extra files behind), fall back to pruning metadata and
      // deleting the directory so retries do not get stuck behind a stale collision.
      await this.pruneWorktreesBestEffort(args.projectPath, noHooksEnv);
      await this.forceRemoveWorkspaceDirectory(args.workspacePath);
    }

    // Best-effort cleanup - branch deletion below will still refuse if metadata remains.
    await this.pruneWorktreesBestEffort(args.projectPath, noHooksEnv);

    if (!args.createdBranch) {
      return;
    }

    using deleteProc = execFileAsync(
      "git",
      ["-C", args.projectPath, "branch", "-D", args.branchName],
      noHooksEnv
    );
    await deleteProc.result;
  }

  /**
   * Fetch trunk branch from origin before worktree creation.
   * Returns true if fetch succeeded (origin is available for branching).
   */
  private async fetchOriginTrunk(
    projectPath: string,
    trunkBranch: string,
    initLogger: InitLogger,
    noHooksEnv?: { env: Record<string, string> }
  ): Promise<boolean> {
    try {
      initLogger.logStep(`Fetching latest from origin/${trunkBranch}...`);

      using fetchProc = execFileAsync(
        "git",
        ["-C", projectPath, "fetch", "origin", trunkBranch],
        noHooksEnv
      );
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
      using proc = execFileAsync("git", [
        "-C",
        projectPath,
        "merge-base",
        "--is-ancestor",
        trunkBranch,
        `origin/${trunkBranch}`,
      ]);
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
    initLogger: InitLogger,
    noHooksEnv?: { env: Record<string, string> }
  ): Promise<void> {
    try {
      initLogger.logStep("Fast-forward merging...");

      using mergeProc = execFileAsync(
        "git",
        ["-C", workspacePath, "merge", "--ff-only", `origin/${trunkBranch}`],
        noHooksEnv
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
    newName: string,
    trusted?: boolean
  ): Promise<
    { success: true; oldPath: string; newPath: string } | { success: false; error: string }
  > {
    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    // Disable git hooks for untrusted projects
    const noHooksEnv = this.getGitExecOptions(trusted);

    // Compute workspace paths using canonical method
    const oldPath = this.getWorkspacePath(projectPath, oldName);
    const newPath = this.getWorkspacePath(projectPath, newName);

    try {
      // Move the worktree directory (updates git's internal worktree metadata)
      using moveProc = execFileAsync(
        "git",
        ["-C", projectPath, "worktree", "move", oldPath, newPath],
        noHooksEnv
      );
      await moveProc.result;

      // Rename the git branch to match the new workspace name
      // In mux, branch name and workspace name are always kept in sync.
      // Run from the new worktree path since that's where the branch is checked out.
      // Best-effort: ignore errors (e.g., branch might have a different name in test scenarios).
      try {
        using branchProc = execFileAsync(
          "git",
          ["-C", newPath, "branch", "-m", oldName, newName],
          noHooksEnv
        );
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

  async canDeleteWorkspaceWithoutForce(
    projectPath: string,
    workspaceName: string,
    trusted?: boolean
  ): Promise<{ success: true } | { success: false; error: string }> {
    // Match deleteWorkspace() semantics so preflight stays idempotent and non-destructive.
    cleanStaleLock(projectPath);

    const noHooksEnv = this.getGitExecOptions(trusted);
    const workspacePath = this.getWorkspacePath(projectPath, workspaceName);
    const isInPlace = projectPath === workspaceName;

    try {
      await fsPromises.access(workspacePath);
    } catch {
      return { success: true };
    }

    if (isInPlace) {
      return { success: true };
    }

    const resolvedWorkspacePath = path.resolve(workspacePath);

    try {
      using worktreeListProc = execFileAsync(
        "git",
        ["-C", projectPath, "worktree", "list", "--porcelain"],
        noHooksEnv
      );
      const { stdout } = await worktreeListProc.result;
      const workspaceBlock = stdout.split("\n\n").find((block) => {
        return block.split("\n").some((line) => {
          if (!line.startsWith("worktree ")) {
            return false;
          }
          return path.resolve(line.slice("worktree ".length).trim()) === resolvedWorkspacePath;
        });
      });

      if (!workspaceBlock) {
        return {
          success: false,
          error: `Workspace is not registered as a git worktree: ${workspacePath}`,
        };
      }

      const isLocked = workspaceBlock.split("\n").some((line) => {
        const trimmed = line.trim();
        return trimmed === "locked" || trimmed.startsWith("locked ");
      });
      if (isLocked) {
        return {
          success: false,
          error: "Workspace is locked and requires force removal",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to inspect worktree before deletion: ${getErrorMessage(error)}`,
      };
    }

    try {
      using statusProc = execFileAsync(
        "git",
        ["-C", workspacePath, "status", "--porcelain", "--untracked-files=all"],
        noHooksEnv
      );
      const { stdout } = await statusProc.result;
      if (stdout.trim().length > 0) {
        return {
          success: false,
          error: "Workspace has uncommitted or untracked changes",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: `Failed to inspect worktree before deletion: ${getErrorMessage(error)}`,
      };
    }

    return { success: true };
  }

  async deleteWorkspace(
    projectPath: string,
    workspaceName: string,
    force: boolean,
    trusted?: boolean
  ): Promise<{ success: true; deletedPath: string } | { success: false; error: string }> {
    // Clean up stale lock before git operations on main repo
    cleanStaleLock(projectPath);

    // Disable git hooks for untrusted projects
    const noHooksEnv = this.getGitExecOptions(trusted);

    // In-place workspaces are identified by projectPath === workspaceName.
    // These are direct workspace directories (e.g., CLI/benchmark sessions), not git worktrees.
    const isInPlace = projectPath === workspaceName;
    const deletedPath = this.getWorkspacePath(projectPath, workspaceName);
    const branchDeleteArgs = {
      projectPath,
      workspaceName,
      force,
      isInPlace,
      noHooksEnv,
    };

    try {
      await fsPromises.access(deletedPath);
    } catch {
      if (!isInPlace) {
        await this.pruneWorktreesBestEffort(projectPath, noHooksEnv);
      }

      await this.deleteWorkspaceBranchIfSafe(branchDeleteArgs);
      return { success: true, deletedPath };
    }

    // For in-place workspaces, there's no worktree to remove.
    // The workspace directory itself is the user's real project checkout.
    if (isInPlace) {
      return { success: true, deletedPath };
    }

    try {
      await this.removeGitWorktree(projectPath, deletedPath, force, noHooksEnv);
      await this.deleteWorkspaceBranchIfSafe(branchDeleteArgs);
      return { success: true, deletedPath };
    } catch (error) {
      const message = getErrorMessage(error);

      if (this.isMissingWorktreeError(message)) {
        await this.pruneWorktreesBestEffort(projectPath, noHooksEnv);
        await this.deleteWorkspaceBranchIfSafe(branchDeleteArgs);
        return { success: true, deletedPath };
      }

      if (!force) {
        return { success: false, error: `Failed to remove worktree: ${message}` };
      }

      try {
        await this.pruneWorktreesBestEffort(projectPath, noHooksEnv);
        await this.forceRemoveWorkspaceDirectory(deletedPath);
        await this.deleteWorkspaceBranchIfSafe(branchDeleteArgs);
        return { success: true, deletedPath };
      } catch (rmError) {
        return {
          success: false,
          error: `Failed to remove worktree via git and rm: ${getErrorMessage(rmError)}`,
        };
      }
    }
  }

  private async deleteWorkspaceBranchIfSafe(args: {
    projectPath: string;
    workspaceName: string;
    force: boolean;
    isInPlace: boolean;
    noHooksEnv: GitExecOptions;
  }): Promise<void> {
    // For git worktree workspaces, workspaceName is the branch name.
    // Now that archiving exists, deleting a workspace should also delete its local branch by default.
    if (args.isInPlace) {
      return;
    }

    const branchToDelete = args.workspaceName.trim();
    if (!branchToDelete) {
      log.debug("Skipping git branch deletion: empty workspace name", {
        projectPath: args.projectPath,
        workspaceName: args.workspaceName,
      });
      return;
    }

    let localBranches: string[];
    try {
      localBranches = await listLocalBranches(args.projectPath);
    } catch (error) {
      log.debug("Failed to list local branches; skipping branch deletion", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
        error: getErrorMessage(error),
      });
      return;
    }

    if (!localBranches.includes(branchToDelete)) {
      log.debug("Skipping git branch deletion: branch does not exist locally", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
      });
      return;
    }

    const protectedBranches = await this.getProtectedBranches(
      args.projectPath,
      localBranches,
      args.noHooksEnv
    );
    if (protectedBranches.has(branchToDelete)) {
      log.debug("Skipping git branch deletion: protected branch", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
      });
      return;
    }

    if (
      await this.isBranchCheckedOutByWorktree(args.projectPath, branchToDelete, args.noHooksEnv)
    ) {
      log.debug("Skipping git branch deletion: branch still checked out by a worktree", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
      });
      return;
    }

    const deleteFlag = args.force ? "-D" : "-d";
    try {
      using deleteProc = execFileAsync(
        "git",
        ["-C", args.projectPath, "branch", deleteFlag, branchToDelete],
        args.noHooksEnv
      );
      await deleteProc.result;
    } catch (error) {
      // Best-effort: workspace deletion should not fail just because branch cleanup failed.
      log.debug("Failed to delete git branch after removing worktree", {
        projectPath: args.projectPath,
        workspaceName: branchToDelete,
        error: getErrorMessage(error),
      });
    }
  }

  private async getProtectedBranches(
    projectPath: string,
    localBranches: string[],
    noHooksEnv: GitExecOptions
  ): Promise<Set<string>> {
    const protectedBranches = new Set<string>(PROTECTED_BRANCH_NAMES);

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
      using originHeadProc = execFileAsync(
        "git",
        ["-C", projectPath, "symbolic-ref", "refs/remotes/origin/HEAD"],
        noHooksEnv
      );
      const { stdout } = await originHeadProc.result;
      const ref = stdout.trim();
      const prefix = "refs/remotes/origin/";
      if (ref.startsWith(prefix)) {
        protectedBranches.add(ref.slice(prefix.length));
      }
    } catch {
      // No origin/HEAD (or not a git repo) - ignore.
    }

    return protectedBranches;
  }

  private async isBranchCheckedOutByWorktree(
    projectPath: string,
    branchName: string,
    noHooksEnv: GitExecOptions
  ): Promise<boolean> {
    try {
      using worktreeProc = execFileAsync(
        "git",
        ["-C", projectPath, "worktree", "list", "--porcelain"],
        noHooksEnv
      );
      const { stdout } = await worktreeProc.result;
      const needle = `branch refs/heads/${branchName}`;
      return stdout.split("\n").some((line) => line.trim() === needle);
    } catch (error) {
      // If the worktree list fails, proceed anyway - git itself will refuse to delete a checked-out branch.
      log.debug("Failed to check worktree list before branch deletion; proceeding", {
        projectPath,
        workspaceName: branchName,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async removeGitWorktree(
    projectPath: string,
    workspacePath: string,
    force: boolean,
    noHooksEnv: GitExecOptions
  ): Promise<void> {
    const removeArgs = ["-C", projectPath, "worktree", "remove"];
    if (force) {
      removeArgs.push("--force");
    }
    removeArgs.push(workspacePath);

    using proc = execFileAsync("git", removeArgs, noHooksEnv);
    await proc.result;
  }

  private isMissingWorktreeError(message: string): boolean {
    const normalizedError = message.toLowerCase();
    return MISSING_WORKTREE_ERROR_PATTERNS.some((pattern) => normalizedError.includes(pattern));
  }

  async forkWorkspace(params: WorkspaceForkParams): Promise<WorkspaceForkResult> {
    const { projectPath, sourceWorkspaceName, newWorkspaceName, initLogger } = params;

    // Get source workspace path
    const sourceWorkspacePath = this.getWorkspacePath(projectPath, sourceWorkspaceName);

    // Get current branch from source workspace
    try {
      using proc = execFileAsync("git", ["-C", sourceWorkspacePath, "branch", "--show-current"]);
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
        abortSignal: params.abortSignal,
        env: params.env,
        trusted: params.trusted,
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
