/**
 * LocalStorage Key Constants and Helpers
 * These keys are used for persisting state in localStorage
 */

/**
 * Scope ID Helpers
 * These create consistent scope identifiers for storage keys
 */

/**
 * Get project-scoped ID for storage keys (e.g., model preference before workspace creation)
 * Format: "__project__/{projectPath}"
 * Uses "/" delimiter to safely handle projectPath values containing special characters
 */
export function getProjectScopeId(projectPath: string): string {
  return `__project__/${projectPath}`;
}

/**
 * Get pending workspace scope ID for storage keys (e.g., input text during workspace creation)
 * Format: "__pending__{projectPath}"
 */
export function getPendingScopeId(projectPath: string): string {
  return `__pending__${projectPath}`;
}

/**
 * Global scope ID for workspace-independent preferences
 */
export const GLOBAL_SCOPE_ID = "__global__";

/**
 * Get the localStorage key for the UI theme preference (global)
 * Format: "uiTheme"
 */
export const UI_THEME_KEY = "uiTheme";

/**
 * Get the localStorage key for the currently selected workspace (global)
 * Format: "selectedWorkspace"
 */
export const SELECTED_WORKSPACE_KEY = "selectedWorkspace";

/**
 * Get the localStorage key for expanded projects in sidebar (global)
 * Format: "expandedProjects"
 */
export const EXPANDED_PROJECTS_KEY = "expandedProjects";

/**
 * Get the localStorage key for cached MCP server test results (per project)
 * Format: "mcpTestResults:{projectPath}"
 * Stores: Record<serverName, CachedMCPTestResult>
 */
export function getMCPTestResultsKey(projectPath: string): string {
  return `mcpTestResults:${projectPath}`;
}

/**
 * Get the localStorage key for thinking level preference per scope (workspace/project).
 * Format: "thinkingLevel:{scopeId}"
 */
export function getThinkingLevelKey(scopeId: string): string {
  return `thinkingLevel:${scopeId}`;
}

/**
 * LEGACY: Get the localStorage key for thinking level preference per model (global).
 * Format: "thinkingLevel:model:{modelName}"
 *
 * Kept for one-time migration to per-workspace thinking.
 */
export function getThinkingLevelByModelKey(modelName: string): string {
  return `thinkingLevel:model:${modelName}`;
}

/**
 * Get the localStorage key for the user's preferred model for a workspace
 */
export function getModelKey(workspaceId: string): string {
  return `model:${workspaceId}`;
}

/**
 * Get the localStorage key for the input text for a workspace
 */
export function getInputKey(workspaceId: string): string {
  return `input:${workspaceId}`;
}

/**
 * Get the localStorage key for the input image attachments for a workspace.
 * Format: "inputImages:{scopeId}"
 *
 * Note: The input key functions accept any string scope ID. For normal workspaces
 * this is the workspaceId; for creation mode it's a pending scope ID.
 */
export function getInputImagesKey(scopeId: string): string {
  return `inputImages:${scopeId}`;
}

/**
 * Get the localStorage key for auto-retry preference for a workspace
 */
export function getAutoRetryKey(workspaceId: string): string {
  return `${workspaceId}-autoRetry`;
}

/**
 * Get the localStorage key for retry state for a workspace
 * Stores: { attempt, totalRetryTime, retryStartTime }
 */
export function getRetryStateKey(workspaceId: string): string {
  return `${workspaceId}-retryState`;
}

/**
 * Get storage key for cancelled compaction tracking.
 * Stores compaction-request user message ID to verify freshness across reloads.
 */
export function getCancelledCompactionKey(workspaceId: string): string {
  return `workspace:${workspaceId}:cancelled-compaction`;
}

/**
 * Get the localStorage key for the UI mode for a workspace
 * Format: "mode:{workspaceId}"
 */
export function getModeKey(workspaceId: string): string {
  return `mode:${workspaceId}`;
}

/**
 * Get the localStorage key for the default runtime for a project
 * Defaults to worktree if not set; can only be changed via the "Default for project" checkbox.
 * Format: "runtime:{projectPath}"
 */
export function getRuntimeKey(projectPath: string): string {
  return `runtime:${projectPath}`;
}

/**
 * Get the localStorage key for trunk branch preference for a project
 * Stores the last used trunk branch when creating a workspace
 * Format: "trunkBranch:{projectPath}"
 */
export function getTrunkBranchKey(projectPath: string): string {
  return `trunkBranch:${projectPath}`;
}

/**
 * Get the localStorage key for last SSH host preference for a project
 * Stores the last entered SSH host separately from runtime mode
 * so it persists when switching between runtime modes
 * Format: "lastSshHost:{projectPath}"
 */
export function getLastSshHostKey(projectPath: string): string {
  return `lastSshHost:${projectPath}`;
}

/**
 * Get the localStorage key for the preferred compaction model (global)
 * Format: "preferredCompactionModel"
 */
export const PREFERRED_COMPACTION_MODEL_KEY = "preferredCompactionModel";

/**
 * Get the localStorage key for vim mode preference (global)
 * Format: "vimEnabled"
 */
export const VIM_ENABLED_KEY = "vimEnabled";

/**
 * Git status indicator display mode (global)
 * Stores: "line-delta" | "divergence"
 */
export const GIT_STATUS_INDICATOR_MODE_KEY = "gitStatusIndicatorMode";

/**
 * Editor configuration for "Open in Editor" feature (global)
 * Format: "editorConfig"
 */
export const EDITOR_CONFIG_KEY = "editorConfig";

export type EditorType = "vscode" | "cursor" | "zed" | "custom";

export interface EditorConfig {
  editor: EditorType;
  customCommand?: string; // Only when editor='custom'
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  editor: "vscode",
};

/**
 * Tutorial state storage key (global)
 * Stores: { disabled: boolean, completed: { settings?: true, creation?: true, workspace?: true } }
 */
export const TUTORIAL_STATE_KEY = "tutorialState";

export type TutorialSequence = "settings" | "creation" | "workspace";

export interface TutorialState {
  disabled: boolean;
  completed: Partial<Record<TutorialSequence, true>>;
}

export const DEFAULT_TUTORIAL_STATE: TutorialState = {
  disabled: false,
  completed: {},
};

/**
 * Get the localStorage key for review (hunk read) state per workspace
 * Stores which hunks have been marked as read during code review
 * Format: "review-state:{workspaceId}"
 */
export function getReviewStateKey(workspaceId: string): string {
  return `review-state:${workspaceId}`;
}

/**
 * Get the localStorage key for hunk expand/collapse state in Review tab
 * Stores user's manual expand/collapse preferences per hunk
 * Format: "reviewExpandState:{workspaceId}"
 */
export function getReviewExpandStateKey(workspaceId: string): string {
  return `reviewExpandState:${workspaceId}`;
}

/**
 * Get the localStorage key for FileTree expand/collapse state in Review tab
 * Stores directory expand/collapse preferences per workspace
 * Format: "fileTreeExpandState:{workspaceId}"
 */
export function getFileTreeExpandStateKey(workspaceId: string): string {
  return `fileTreeExpandState:${workspaceId}`;
}

/**
 * Get the localStorage key for persisted agent status for a workspace
 * Stores the most recent successful status_set payload (emoji, message, url)
 * Format: "statusState:{workspaceId}"
 */
export function getStatusStateKey(workspaceId: string): string {
  return `statusState:${workspaceId}`;
}

/**
 * Right sidebar tab selection (global)
 * Format: "right-sidebar-tab"
 */
export const RIGHT_SIDEBAR_TAB_KEY = "right-sidebar-tab";

/**
 * Right sidebar hidden state (global, auto-collapse on small screens)
 * Format: "right-sidebar:hidden"
 */
export const RIGHT_SIDEBAR_COLLAPSED_KEY = "right-sidebar:hidden";

/**
 * Right sidebar width for Costs tab (global)
 * Format: "right-sidebar:width:costs"
 */
export const RIGHT_SIDEBAR_COSTS_WIDTH_KEY = "right-sidebar:width:costs";

/**
 * Right sidebar width for Review tab (global)
 * Reuses legacy key to preserve existing user preferences
 * Format: "review-sidebar-width"
 */
export const RIGHT_SIDEBAR_REVIEW_WIDTH_KEY = "review-sidebar-width";

/**
 * Get the localStorage key for unified Review search state per workspace
 * Stores: { input: string, useRegex: boolean, matchCase: boolean }
 * Format: "reviewSearchState:{workspaceId}"
 */
export function getReviewSearchStateKey(workspaceId: string): string {
  return `reviewSearchState:${workspaceId}`;
}

/**
 * Get the localStorage key for reviews per workspace
 * Stores: ReviewsState (reviews created from diff viewer - pending, attached, or checked)
 * Format: "reviews:{workspaceId}"
 */
export function getReviewsKey(workspaceId: string): string {
  return `reviews:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction enabled preference per workspace
 * Format: "autoCompaction:enabled:{workspaceId}"
 */
export function getAutoCompactionEnabledKey(workspaceId: string): string {
  return `autoCompaction:enabled:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction threshold percentage per model
 * Format: "autoCompaction:threshold:{model}"
 * Stored per-model because different models have different context windows
 */
export function getAutoCompactionThresholdKey(model: string): string {
  return `autoCompaction:threshold:${model}`;
}

/**
 * List of workspace-scoped key functions that should be copied on fork and deleted on removal
 */
const PERSISTENT_WORKSPACE_KEY_FUNCTIONS: Array<(workspaceId: string) => string> = [
  getModelKey,
  getInputKey,
  getInputImagesKey,
  getModeKey,
  getThinkingLevelKey,
  getAutoRetryKey,
  getRetryStateKey,
  getReviewStateKey,
  getReviewExpandStateKey,
  getFileTreeExpandStateKey,
  getReviewSearchStateKey,
  getReviewsKey,
  getAutoCompactionEnabledKey,
  getStatusStateKey,
  // Note: auto-compaction threshold is per-model, not per-workspace
];

/**
 * Additional ephemeral keys to delete on workspace removal (not copied on fork)
 */
const EPHEMERAL_WORKSPACE_KEY_FUNCTIONS: Array<(workspaceId: string) => string> = [
  getCancelledCompactionKey,
];

/**
 * Copy all workspace-specific localStorage keys from source to destination workspace.
 * Includes keys listed in PERSISTENT_WORKSPACE_KEY_FUNCTIONS (model, draft input text/images, etc).
 */
export function copyWorkspaceStorage(sourceWorkspaceId: string, destWorkspaceId: string): void {
  for (const getKey of PERSISTENT_WORKSPACE_KEY_FUNCTIONS) {
    const sourceKey = getKey(sourceWorkspaceId);
    const destKey = getKey(destWorkspaceId);
    const value = localStorage.getItem(sourceKey);
    if (value !== null) {
      localStorage.setItem(destKey, value);
    }
  }
}

/**
 * Delete all workspace-specific localStorage keys for a workspace
 * Should be called when a workspace is deleted to prevent orphaned data
 */
export function deleteWorkspaceStorage(workspaceId: string): void {
  const allKeyFunctions = [
    ...PERSISTENT_WORKSPACE_KEY_FUNCTIONS,
    ...EPHEMERAL_WORKSPACE_KEY_FUNCTIONS,
  ];

  for (const getKey of allKeyFunctions) {
    const key = getKey(workspaceId);
    localStorage.removeItem(key);
  }
}

/**
 * Migrate all workspace-specific localStorage keys from old to new workspace ID
 * Should be called when a workspace is renamed to preserve settings
 */
export function migrateWorkspaceStorage(oldWorkspaceId: string, newWorkspaceId: string): void {
  copyWorkspaceStorage(oldWorkspaceId, newWorkspaceId);
  deleteWorkspaceStorage(oldWorkspaceId);
}
