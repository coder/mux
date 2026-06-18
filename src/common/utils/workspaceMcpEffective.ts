import type { MCPServerInfo, WorkspaceMCPOverrides } from "@/common/types/mcp";

/**
 * Resolve whether a server is effectively enabled for a workspace, applying
 * workspace overrides on top of the project-level `disabled` flag.
 *
 * Precedence (highest first):
 *   1. overrides.enabledServers  → enabled
 *   2. overrides.disabledServers → disabled
 *   3. !projectDisabled (the project-level state)
 */
export function isServerEffectivelyEnabled(
  serverName: string,
  projectDisabled: boolean,
  overrides: WorkspaceMCPOverrides | undefined
): boolean {
  if (overrides?.enabledServers?.includes(serverName)) return true;
  if (overrides?.disabledServers?.includes(serverName)) return false;
  return !projectDisabled;
}

/**
 * Compute the sorted list of server names that are effectively enabled when the
 * given overrides are applied to a project-level servers map.
 */
export function effectiveEnabledServerNames(
  servers: Record<string, MCPServerInfo>,
  overrides: WorkspaceMCPOverrides | undefined
): string[] {
  return Object.entries(servers)
    .filter(([name, info]) => isServerEffectivelyEnabled(name, info.disabled, overrides))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Toggle a server's effective enabled state in a workspace overrides bag.
 * Returns a new overrides object; the input is not mutated.
 *
 * The semantics mirror `WorkspaceMCPModal.toggleServerEnabled`:
 *   - When the requested state matches the project default, the explicit
 *     entry is removed (so the workspace simply inherits the project state).
 *   - When the requested state differs, an explicit entry is added.
 */
export function toggleServerOverride(
  overrides: WorkspaceMCPOverrides,
  serverName: string,
  enabled: boolean,
  projectDisabled: boolean
): WorkspaceMCPOverrides {
  const currentEnabled = overrides.enabledServers ?? [];
  const currentDisabled = overrides.disabledServers ?? [];

  let newEnabled: string[];
  let newDisabled: string[];

  if (enabled) {
    newDisabled = currentDisabled.filter((s) => s !== serverName);
    if (projectDisabled) {
      newEnabled = currentEnabled.includes(serverName)
        ? currentEnabled
        : [...currentEnabled, serverName];
    } else {
      newEnabled = currentEnabled.filter((s) => s !== serverName);
    }
  } else {
    newEnabled = currentEnabled.filter((s) => s !== serverName);
    if (projectDisabled) {
      newDisabled = currentDisabled.filter((s) => s !== serverName);
    } else {
      newDisabled = currentDisabled.includes(serverName)
        ? currentDisabled
        : [...currentDisabled, serverName];
    }
  }

  return {
    ...overrides,
    enabledServers: newEnabled.length > 0 ? newEnabled : undefined,
    disabledServers: newDisabled.length > 0 ? newDisabled : undefined,
  };
}

/**
 * True when overrides contain any signal worth persisting (any enable/disable
 * entry or any allowlist entry).
 */
export function hasAnyOverride(overrides: WorkspaceMCPOverrides | undefined): boolean {
  if (!overrides) return false;
  if (overrides.enabledServers && overrides.enabledServers.length > 0) return true;
  if (overrides.disabledServers && overrides.disabledServers.length > 0) return true;
  if (overrides.toolAllowlist && Object.keys(overrides.toolAllowlist).length > 0) return true;
  return false;
}
