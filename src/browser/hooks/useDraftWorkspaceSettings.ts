import { useState, useEffect, useRef } from "react";
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
  /**
   * Currently selected runtime for this workspace creation.
   * Uses discriminated union so SSH has host, Docker has image, etc.
   */
  selectedRuntime: ParsedRuntime;
  /** Persisted default runtime for this project (used to initialize selection) */
  defaultRuntimeMode: RuntimeMode;
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
  /** Set the currently selected runtime (discriminated union) */
  setSelectedRuntime: (runtime: ParsedRuntime) => void;
  /** Set the default runtime mode for this project (persists via checkbox) */
  setDefaultRuntimeMode: (mode: RuntimeMode) => void;
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

  // Parse default runtime string into structured form (worktree when undefined or invalid)
  const parsedDefault = parseRuntimeModeAndHost(defaultRuntimeString);
  const defaultRuntimeMode: RuntimeMode = parsedDefault?.mode ?? RUNTIME_MODE.WORKTREE;

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

  // If the default runtime string contains a host/image (e.g. older persisted values like "ssh devbox"),
  // prefer it as the initial remembered value.
  useEffect(() => {
    if (
      parsedDefault?.mode === RUNTIME_MODE.SSH &&
      !lastSshHost.trim() &&
      parsedDefault.host.trim()
    ) {
      setLastSshHost(parsedDefault.host);
    }
    if (
      parsedDefault?.mode === RUNTIME_MODE.DOCKER &&
      !lastDockerImage.trim() &&
      parsedDefault.image.trim()
    ) {
      setLastDockerImage(parsedDefault.image);
    }
  }, [
    projectPath,
    parsedDefault,
    lastSshHost,
    lastDockerImage,
    setLastSshHost,
    setLastDockerImage,
  ]);

  const defaultSshHost =
    parsedDefault?.mode === RUNTIME_MODE.SSH ? parsedDefault.host : lastSshHost;
  const defaultDockerImage =
    parsedDefault?.mode === RUNTIME_MODE.DOCKER ? parsedDefault.image : lastDockerImage;

  // Build ParsedRuntime from mode + stored host/image
  // Defined as a function so it can be used in both useState init and useEffect
  const buildRuntimeForMode = (
    mode: RuntimeMode,
    sshHost: string,
    dockerImage: string
  ): ParsedRuntime => {
    switch (mode) {
      case RUNTIME_MODE.LOCAL:
        return { mode: "local" };
      case RUNTIME_MODE.SSH:
        return { mode: "ssh", host: sshHost };
      case RUNTIME_MODE.DOCKER:
        return { mode: "docker", image: dockerImage };
      case RUNTIME_MODE.WORKTREE:
      default:
        return { mode: "worktree" };
    }
  };

  // Currently selected runtime for this session (initialized from default)
  // Uses discriminated union: SSH has host, Docker has image
  const [selectedRuntime, setSelectedRuntimeState] = useState<ParsedRuntime>(() =>
    buildRuntimeForMode(defaultRuntimeMode, defaultSshHost, defaultDockerImage)
  );

  const prevProjectPathRef = useRef<string | null>(null);
  const prevDefaultRuntimeModeRef = useRef<RuntimeMode | null>(null);

  // When switching projects or changing the persisted default mode, reset the selection.
  // Importantly: do NOT reset selection when lastSshHost/lastDockerImage changes while typing.
  useEffect(() => {
    const projectChanged = prevProjectPathRef.current !== projectPath;
    const defaultModeChanged = prevDefaultRuntimeModeRef.current !== defaultRuntimeMode;

    if (projectChanged || defaultModeChanged) {
      setSelectedRuntimeState(
        buildRuntimeForMode(defaultRuntimeMode, defaultSshHost, defaultDockerImage)
      );
    }

    prevProjectPathRef.current = projectPath;
    prevDefaultRuntimeModeRef.current = defaultRuntimeMode;
  }, [projectPath, defaultRuntimeMode, defaultSshHost, defaultDockerImage]);

  // When the user switches into SSH/Docker mode, seed the field with the remembered host/image.
  // This avoids clearing the last host/image when the UI switches modes with an empty field.
  const prevSelectedRuntimeModeRef = useRef<RuntimeMode | null>(null);
  useEffect(() => {
    const prevMode = prevSelectedRuntimeModeRef.current;
    if (prevMode !== selectedRuntime.mode) {
      if (selectedRuntime.mode === RUNTIME_MODE.SSH) {
        if (!selectedRuntime.host.trim() && lastSshHost.trim()) {
          setSelectedRuntimeState({ mode: RUNTIME_MODE.SSH, host: lastSshHost });
        }
      }

      if (selectedRuntime.mode === RUNTIME_MODE.DOCKER) {
        if (!selectedRuntime.image.trim() && lastDockerImage.trim()) {
          setSelectedRuntimeState({ mode: RUNTIME_MODE.DOCKER, image: lastDockerImage });
        }
      }
    }

    prevSelectedRuntimeModeRef.current = selectedRuntime.mode;
  }, [selectedRuntime, lastSshHost, lastDockerImage]);

  // Initialize trunk branch from backend recommendation or first branch
  useEffect(() => {
    if (!trunkBranch && branches.length > 0) {
      const defaultBranch = recommendedTrunk ?? branches[0];
      setTrunkBranch(defaultBranch);
    }
  }, [branches, recommendedTrunk, trunkBranch, setTrunkBranch]);

  // Setter for selected runtime (also persists host/image for future mode switches)
  const setSelectedRuntime = (runtime: ParsedRuntime) => {
    setSelectedRuntimeState(runtime);

    // Persist host/image so they're remembered when switching modes.
    // Avoid wiping the remembered value when the UI switches modes with an empty field.
    if (runtime.mode === RUNTIME_MODE.SSH) {
      if (runtime.host.trim()) {
        setLastSshHost(runtime.host);
      }
    } else if (runtime.mode === RUNTIME_MODE.DOCKER) {
      if (runtime.image.trim()) {
        setLastDockerImage(runtime.image);
      }
    }
  };

  // Setter for default runtime mode (persists via checkbox in tooltip)
  const setDefaultRuntimeMode = (newMode: RuntimeMode) => {
    const newRuntime = buildRuntimeForMode(newMode, lastSshHost, lastDockerImage);
    const newRuntimeString = buildRuntimeString(newRuntime);
    setDefaultRuntimeString(newRuntimeString);
    // Also update selection to match new default
    setSelectedRuntimeState(newRuntime);
  };

  // Helper to get runtime string for IPC calls
  const getRuntimeString = (): string | undefined => {
    return buildRuntimeString(selectedRuntime);
  };

  return {
    settings: {
      model,
      thinkingLevel,
      mode,
      selectedRuntime,
      defaultRuntimeMode,
      trunkBranch,
    },
    setSelectedRuntime,
    setDefaultRuntimeMode,
    setTrunkBranch,
    getRuntimeString,
  };
}
