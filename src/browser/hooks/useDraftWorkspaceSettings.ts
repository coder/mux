import { useState, useEffect } from "react";
import { usePersistedState } from "./usePersistedState";
import { useThinkingLevel } from "./useThinkingLevel";
import { useMode } from "@/browser/contexts/ModeContext";
import { getDefaultModel } from "./useModelsFromSettings";
import {
  type RuntimeMode,
  type ParsedRuntime,
  parseRuntimeModeAndHost,
  buildRuntimeString,
  RUNTIME_MODE,
} from "@/common/types/runtime";
import {
  getModelKey,
  getRuntimeKey,
  getTrunkBranchKey,
  getLastSshHostKey,
  getLastDockerImageKey,
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
  /** SSH host (persisted separately from mode) */
  sshHost: string;
  /** Docker image (persisted separately from mode) */
  dockerImage: string;
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
  /** Set the currently selected runtime mode (does not persist) */
  setRuntimeMode: (mode: RuntimeMode) => void;
  /** Set the default runtime mode for this project (persists via checkbox) */
  setDefaultRuntimeMode: (mode: RuntimeMode) => void;
  setSshHost: (host: string) => void;
  setDockerImage: (image: string) => void;
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

  // Parse default runtime string into mode (worktree when undefined or invalid)
  const parsedDefault = parseRuntimeModeAndHost(defaultRuntimeString);
  const defaultRuntimeMode: RuntimeMode = parsedDefault?.mode ?? RUNTIME_MODE.WORKTREE;

  // Currently selected runtime mode for this session (initialized from default)
  // This allows user to select a different runtime without changing the default
  const [selectedRuntimeMode, setSelectedRuntimeMode] = useState<RuntimeMode>(defaultRuntimeMode);

  // Sync selected mode when default changes (e.g., from checkbox or project switch)
  useEffect(() => {
    setSelectedRuntimeMode(defaultRuntimeMode);
  }, [defaultRuntimeMode]);

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

  // Project-scoped Docker image preference (persisted separately from runtime mode)
  const [lastDockerImage, setLastDockerImage] = usePersistedState<string>(
    getLastDockerImageKey(projectPath),
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

  // Build ParsedRuntime from mode + stored host/image
  const buildParsedRuntime = (mode: RuntimeMode): ParsedRuntime | null => {
    switch (mode) {
      case RUNTIME_MODE.LOCAL:
        return { mode: "local" };
      case RUNTIME_MODE.WORKTREE:
        return { mode: "worktree" };
      case RUNTIME_MODE.SSH:
        return lastSshHost ? { mode: "ssh", host: lastSshHost } : null;
      case RUNTIME_MODE.DOCKER:
        return lastDockerImage ? { mode: "docker", image: lastDockerImage } : null;
      default:
        return null;
    }
  };

  // Setter for selected runtime mode (changes current selection, does not persist)
  const setRuntimeMode = (newMode: RuntimeMode) => {
    setSelectedRuntimeMode(newMode);
  };

  // Setter for default runtime mode (persists via checkbox in tooltip)
  const setDefaultRuntimeMode = (newMode: RuntimeMode) => {
    const parsed = buildParsedRuntime(newMode);
    const newRuntimeString = parsed ? buildRuntimeString(parsed) : undefined;
    setDefaultRuntimeString(newRuntimeString);
    // Also update selection to match new default
    setSelectedRuntimeMode(newMode);
  };

  // Setter for SSH host (persisted separately so it's remembered across mode switches)
  const setSshHost = (newHost: string) => {
    setLastSshHost(newHost);
  };

  // Setter for Docker image (persisted separately so it's remembered across mode switches)
  const setDockerImage = (newImage: string) => {
    setLastDockerImage(newImage);
  };

  // Helper to get runtime string for IPC calls (uses selected mode, not default)
  const getRuntimeString = (): string | undefined => {
    const parsed = buildParsedRuntime(selectedRuntimeMode);
    return parsed ? buildRuntimeString(parsed) : undefined;
  };

  return {
    settings: {
      model,
      thinkingLevel,
      mode,
      runtimeMode: selectedRuntimeMode,
      defaultRuntimeMode,
      sshHost: lastSshHost,
      dockerImage: lastDockerImage,
      trunkBranch,
    },
    setRuntimeMode,
    setDefaultRuntimeMode,
    setSshHost,
    setDockerImage,
    setTrunkBranch,
    getRuntimeString,
  };
}
