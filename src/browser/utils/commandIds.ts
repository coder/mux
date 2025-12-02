/**
 * Centralized command ID construction and matching
 * Single source of truth for all command ID patterns
 */

/**
 * Command ID prefixes for pattern matching
 * Single source of truth for all dynamic ID patterns
 */
const COMMAND_ID_PREFIXES = {
  WS_SWITCH: "ws:switch:",
  CHAT_TRUNCATE: "chat:truncate:",
  PROJECT_REMOVE: "project:remove:",
} as const;

/**
 * Command ID builders - construct IDs with consistent patterns
 */
export const CommandIds = {
  // Workspace commands
  workspaceSwitch: (workspaceId: string) =>
    `${COMMAND_ID_PREFIXES.WS_SWITCH}${workspaceId}` as const,
  workspaceNew: () => "ws:new" as const,
  workspaceNewInProject: () => "ws:new-in-project" as const,
  workspaceRemove: () => "ws:remove" as const,
  workspaceRemoveAny: () => "ws:remove-any" as const,
  workspaceRename: () => "ws:rename" as const,
  workspaceRenameAny: () => "ws:rename-any" as const,
  workspaceOpenTerminal: () => "ws:open-terminal" as const,
  workspaceOpenTerminalCurrent: () => "ws:open-terminal-current" as const,

  // Navigation commands
  navNext: () => "nav:next" as const,
  navPrev: () => "nav:prev" as const,
  navToggleSidebar: () => "nav:toggleSidebar" as const,

  // Chat commands
  chatClear: () => "chat:clear" as const,
  chatTruncate: (pct: number) => `${COMMAND_ID_PREFIXES.CHAT_TRUNCATE}${pct}` as const,
  chatInterrupt: () => "chat:interrupt" as const,
  chatJumpBottom: () => "chat:jumpBottom" as const,
  chatVoiceInput: () => "chat:voiceInput" as const,

  // Mode commands
  modeToggle: () => "mode:toggle" as const,
  modelChange: () => "model:change" as const,
  thinkingSetLevel: () => "thinking:set-level" as const,

  // Project commands
  projectAdd: () => "project:add" as const,
  projectRemove: (projectPath: string) =>
    `${COMMAND_ID_PREFIXES.PROJECT_REMOVE}${projectPath}` as const,

  // Appearance commands
  themeToggle: () => "appearance:theme:toggle" as const,
  themeSet: (theme: "light" | "dark") => `appearance:theme:set:${theme}` as const,

  // Settings commands
  settingsOpen: () => "settings:open" as const,
  settingsOpenSection: (section: string) => `settings:open:${section}` as const,

  // Help commands
  helpKeybinds: () => "help:keybinds" as const,
} as const;

/**
 * Command ID matchers - test if an ID matches a pattern
 */
export const CommandIdMatchers = {
  /**
   * Check if ID is a workspace switching command (ws:switch:*)
   */
  isWorkspaceSwitch: (id: string): boolean => id.startsWith(COMMAND_ID_PREFIXES.WS_SWITCH),

  /**
   * Check if ID is a chat truncate command (chat:truncate:*)
   */
  isChatTruncate: (id: string): boolean => id.startsWith(COMMAND_ID_PREFIXES.CHAT_TRUNCATE),

  /**
   * Check if ID is a project remove command (project:remove:*)
   */
  isProjectRemove: (id: string): boolean => id.startsWith(COMMAND_ID_PREFIXES.PROJECT_REMOVE),
} as const;
