/**
 * Centralized devcontainer config selection logic.
 *
 * This module provides a single source of truth for devcontainer config
 * resolution, used by both UI (CreationControls) and creation logic
 * (useCreationWorkspace). All edge cases (loading/failed/loaded) are
 * handled here to prevent drift between UI and validation.
 */

import type { ParsedRuntime, DevcontainerConfigInfo } from "@/common/types/runtime";
import { RUNTIME_MODE, getDevcontainerConfigs } from "@/common/types/runtime";
import type { RuntimeAvailabilityState } from "@/browser/components/ChatInput/useCreationWorkspace";

export const DEFAULT_DEVCONTAINER_CONFIG_PATH = ".devcontainer/devcontainer.json";

/** UI mode for devcontainer config controls */
export type DevcontainerUiMode = "hidden" | "dropdown" | "input";

/** Result of devcontainer selection resolution */
export interface DevcontainerSelection {
  /** Resolved config path (may be empty if user input required) */
  configPath: string;
  /** Available configs (empty when loading/failed or no configs found) */
  configs: DevcontainerConfigInfo[];
  /** How the UI should render config selection */
  uiMode: DevcontainerUiMode;
  /** Helper text to display (null if none needed) */
  helperText: string | null;
  /** Whether workspace creation can proceed (false if config path required but empty) */
  isCreatable: boolean;
}

interface ResolveDevcontainerSelectionParams {
  selectedRuntime: ParsedRuntime;
  availabilityState: RuntimeAvailabilityState;
}

/**
 * Resolve devcontainer selection state from runtime and availability.
 *
 * Rules:
 * - Not devcontainer mode → hidden, creatable
 * - Loading → input mode, no default (user must provide explicit path)
 * - Failed → input mode, default to standard path if no explicit selection
 * - Loaded + configs → dropdown mode, pick selected or first config
 * - Loaded + no configs → input mode, user must provide path
 */
export function resolveDevcontainerSelection(
  params: ResolveDevcontainerSelectionParams
): DevcontainerSelection {
  const { selectedRuntime, availabilityState } = params;

  // Not devcontainer mode - hide controls, allow creation
  if (selectedRuntime.mode !== RUNTIME_MODE.DEVCONTAINER) {
    return {
      configPath: "",
      configs: [],
      uiMode: "hidden",
      helperText: null,
      isCreatable: true,
    };
  }

  const selectedPath = selectedRuntime.configPath.trim();

  // Loading state - show input, no implicit default (P2 fix)
  if (availabilityState.status === "loading") {
    return {
      configPath: selectedPath,
      configs: [],
      uiMode: "input",
      helperText: "Loading configs…",
      isCreatable: selectedPath.length > 0,
    };
  }

  // Failed state - show input, default to standard path if no selection
  if (availabilityState.status === "failed") {
    const resolvedPath = selectedPath || DEFAULT_DEVCONTAINER_CONFIG_PATH;
    return {
      configPath: resolvedPath,
      configs: [],
      uiMode: "input",
      helperText: "Configs couldn't be loaded. Enter a path to continue.",
      isCreatable: resolvedPath.length > 0,
    };
  }

  // Loaded state - check for available configs
  const availability = availabilityState.data.devcontainer;
  const configs = availability ? getDevcontainerConfigs(availability) : [];

  // Loaded but no configs found - devcontainer option is hidden in UI,
  // but if somehow reached, block creation
  if (configs.length === 0) {
    return {
      configPath: "",
      configs: [],
      uiMode: "hidden",
      helperText: null,
      isCreatable: false,
    };
  }

  // Loaded with configs - show dropdown
  // Use selected path if it's in the list, otherwise first config
  const configPath =
    selectedPath && configs.some((c) => c.path === selectedPath) ? selectedPath : configs[0].path;

  return {
    configPath,
    configs,
    uiMode: "dropdown",
    helperText: null,
    isCreatable: true,
  };
}
