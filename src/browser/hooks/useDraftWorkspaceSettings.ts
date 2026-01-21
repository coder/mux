import { useState, useEffect, useRef, useCallback } from "react";
import { usePersistedState } from "./usePersistedState";
import { useThinkingLevel } from "./useThinkingLevel";
import { useMode } from "@/browser/contexts/ModeContext";
import { getDefaultModel } from "./useModelsFromSettings";
import {
  type RuntimeMode,
  type ParsedRuntime,
  type CoderWorkspaceConfig,
  parseRuntimeModeAndHost,
  buildRuntimeString,
  RUNTIME_MODE,
  CODER_RUNTIME_PLACEHOLDER,
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

  // Generic reader for lastRuntimeConfigs fields
  const readRuntimeConfig = <T>(mode: RuntimeMode, field: string, defaultValue: T): T => {
    const modeConfig = lastRuntimeConfigs[mode];
    if (!modeConfig || typeof modeConfig !== "object" || Array.isArray(modeConfig)) {
      return defaultValue;
    }
    const fieldValue = (modeConfig as Record<string, unknown>)[field];
    // Type-specific validation based on default value type
    if (typeof defaultValue === "string") {
      return (typeof fieldValue === "string" ? fieldValue : defaultValue) as T;
    }
    if (typeof defaultValue === "boolean") {
      return (fieldValue === true) as unknown as T;
    }
    // Object type (null default means optional object)
    if (fieldValue && typeof fieldValue === "object" && !Array.isArray(fieldValue)) {
      return fieldValue as T;
    }
    return defaultValue;
  };

  const lastSshHost = readRuntimeConfig(RUNTIME_MODE.SSH, "host", "");
  const lastCoderEnabled = readRuntimeConfig(RUNTIME_MODE.SSH, "coderEnabled", false);
  const lastCoderConfig = readRuntimeConfig<CoderWorkspaceConfig | null>(
    RUNTIME_MODE.SSH,
    "coderConfig",
    null
  );
  const lastDockerImage = readRuntimeConfig(RUNTIME_MODE.DOCKER, "image", "");
  const lastShareCredentials = readRuntimeConfig(RUNTIME_MODE.DOCKER, "shareCredentials", false);
  const lastDevcontainerConfigPath = readRuntimeConfig(RUNTIME_MODE.DEVCONTAINER, "configPath", "");
  const lastDevcontainerShareCredentials = readRuntimeConfig(
    RUNTIME_MODE.DEVCONTAINER,
    "shareCredentials",
    false
  );

  const setLastRuntimeConfig = useCallback(
    (mode: RuntimeMode, field: string, value: string | boolean | object | null) => {
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
      setLastRuntimeConfig(RUNTIME_MODE.SSH, "host", parsedDefault.host);
    }
    if (
      parsedDefault?.mode === RUNTIME_MODE.DOCKER &&
      !lastDockerImage.trim() &&
      parsedDefault.image.trim()
    ) {
      setLastRuntimeConfig(RUNTIME_MODE.DOCKER, "image", parsedDefault.image);
    }
    if (
      parsedDefault?.mode === RUNTIME_MODE.DEVCONTAINER &&
      !lastDevcontainerConfigPath.trim() &&
      parsedDefault.configPath.trim()
    ) {
      setLastRuntimeConfig(RUNTIME_MODE.DEVCONTAINER, "configPath", parsedDefault.configPath);
    }
  }, [
    projectPath,
    parsedDefault,
    lastSshHost,
    lastDockerImage,
    lastDevcontainerConfigPath,
    setLastRuntimeConfig,
  ]);

  const defaultSshHost =
    parsedDefault?.mode === RUNTIME_MODE.SSH ? parsedDefault.host : lastSshHost;

  const defaultDockerImage =
    parsedDefault?.mode === RUNTIME_MODE.DOCKER ? parsedDefault.image : lastDockerImage;

  const defaultDevcontainerConfigPath =
    parsedDefault?.mode === RUNTIME_MODE.DEVCONTAINER && parsedDefault.configPath.trim()
      ? parsedDefault.configPath
      : lastDevcontainerConfigPath;

  // Build ParsedRuntime from mode + stored host/image/shareCredentials/coder
  // Defined as a function so it can be used in both useState init and useEffect
  const buildRuntimeForMode = (
    mode: RuntimeMode,
    sshHost: string,
    dockerImage: string,
    dockerShareCredentials: boolean,
    coderEnabled: boolean,
    coderConfig: CoderWorkspaceConfig | null,
    devcontainerConfigPath: string,
    devcontainerShareCredentials: boolean
  ): ParsedRuntime => {
    switch (mode) {
      case RUNTIME_MODE.LOCAL:
        return { mode: "local" };
      case RUNTIME_MODE.SSH: {
        // Use placeholder when Coder is enabled with no explicit SSH host
        // This ensures the runtime string round-trips correctly for Coder-only users
        const effectiveHost =
          coderEnabled && coderConfig && !sshHost.trim() ? CODER_RUNTIME_PLACEHOLDER : sshHost;

        return {
          mode: "ssh",
          host: effectiveHost,
          coder: coderEnabled && coderConfig ? coderConfig : undefined,
        };
      }
      case RUNTIME_MODE.DOCKER:
        return { mode: "docker", image: dockerImage, shareCredentials: dockerShareCredentials };
      case RUNTIME_MODE.DEVCONTAINER:
        return {
          mode: "devcontainer",
          configPath: devcontainerConfigPath,
          shareCredentials: devcontainerShareCredentials,
        };
      case RUNTIME_MODE.WORKTREE:
      default:
        return { mode: "worktree" };
    }
  };

  // Currently selected runtime for this session (initialized from default)
  // Uses discriminated union: SSH has host, Docker has image
  const [selectedRuntime, setSelectedRuntimeState] = useState<ParsedRuntime>(() =>
    buildRuntimeForMode(
      defaultRuntimeMode,
      defaultSshHost,
      defaultDockerImage,
      lastShareCredentials,
      lastCoderEnabled,
      lastCoderConfig,
      defaultDevcontainerConfigPath,
      lastDevcontainerShareCredentials
    )
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
        buildRuntimeForMode(
          defaultRuntimeMode,
          defaultSshHost,
          defaultDockerImage,
          lastShareCredentials,
          lastCoderEnabled,
          lastCoderConfig,
          defaultDevcontainerConfigPath,
          lastDevcontainerShareCredentials
        )
      );
    }

    prevProjectPathRef.current = projectPath;
    prevDefaultRuntimeModeRef.current = defaultRuntimeMode;
  }, [
    projectPath,
    defaultRuntimeMode,
    defaultSshHost,
    defaultDockerImage,
    lastShareCredentials,
    lastCoderEnabled,
    lastCoderConfig,
    defaultDevcontainerConfigPath,
    lastDevcontainerShareCredentials,
  ]);

  // When the user switches into SSH/Docker/Devcontainer mode, seed the field with the remembered config.
  // This avoids clearing the last values when the UI switches modes with an empty field.
  const prevSelectedRuntimeModeRef = useRef<RuntimeMode | null>(null);
  useEffect(() => {
    const prevMode = prevSelectedRuntimeModeRef.current;
    if (prevMode !== selectedRuntime.mode) {
      if (selectedRuntime.mode === RUNTIME_MODE.SSH) {
        const needsHostRestore = !selectedRuntime.host.trim() && lastSshHost.trim();
        const needsCoderRestore =
          selectedRuntime.coder === undefined && lastCoderEnabled && lastCoderConfig;
        if (needsHostRestore || needsCoderRestore) {
          setSelectedRuntimeState({
            mode: RUNTIME_MODE.SSH,
            host: needsHostRestore ? lastSshHost : selectedRuntime.host,
            coder: needsCoderRestore ? lastCoderConfig : selectedRuntime.coder,
          });
        }
      }

      if (selectedRuntime.mode === RUNTIME_MODE.DEVCONTAINER) {
        const needsConfigRestore =
          !selectedRuntime.configPath.trim() && lastDevcontainerConfigPath.trim();
        const needsCredentialsRestore =
          selectedRuntime.shareCredentials === undefined && lastDevcontainerShareCredentials;
        if (needsConfigRestore || needsCredentialsRestore) {
          setSelectedRuntimeState({
            mode: RUNTIME_MODE.DEVCONTAINER,
            configPath: needsConfigRestore
              ? lastDevcontainerConfigPath
              : selectedRuntime.configPath,
            shareCredentials: lastDevcontainerShareCredentials,
          });
        }
      }
      if (selectedRuntime.mode === RUNTIME_MODE.DOCKER) {
        const needsImageRestore = !selectedRuntime.image.trim() && lastDockerImage.trim();
        const needsCredentialsRestore =
          selectedRuntime.shareCredentials === undefined && lastShareCredentials;
        if (needsImageRestore || needsCredentialsRestore) {
          setSelectedRuntimeState({
            mode: RUNTIME_MODE.DOCKER,
            image: needsImageRestore ? lastDockerImage : selectedRuntime.image,
            shareCredentials: lastShareCredentials,
          });
        }
      }
    }

    prevSelectedRuntimeModeRef.current = selectedRuntime.mode;
  }, [
    selectedRuntime,
    lastSshHost,
    lastDockerImage,
    lastShareCredentials,
    lastCoderEnabled,
    lastCoderConfig,
    lastDevcontainerConfigPath,
    lastDevcontainerShareCredentials,
  ]);

  // Initialize trunk branch from backend recommendation or first branch
  useEffect(() => {
    if (!trunkBranch && branches.length > 0) {
      const defaultBranch = recommendedTrunk ?? branches[0];
      setTrunkBranch(defaultBranch);
    }
  }, [branches, recommendedTrunk, trunkBranch, setTrunkBranch]);

  // Setter for selected runtime (also persists host/image/coder for future mode switches)
  const setSelectedRuntime = (runtime: ParsedRuntime) => {
    setSelectedRuntimeState(runtime);

    // Persist host/image/coder so they're remembered when switching modes.
    // Avoid wiping the remembered value when the UI switches modes with an empty field.
    if (runtime.mode === RUNTIME_MODE.SSH) {
      if (runtime.host.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.SSH, "host", runtime.host);
      }
      // Persist Coder enabled state and config
      const coderEnabled = runtime.coder !== undefined;
      setLastRuntimeConfig(RUNTIME_MODE.SSH, "coderEnabled", coderEnabled);
      if (runtime.coder) {
        setLastRuntimeConfig(RUNTIME_MODE.SSH, "coderConfig", runtime.coder);
      }
    } else if (runtime.mode === RUNTIME_MODE.DOCKER) {
      if (runtime.image.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.DOCKER, "image", runtime.image);
      }
      if (runtime.shareCredentials !== undefined) {
        setLastRuntimeConfig(RUNTIME_MODE.DOCKER, "shareCredentials", runtime.shareCredentials);
      }
    } else if (runtime.mode === RUNTIME_MODE.DEVCONTAINER) {
      if (runtime.configPath.trim()) {
        setLastRuntimeConfig(RUNTIME_MODE.DEVCONTAINER, "configPath", runtime.configPath);
      }
      if (runtime.shareCredentials !== undefined) {
        setLastRuntimeConfig(
          RUNTIME_MODE.DEVCONTAINER,
          "shareCredentials",
          runtime.shareCredentials
        );
      }
    }
  };

  // Setter for default runtime mode (persists via checkbox in tooltip)
  const setDefaultRuntimeMode = (newMode: RuntimeMode) => {
    const newRuntime = buildRuntimeForMode(
      newMode,
      lastSshHost,
      lastDockerImage,
      lastShareCredentials,
      lastCoderEnabled,
      lastCoderConfig,
      defaultDevcontainerConfigPath,
      lastDevcontainerShareCredentials
    );
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
