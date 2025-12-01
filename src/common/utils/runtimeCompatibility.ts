/**
 * Runtime configuration compatibility checks.
 *
 * This module is intentionally in common/ to avoid circular dependencies
 * with runtime implementations (LocalRuntime, SSHRuntime, etc.).
 */

import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Check if a runtime config is from a newer version and incompatible.
 *
 * This handles downgrade compatibility: if a user upgrades to a version
 * with new runtime types (e.g., "local" without srcBaseDir for project-dir mode),
 * then downgrades, those workspaces should show a clear error rather than crashing.
 */
export function isIncompatibleRuntimeConfig(config: RuntimeConfig | undefined): boolean {
  if (!config) {
    return false;
  }
  // Future versions may add "local" without srcBaseDir (project-dir mode)
  // or new types like "worktree". Detect these as incompatible.
  if (config.type === "local" && !("srcBaseDir" in config && config.srcBaseDir)) {
    return true;
  }
  // Unknown types from future versions
  if (config.type !== "local" && config.type !== "ssh") {
    return true;
  }
  return false;
}
