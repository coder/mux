import { useState, useEffect, useRef, useCallback } from "react";
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
  getLastRuntimeConfigKey,
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

  type LastRuntimeConfigs = Partial<Record<RuntimeMode, unknown>>;

  // Project-scoped last runtime config (persisted per provider, stored as an object)
  const [lastRuntimeConfigs, setLastRuntimeConfigs] = usePersistedState<LastRuntimeConfigs>(
    getLastRuntimeConfigKey(projectPath),
    {},
    { listener: true }
  );

  const readLastRuntimeConfigString = (mode: RuntimeMode, field: string): string => {
    const value = lastRuntimeConfigs[mode];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "";
    }
    const fieldValue = (value as Record<string, unknown>)[field];
    return typeof fieldValue === "string" ? fieldValue : "";
  };

  const lastSshHost = readLastRuntimeConfigString(RUNTIME_MODE.SSH, "host");
  const lastDockerImage = readLastRuntimeConfigString(RUNTIME_MODE.DOCKER, "image");

  const setLastRuntimeConfigString = useCallback(
    (mode: RuntimeMode, field: string, value: string) => {
      setLastRuntimeConfigs((prev) => {
        const existing = prev[mode];
        const existingObj =
          existing && typeof existing === "object" && !Array.isArray(existing)
            ? (existing as Record<string, unknown>)
            : {};

        return { ...prev, [mode]: { ...existingObj, [field]: value } };
      });
    },
    [setLastRuntimeConfigs]
  );

  // If the default runtime string contains a host/image (e.g. older persisted values like "ssh devbox"),
  // prefer it as the initial remembered value.
  useEffect(() => {
    if (
      parsedDefault?.mode === RUNTIME_MODE.SSH &&
      !lastSshHost.trim() &&
      parsedDefault.host.trim()
    ) {
      setLastRuntimeConfigString(RUNTIME_MODE.SSH, "host", parsedDefault.host);
    }
    if (
      parsedDefault?.mode === RUNTIME_MODE.DOCKER &&
      !lastDockerImage.trim() &&
      parsedDefault.image.trim()
    ) {
      setLastRuntimeConfigString(RUNTIME_MODE.DOCKER, "image", parsedDefault.image);
    }
  }, [projectPath, parsedDefault, lastSshHost, lastDockerImage, setLastRuntimeConfigString]);

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
        setLastRuntimeConfigString(RUNTIME_MODE.SSH, "host", runtime.host);
      }
    } else if (runtime.mode === RUNTIME_MODE.DOCKER) {
      if (runtime.image.trim()) {
        setLastRuntimeConfigString(RUNTIME_MODE.DOCKER, "image", runtime.image);
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
