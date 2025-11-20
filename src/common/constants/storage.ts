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
 * Helper to create a thinking level storage key for a workspace
 * Format: "thinkingLevel:{workspaceId}"
 */
export const getThinkingLevelKey = (workspaceId: string): string => `thinkingLevel:${workspaceId}`;

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
 * Get the localStorage key for the last active thinking level used for a model
 * Stores only active levels ("low" | "medium" | "high"), never "off"
 * Format: "lastThinkingByModel:{modelName}"
 */
export function getLastThinkingByModelKey(modelName: string): string {
  return `lastThinkingByModel:${modelName}`;
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
 * Stores the last successfully used runtime config when creating a workspace
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
 * Get the localStorage key for unified Review search state per workspace
 * Stores: { input: string, useRegex: boolean, matchCase: boolean }
 * Format: "reviewSearchState:{workspaceId}"
 */
export function getReviewSearchStateKey(workspaceId: string): string {
  return `reviewSearchState:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction enabled preference per workspace
 * Format: "autoCompaction:enabled:{workspaceId}"
 */
export function getAutoCompactionEnabledKey(workspaceId: string): string {
  return `autoCompaction:enabled:${workspaceId}`;
}

/**
 * Get the localStorage key for auto-compaction threshold percentage per workspace
 * Format: "autoCompaction:threshold:{workspaceId}"
 */
export function getAutoCompactionThresholdKey(workspaceId: string): string {
  return `autoCompaction:threshold:${workspaceId}`;
}

/**
 * List of workspace-scoped key functions that should be copied on fork and deleted on removal
 */
const PERSISTENT_WORKSPACE_KEY_FUNCTIONS: Array<(workspaceId: string) => string> = [
  getModelKey,
  getInputKey,
  getModeKey,
  getThinkingLevelKey,
  getAutoRetryKey,
  getRetryStateKey,
  getReviewExpandStateKey,
  getFileTreeExpandStateKey,
  getReviewSearchStateKey,
  getAutoCompactionEnabledKey,
  getAutoCompactionThresholdKey,
];

/**
 * Additional ephemeral keys to delete on workspace removal (not copied on fork)
 */
const EPHEMERAL_WORKSPACE_KEY_FUNCTIONS: Array<(workspaceId: string) => string> = [
  getCancelledCompactionKey,
];

/**
 * Copy all workspace-specific localStorage keys from source to destination workspace
 * This includes: model, input, mode, thinking level, auto-retry, retry state, review expand state, file tree expand state
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
