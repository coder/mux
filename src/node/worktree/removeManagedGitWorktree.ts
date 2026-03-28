import * as fsPromises from "fs/promises";
import { getErrorMessage } from "@/common/utils/errors";
import { execFileAsync } from "@/node/utils/disposableExec";
import { GIT_NO_HOOKS_ENV } from "@/node/utils/gitNoHooksEnv";

const MISSING_WORKTREE_ERROR_PATTERNS = ["not a working tree", "does not exist", "no such file"];

function isMissingWorktreeError(message: string): boolean {
  const normalizedError = message.toLowerCase();
  return MISSING_WORKTREE_ERROR_PATTERNS.some((pattern) => normalizedError.includes(pattern));
}

async function pruneWorktreesBestEffort(projectPath: string): Promise<void> {
  try {
    using pruneProc = execFileAsync("git", ["-C", projectPath, "worktree", "prune"], {
      env: GIT_NO_HOOKS_ENV,
    });
    await pruneProc.result;
  } catch {
    // Ignore prune errors during best-effort cleanup.
  }
}

export async function removeManagedGitWorktree(
  projectPath: string,
  worktreePath: string
): Promise<void> {
  try {
    await fsPromises.access(worktreePath);
  } catch {
    await pruneWorktreesBestEffort(projectPath);
    return;
  }

  try {
    using removeProc = execFileAsync(
      "git",
      ["-C", projectPath, "worktree", "remove", "--force", worktreePath],
      {
        env: GIT_NO_HOOKS_ENV,
      }
    );
    await removeProc.result;
  } catch (error) {
    if (!isMissingWorktreeError(getErrorMessage(error))) {
      throw error;
    }

    await pruneWorktreesBestEffort(projectPath);
  }
}
