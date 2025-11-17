/**
 * Global default values for all workspace settings.
 *
 * These defaults are IMMUTABLE and serve as the fallback when:
 * - A new workspace is created
 * - A workspace has no stored override in localStorage
 * - Settings are reset to defaults
 *
 * Per-workspace overrides persist in localStorage using keys like:
 * - `mode:{workspaceId}`
 * - `model:{workspaceId}`
 * - `thinkingLevel:{workspaceId}`
 * - `input:{workspaceId}`
 * - `{workspaceId}-autoRetry`
 *
 * The global defaults themselves CANNOT be changed by users.
 * Only per-workspace overrides are mutable.
 *
 * IMPORTANT: All values are marked `as const` to ensure immutability at the type level.
 * Do not modify these values at runtime - they serve as the single source of truth.
 */

import type { UIMode } from "@/common/types/mode";
import type { ThinkingLevel } from "@/common/types/thinking";

/**
 * Hard-coded default values for workspace settings.
 * Type assertions ensure proper typing while maintaining immutability.
 */
export const WORKSPACE_DEFAULTS = {
  /** Default UI mode (plan vs exec) for new workspaces */
  mode: "exec" as UIMode,

  /** Default thinking/reasoning level for new workspaces */
  thinkingLevel: "off" as ThinkingLevel,

  /**
   * Default AI model for new workspaces.
   * This is the TRUE default - not dependent on user's LRU cache.
   */
  model: "anthropic:claude-sonnet-4-5" as string,

  /** Default auto-retry preference for new workspaces */
  autoRetry: true as boolean,

  /** Default input text for new workspaces (empty) */
  input: "" as string,
};

// Freeze the object at runtime to prevent accidental mutation
Object.freeze(WORKSPACE_DEFAULTS);

/**
 * Type-safe keys for workspace settings
 */
export type WorkspaceSettingKey = keyof typeof WORKSPACE_DEFAULTS;

/**
 * Type-safe values for workspace settings
 */
export type WorkspaceSettingValue<K extends WorkspaceSettingKey> = (typeof WORKSPACE_DEFAULTS)[K];
