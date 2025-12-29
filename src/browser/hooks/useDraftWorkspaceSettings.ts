import { useEffect } from "react";
import { usePersistedState } from "./usePersistedState";
import { useThinkingLevel } from "./useThinkingLevel";
import { useMode } from "@/browser/contexts/ModeContext";
import { getDefaultModel } from "./useModelsFromSettings";
import {
  type RuntimeMode,
  parseRuntimeModeAndHost,
  buildRuntimeString,
} from "@/common/types/runtime";
import {
  getDraftRuntimeKey,
  getModelKey,
  getRuntimeKey,
  getTrunkBranchKey,
  getLastSshHostKey,
  getProjectScopeId,
} from "@/common/constants/storage";
import type { UIMode } from "@/common/types/mode";
import type { ThinkingLevel } from "@/common/types/thinking";

/**
 * Centralized draft workspace settings for project-level persistence
 * All settings persist across navigation and are restored when returning to the same project
 */
export interface DraftWorkspaceSettings {
  // Model & AI settings (synced with global state)
  model: string;
  thinkingLevel: ThinkingLevel;
  mode: UIMode;

  // Workspace creation settings (project-specific)
  /** Currently selected runtime for this workspace creation (may differ from default) */
  runtimeMode: RuntimeMode;
  /** Persisted default runtime for this project (used to initialize selection) */
  defaultRuntimeMode: RuntimeMode;
  sshHost: string;
  trunkBranch: string;
}

/**
 * Hook to manage all draft workspace settings with centralized persistence
 * Loads saved preferences when projectPath changes, persists all changes automatically
 *
 * @param projectPath - Path to the project (used as key prefix for localStorage)
 * @param branches - Available branches (used to set default trunk branch)
 * @param recommendedTrunk - Backend-recommended trunk branch
 * @returns Settings object and setters
 */
export function useDraftWorkspaceSettings(
  projectPath: string,
  branches: string[],
  recommendedTrunk: string | null
): {
  settings: DraftWorkspaceSettings;
  /** Set the currently selected runtime mode (persists as part of draft) */
  setRuntimeMode: (mode: RuntimeMode) => void;
  /** Set the default runtime mode for this project (persists via checkbox) */
  setDefaultRuntimeMode: (mode: RuntimeMode) => void;
  setSshHost: (host: string) => void;
  setTrunkBranch: (branch: string) => void;
  getRuntimeString: () => string | undefined;
} {
  // Global AI settings (read-only from global state)
  const [thinkingLevel] = useThinkingLevel();
  const [mode] = useMode();

  // Project-scoped model preference (persisted per project)
  const [model] = usePersistedState<string>(
    getModelKey(getProjectScopeId(projectPath)),
    getDefaultModel(),
    { listener: true }
  );

  // Project-scoped default runtime (worktree by default, only changed via checkbox)
  const [defaultRuntimeString, setDefaultRuntimeString] = usePersistedState<string | undefined>(
    getRuntimeKey(projectPath),
    undefined, // undefined means worktree (the app default)
    { listener: true }
  );

  // Parse default runtime string into mode (worktree when undefined)
  const { mode: defaultRuntimeMode } = parseRuntimeModeAndHost(defaultRuntimeString);

  // Draft runtime selection - persisted so it survives navigation away and back.
  // Uses undefined to mean "use default", allowing the default to be respected
  // until the user explicitly selects something different.
  const [draftRuntimeMode, setDraftRuntimeMode] = usePersistedState<RuntimeMode | undefined>(
    getDraftRuntimeKey(projectPath),
    undefined,
    { listener: true }
  );

  // Effective selected mode: draft selection if set, otherwise fall back to default
  const selectedRuntimeMode = draftRuntimeMode ?? defaultRuntimeMode;

  // Project-scoped trunk branch preference (persisted per project)
  const [trunkBranch, setTrunkBranch] = usePersistedState<string>(
    getTrunkBranchKey(projectPath),
    "",
    { listener: true }
  );

  // Project-scoped SSH host preference (persisted separately from runtime mode)
  // This allows the SSH host to be remembered when switching between runtime modes
  const [lastSshHost, setLastSshHost] = usePersistedState<string>(
    getLastSshHostKey(projectPath),
    "",
    { listener: true }
  );

  // Initialize trunk branch from backend recommendation or first branch
  useEffect(() => {
    if (!trunkBranch && branches.length > 0) {
      const defaultBranch = recommendedTrunk ?? branches[0];
      setTrunkBranch(defaultBranch);
    }
  }, [branches, recommendedTrunk, trunkBranch, setTrunkBranch]);

  // Setter for selected runtime mode (persists as part of draft)
  const setRuntimeMode = (newMode: RuntimeMode) => {
    setDraftRuntimeMode(newMode);
  };

  // Setter for default runtime mode (persists via checkbox in tooltip)
  const setDefaultRuntimeMode = (newMode: RuntimeMode) => {
    const newRuntimeString = buildRuntimeString(newMode, lastSshHost);
    setDefaultRuntimeString(newRuntimeString);
    // Also update draft selection to match new default
    setDraftRuntimeMode(newMode);
  };

  // Setter for SSH host (persisted separately so it's remembered across mode switches)
  const setSshHost = (newHost: string) => {
    setLastSshHost(newHost);
  };

  // Helper to get runtime string for IPC calls (uses selected mode, not default)
  const getRuntimeString = (): string | undefined => {
    return buildRuntimeString(selectedRuntimeMode, lastSshHost);
  };

  return {
    settings: {
      model,
      thinkingLevel,
      mode,
      runtimeMode: selectedRuntimeMode,
      defaultRuntimeMode,
      sshHost: lastSshHost,
      trunkBranch,
    },
    setRuntimeMode,
    setDefaultRuntimeMode,
    setSshHost,
    setTrunkBranch,
    getRuntimeString,
  };
}
