export const TASK_TERMINATION_TOOL_TIMEOUT_MS = 5 * 60 * 1000;
export const TASK_TERMINATION_STOP_STREAM_TIMEOUT_MS = 20 * 1000;
export const TASK_TERMINATION_WORKSPACE_REMOVE_TIMEOUT_MS = 2 * 60 * 1000;
export const WORKTREE_DELETE_GIT_TIMEOUT_MS = 60 * 1000;

/**
 * Backup git operations run behind a UI button, and a blackholed remote makes a network git
 * command hang rather than fail, so without this a Validate, Preview, Push, or Restore stays
 * busy with no way to recover. Generous because a first clone of a large dotfiles repository
 * is legitimately slow.
 */
export const BACKUP_GIT_TIMEOUT_MS = 5 * 60 * 1000;
