/**
 * IPC Channel Constants - Shared between main and preload processes
 * This file contains only constants and helper functions, no Electron-specific code
 */

export const IPC_CHANNELS = {
  // Provider channels
  PROVIDERS_SET_CONFIG: "providers:setConfig",
  PROVIDERS_LIST: "providers:list",

  // Project channels
  PROJECT_CREATE: "project:create",
  PROJECT_REMOVE: "project:remove",
  PROJECT_LIST: "project:list",
  PROJECT_LIST_BRANCHES: "project:listBranches",
  PROJECT_SECRETS_GET: "project:secrets:get",
  PROJECT_SECRETS_UPDATE: "project:secrets:update",

  // Workspace channels
  WORKSPACE_LIST: "workspace:list",
  WORKSPACE_CREATE: "workspace:create",
  WORKSPACE_REMOVE: "workspace:remove",
  WORKSPACE_RENAME: "workspace:rename",
  WORKSPACE_FORK: "workspace:fork",
  WORKSPACE_SEND_MESSAGE: "workspace:sendMessage",
  WORKSPACE_RESUME_STREAM: "workspace:resumeStream",
  WORKSPACE_INTERRUPT_STREAM: "workspace:interruptStream",
  WORKSPACE_QUEUE_CLEAR: "workspace:queue:clear",
  WORKSPACE_TRUNCATE_HISTORY: "workspace:truncateHistory",
  WORKSPACE_REPLACE_HISTORY: "workspace:replaceHistory",
  WORKSPACE_STREAM_HISTORY: "workspace:streamHistory",
  WORKSPACE_GET_INFO: "workspace:getInfo",
  WORKSPACE_EXECUTE_BASH: "workspace:executeBash",
  WORKSPACE_OPEN_TERMINAL: "workspace:openTerminal",

  // Terminal channels
  TERMINAL_CREATE: "terminal:create",
  TERMINAL_CLOSE: "terminal:close",
  TERMINAL_RESIZE: "terminal:resize",
  TERMINAL_INPUT: "terminal:input",
  TERMINAL_WINDOW_OPEN: "terminal:window:open",
  TERMINAL_WINDOW_CLOSE: "terminal:window:close",

  // Window channels
  WINDOW_SET_TITLE: "window:setTitle",

  // Debug channels (for testing only)
  DEBUG_TRIGGER_STREAM_ERROR: "debug:triggerStreamError",

  // Update channels
  UPDATE_CHECK: "update:check",
  UPDATE_DOWNLOAD: "update:download",
  UPDATE_INSTALL: "update:install",
  UPDATE_STATUS: "update:status",
  UPDATE_STATUS_SUBSCRIBE: "update:status:subscribe",

  // Tokenizer channels
  TOKENIZER_CALCULATE_STATS: "tokenizer:calculateStats",
  TOKENIZER_COUNT_TOKENS: "tokenizer:countTokens",
  TOKENIZER_COUNT_TOKENS_BATCH: "tokenizer:countTokensBatch",

  // Dynamic channel prefixes
  WORKSPACE_CHAT_PREFIX: "workspace:chat:",
  WORKSPACE_METADATA: "workspace:metadata",
  WORKSPACE_METADATA_SUBSCRIBE: "workspace:metadata:subscribe",
} as const;

// Helper functions for dynamic channels
export const getChatChannel = (workspaceId: string): string =>
  `${IPC_CHANNELS.WORKSPACE_CHAT_PREFIX}${workspaceId}`;
