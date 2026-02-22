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
 * Get draft workspace scope ID for storage keys.
 *
 * This is used for UI-only workspace creation drafts so multiple pending drafts can
 * exist per project without colliding.
 *
 * Format: "__draft__/{projectPath}/{draftId}"
 */
export function getDraftScopeId(projectPath: string, draftId: string): string {
  return `__draft__/${projectPath}/${draftId}`;
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
 * LocalStorage key for the hidden Power Mode UI easter egg (global).
 */
export const POWER_MODE_ENABLED_KEY = "powerModeEnabled";

/**
 * Get the localStorage key for the last selected provider when adding custom models (global)
 * Format: "lastCustomModelProvider"
 */
export const LAST_CUSTOM_MODEL_PROVIDER_KEY = "lastCustomModelProvider";

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
 * LocalStorage key for UI-only workspace creation drafts.
 *
 * Value: Record<string, Array<{ draftId: string; sectionId: string | null; createdAt: number }>>
 * Keyed by projectPath.
 */
export const WORKSPACE_DRAFTS_BY_PROJECT_KEY = "workspaceDraftsByProject";

/**
 * LocalStorage keys for Mux Gateway routing preferences (global).
 *
 * Note: localStorage is origin-scoped (includes port), so these values are also
 * mirrored into ~/.mux/config.json for portability across server ports.
 */
export const GATEWAY_MODELS_KEY = "gateway-models"; // enabled model IDs (canonical)
export const GATEWAY_CONFIGURED_KEY = "gateway-available"; // synced from provider config
export const GATEWAY_ENABLED_KEY = "gateway-enabled"; // global on/off toggle

/**
 * Storage key for runtime enablement settings (shared via ~/.mux/config.json).
 */
export const RUNTIME_ENABLEMENT_KEY = "runtimeEnablement";

/**
 * Storage key for global default runtime selection (shared via ~/.mux/config.json).
 */
export const DEFAULT_RUNTIME_KEY = "defaultRuntime";

/**
 * Get the localStorage key for cached MCP server test results (per project)
 * Format: "mcpTestResults:{projectPath}"
 * Stores: Record<serverName, CachedMCPTestResult>
 */
export function getMCPTestResultsKey(projectPath: string): string {
  return `mcpTestResults:${projectPath}`;
}

/**
 * Get the localStorage key for cached archived workspaces per project
 * Format: "archivedWorkspaces:{projectPath}"
 * Stores: Array of workspace metadata objects (optimistic cache)
 */
export function getArchivedWorkspacesKey(projectPath: string): string {
  return `archivedWorkspaces:${projectPath}`;
}

/**
 * Get the localStorage key for archived workspaces expand/collapse state.
 * Format: "archivedWorkspacesExpanded:{projectPath}"
 * Stores: boolean (true = expanded)
 */
export function getArchivedWorkspacesExpandedKey(projectPath: string): string {
  return `archivedWorkspacesExpanded:${projectPath}`;
}

/**
 * Get the localStorage key for cached MCP servers per project
 * Format: "mcpServers:{projectPath}"
 * Stores: Record<serverName, MCPServerInfo> (optimistic cache)
 */
export function getMCPServersKey(projectPath: string): string {
  return `mcpServers:${projectPath}`;
}

/**
 * Get the localStorage key for thinking level preference per scope (workspace/project).
 * Format: "thinkingLevel:{scopeId}"
 */
export function getThinkingLevelKey(scopeId: string): string {
  return `thinkingLevel:${scopeId}`;
}

/**
 * Get the localStorage key for per-agent workspace AI overrides cache.
 * Format: "workspaceAiSettingsByAgent:{workspaceId}"
 */
export function getWorkspaceAISettingsByAgentKey(workspaceId: string): string {
  return `workspaceAiSettingsByAgent:${workspaceId}`;
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
 * Get the localStorage key for persisted workspace name-generation state.
 *
 * This is used by the workspace creation flow so drafts can preserve their
 * auto-generated (or manually edited) workspace name independently.
 *
 * Format: "workspaceNameState:{scopeId}"
 */
export function getWorkspaceNameStateKey(scopeId: string): string {
  return `workspaceNameState:${scopeId}`;
}

/**
 * Get the localStorage key for the input attachments for a scope.
 * Format: "inputAttachments:{scopeId}"
 *
 * Note: The input key functions accept any string scope ID. For normal workspaces
 * this is the workspaceId; for creation mode it's a pending scope ID.
 */
export function getInputAttachmentsKey(scopeId: string): string {
  return `inputAttachments:${scopeId}`;
}

/**
 * Get the localStorage key for pending initial send errors after workspace creation.
 * Stored so the workspace view can surface a toast after navigation.
 * Format: "pendingSendError:{workspaceId}"
 */
export function getPendingWorkspaceSendErrorKey(workspaceId: string): string {
  return `pendingSendError:${workspaceId}`;
}

/**
 * LEGACY: Get the localStorage key for pre-backend auto-retry preference.
 *
 * Kept only for one-way migration during onChat subscription.
 */
export function getAutoRetryKey(workspaceId: string): string {
  return `${workspaceId}-autoRetry`;
}

/**
 * Get storage key for cancelled compaction tracking.
 * Stores compaction-request user message ID to verify freshness across reloads.
 */
export function getCancelledCompactionKey(workspaceId: string): string {
  return `workspace:${workspaceId}:cancelled-compaction`;
}

/**
 * Get the localStorage key for the selected agent definition id for a scope.
 * Format: "agentId:{scopeId}"
 */
export function getAgentIdKey(scopeId: string): string {
  return `agentId:${scopeId}`;
}

/**
 * Get the localStorage key for the pinned third agent id for a scope.
 * Format: "pinnedAgentId:{scopeId}"
 */
export function getPinnedAgentIdKey(scopeId: string): string {
  return `pinnedAgentId:${scopeId}`;
}
/**
 * Get the localStorage key for "disable workspace agents" toggle per scope.
 * When true, workspace-specific agents are disabled - only built-in and global agents are loaded.
 * Useful for "unbricking" when iterating on agent files in a workspace worktree.
 * Format: "disableWorkspaceAgents:{scopeId}"
 */
export function getDisableWorkspaceAgentsKey(scopeId: string): string {
  return `disableWorkspaceAgents:${scopeId}`;
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
 * Get the localStorage key for whether to show the "Initialize with AGENTS.md" nudge for a project.
 * Set to true when a project is first added; cleared when user dismisses or runs /init.
 * Format: "agentsInitNudge:{projectPath}"
 */
export function getAgentsInitNudgeKey(projectPath: string): string {
  return `agentsInitNudge:${projectPath}`;
}

/**
 * Get the localStorage key for the last runtime config used per provider for a project.
 *
 * Value shape is a provider-keyed object (e.g. { ssh: { host }, docker: { image } }) so we can
 * add new options without adding more storage keys.
 *
 * Format: "lastRuntimeConfig:{projectPath}"
 */
export function getLastRuntimeConfigKey(projectPath: string): string {
  return `lastRuntimeConfig:${projectPath}`;
}

/**
 * Get the localStorage key for the default model (global).
 *
 * Note: This is used as a fallback when creating new workspaces.
 * Format: "model-default"
 */
export const DEFAULT_MODEL_KEY = "model-default";

/**
 * Get the localStorage key for the hidden models list (global).
 * Format: "hidden-models"
 */
export const HIDDEN_MODELS_KEY = "hidden-models";

/**
 * Get the localStorage key for the preferred compaction model (global)
 * Format: "preferredCompactionModel"
 */
export const PREFERRED_COMPACTION_MODEL_KEY = "preferredCompactionModel";

/**
 * Get the localStorage key for the preferred System 1 model (global)
 * Format: "preferredSystem1Model"
 */
export const PREFERRED_SYSTEM_1_MODEL_KEY = "preferredSystem1Model";

/**
 * Get the localStorage key for the preferred System 1 thinking level (global)
 * Format: "preferredSystem1ThinkingLevel"
 */
export const PREFERRED_SYSTEM_1_THINKING_LEVEL_KEY = "preferredSystem1ThinkingLevel";

/**
 * Get the localStorage key for cached per-agent AI defaults (global).
 * Format: "agentAiDefaults"
 */
export const AGENT_AI_DEFAULTS_KEY = "agentAiDefaults";

/**
 * Get the localStorage key for vim mode preference (global)
 * Format: "vimEnabled"
 */
export const VIM_ENABLED_KEY = "vimEnabled";

/**
 * Preferred expiration for mux.md shares (global)
 * Stores: "1h" | "24h" | "7d" | "30d" | "never"
 * Default: "7d"
 */
export const SHARE_EXPIRATION_KEY = "shareExpiration";

/**
 * Whether to sign shared messages by default.
 * Stores: boolean
 * Default: true
 */
export const SHARE_SIGNING_KEY = "shareSigning";

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
 * Integrated terminal font configuration (global)
 * Stores: { fontFamily: string; fontSize: number }
 */
export const TERMINAL_FONT_CONFIG_KEY = "terminalFontConfig";

export interface TerminalFontConfig {
  fontFamily: string;
  fontSize: number;
}

export const DEFAULT_TERMINAL_FONT_CONFIG: TerminalFontConfig = {
  fontFamily: "Geist Mono, ui-monospace, monospace",
  fontSize: 13,
};

/**
 * Tutorial state storage key (global)
 * Stores: { disabled: boolean, completed: { creation?: true, workspace?: true, review?: true } }
 */
export const TUTORIAL_STATE_KEY = "tutorialState";

export type TutorialSequence = "creation" | "workspace" | "review";

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
 * Get the localStorage key for hunk first-seen timestamps per workspace
 * Tracks when each hunk content address was first observed (for LIFO sorting)
 * Format: "hunkFirstSeen:{workspaceId}"
 */
export function getHunkFirstSeenKey(workspaceId: string): string {
  return `hunkFirstSeen:${workspaceId}`;
}

/**
 * Get the localStorage key for review sort order preference (global)
 * Format: "review-sort-order"
 */
export const REVIEW_SORT_ORDER_KEY = "review-sort-order";

/**
 * Get the localStorage key for hunk expand/collapse state in Review tab
 * Stores user's manual expand/collapse preferences per hunk
 * Format: "reviewExpandState:{workspaceId}"
 */
export function getReviewExpandStateKey(workspaceId: string): string {
  return `reviewExpandState:${workspaceId}`;
}

/**
 * Get the localStorage key for read-more expansion state per hunk.
 * Tracks how many lines are expanded up/down for each hunk.
 * Format: "reviewReadMore:{workspaceId}"
 */
export function getReviewReadMoreKey(workspaceId: string): string {
  return `reviewReadMore:${workspaceId}`;
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
 * LocalStorage key for file tree view mode in the Review tab (global).
 * Format: "reviewFileTreeViewMode"
 */
export const REVIEW_FILE_TREE_VIEW_MODE_KEY = "reviewFileTreeViewMode";

/**
 * Get the localStorage key for persisted agent status for a workspace
 * Stores the most recent successful status_set payload (emoji, message, url)
 * Format: "statusState:{workspaceId}"
 */

/**
 * Get the localStorage key for "notify on response" toggle per workspace.
 * When true, a browser notification is shown when assistant responses complete.
 * Format: "notifyOnResponse:{workspaceId}"
 */
export function getNotifyOnResponseKey(workspaceId: string): string {
  return `notifyOnResponse:${workspaceId}`;
}

/**
 * Get the localStorage key for "auto-enable notifications" toggle per project.
 * When true, new workspaces in this project automatically have notifications enabled.
 * Format: "notifyOnResponseAutoEnable:{projectPath}"
 */
export function getNotifyOnResponseAutoEnableKey(projectPath: string): string {
  return `notifyOnResponseAutoEnable:${projectPath}`;
}

export function getStatusStateKey(workspaceId: string): string {
  return `statusState:${workspaceId}`;
}

/**
 * Get the localStorage key for last-read timestamps per workspace.
 * Format: "workspaceLastRead:{workspaceId}"
 */
export function getWorkspaceLastReadKey(workspaceId: string): string {
  return `workspaceLastRead:${workspaceId}`;
}

/**
 * Left sidebar collapsed state (global, manual toggle)
 * Format: "sidebarCollapsed"
 */
export const LEFT_SIDEBAR_COLLAPSED_KEY = "sidebarCollapsed";

/**
 * Left sidebar width
 * Format: "left-sidebar:width"
 */
export const LEFT_SIDEBAR_WIDTH_KEY = "left-sidebar:width";

/**
 * Mobile left sidebar scroll position.
 *
 * The mobile sidebar content unmounts when collapsed, so we persist scrollTop
 * to restore the previous browse position when the menu is reopened.
 * Format: "mobile-left-sidebar:scroll-top"
 */
export const MOBILE_LEFT_SIDEBAR_SCROLL_TOP_KEY = "mobile-left-sidebar:scroll-top";

/**
 * Right sidebar tab selection (global)
 * Format: "right-sidebar-tab"
 */
export const RIGHT_SIDEBAR_TAB_KEY = "right-sidebar-tab";

/**
 * Right sidebar collapsed state (global, manual toggle)
 * Format: "right-sidebar:collapsed"
 */
export const RIGHT_SIDEBAR_COLLAPSED_KEY = "right-sidebar:collapsed";

/**
 * Right sidebar width (unified across all tabs)
 * Format: "right-sidebar:width"
 */
export const RIGHT_SIDEBAR_WIDTH_KEY = "right-sidebar:width";

/**
 * Get the localStorage key for right sidebar dock-lite layout per workspace.
 * Each workspace can have its own split/tab configuration (e.g., different
 * numbers of terminals). Width and collapsed state remain global.
 * Format: "right-sidebar:layout:{workspaceId}"
 */
export function getRightSidebarLayoutKey(workspaceId: string): string {
  return `right-sidebar:layout:${workspaceId}`;
}

/**
 * Get the localStorage key for terminal titles per workspace.
 * Maps sessionId -> title for persisting OSC-set terminal titles.
 * Format: "right-sidebar:terminal-titles:{workspaceId}"
 */
export function getTerminalTitlesKey(workspaceId: string): string {
  return `right-sidebar:terminal-titles:${workspaceId}`;
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
 * Get the localStorage key for reviews per workspace
 * Stores: ReviewsState (reviews created from diff viewer - pending, attached, or checked)
 * Format: "reviews:{workspaceId}"
 */
export function getReviewsKey(workspaceId: string): string {
  return `reviews:${workspaceId}`;
}

/**
 * Get the localStorage key for immersive review mode state per workspace
 * Tracks whether immersive mode is active
 * Format: "review-immersive:{workspaceId}"
 */
export function getReviewImmersiveKey(workspaceId: string): string {
  return `review-immersive:${workspaceId}`;
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
  getWorkspaceAISettingsByAgentKey,
  getModelKey,
  getInputKey,
  getWorkspaceNameStateKey,
  getInputAttachmentsKey,
  getAgentIdKey,
  getPinnedAgentIdKey,
  getThinkingLevelKey,
  getReviewStateKey,
  getHunkFirstSeenKey,
  getReviewExpandStateKey,
  getReviewReadMoreKey,
  getFileTreeExpandStateKey,
  getReviewSearchStateKey,
  getReviewsKey,
  getReviewImmersiveKey,
  getAutoCompactionEnabledKey,
  getWorkspaceLastReadKey,
  getStatusStateKey,
  // Note: auto-compaction threshold is per-model, not per-workspace
];

/**
 * Get the localStorage key for cached plan content for a workspace
 * Stores: { content: string; path: string } - used for optimistic rendering
 * Format: "planContent:{workspaceId}"
 */
export function getPlanContentKey(workspaceId: string): string {
  return `planContent:${workspaceId}`;
}

/**
 * Get the localStorage key for cached post-compaction state for a workspace
 * Stores: { planPath: string | null; trackedFilePaths: string[]; excludedItems: string[] }
 * Format: "postCompactionState:{workspaceId}"
 */
export function getPostCompactionStateKey(workspaceId: string): string {
  return `postCompactionState:${workspaceId}`;
}

/**
 * Additional ephemeral keys to delete on workspace removal (not copied on fork)
 */
const EPHEMERAL_WORKSPACE_KEY_FUNCTIONS: Array<(workspaceId: string) => string> = [
  getCancelledCompactionKey,
  getPendingWorkspaceSendErrorKey,
  getPlanContentKey, // Cache only, no need to preserve on fork
  getPostCompactionStateKey, // Cache only, no need to preserve on fork
];

/**
 * Copy all workspace-specific localStorage keys from source to destination workspace.
 * Includes keys listed in PERSISTENT_WORKSPACE_KEY_FUNCTIONS (model, draft input text/attachments, etc).
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
