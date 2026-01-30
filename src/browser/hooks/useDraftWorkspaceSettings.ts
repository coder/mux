import { useState, useEffect, useRef, useCallback } from "react";
import { readPersistedState, usePersistedState } from "./usePersistedState";
import { useThinkingLevel } from "./useThinkingLevel";
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
import type { RuntimeChoice } from "@/browser/utils/runtimeUi";
import {
  getAgentIdKey,
  getModelKey,
  getRuntimeKey,
  getTrunkBranchKey,
  getLastRuntimeConfigKey,
  getProjectScopeId,
} from "@/common/constants/storage";
import type { ThinkingLevel } from "@/common/types/thinking";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

/**
 * Centralized draft workspace settings for project-level persistence
 * All settings persist across navigation and are restored when returning to the same project
 */
export interface DraftWorkspaceSettings {
  // Model & AI settings (synced with global state)
  model: string;
  thinkingLevel: ThinkingLevel;
  agentId: string;

  // Workspace creation settings (project-specific)
  /**
   * Currently selected runtime for this workspace creation.
   * Uses discriminated union so SSH has host, Docker has image, etc.
   */
  selectedRuntime: ParsedRuntime;
  /** Persisted default runtime choice for this project (used to initialize selection) */
  defaultRuntimeMode: RuntimeChoice;
  trunkBranch: string;
}

interface SshRuntimeConfig {
  host: string;
  coder?: CoderWorkspaceConfig;
}

const buildRuntimeForMode = (
  mode: RuntimeMode,
  sshConfig: SshRuntimeConfig,
  dockerImage: string,
  dockerShareCredentials: boolean,
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
        sshConfig.coder && !sshConfig.host.trim() ? CODER_RUNTIME_PLACEHOLDER : sshConfig.host;

      return {
        mode: "ssh",
        host: effectiveHost,
        coder: sshConfig.coder,
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

  const projectScopeId = getProjectScopeId(projectPath);

  const [agentId] = usePersistedState<string>(
    getAgentIdKey(projectScopeId),
    WORKSPACE_DEFAULTS.agentId,
    { listener: true }
  );

  // Project-scoped model preference (persisted per project)
  const [model] = usePersistedState<string>(getModelKey(projectScopeId), getDefaultModel(), {
    listener: true,
  });

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

  const readRuntimeConfigFrom = <T>(
    configs: LastRuntimeConfigs,
    mode: RuntimeMode,
    field: string,
    defaultValue: T
  ): T => {
    const modeConfig = configs[mode];
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

  // Generic reader for lastRuntimeConfigs fields
  const readRuntimeConfig = <T>(mode: RuntimeMode, field: string, defaultValue: T): T => {
    return readRuntimeConfigFrom(lastRuntimeConfigs, mode, field, defaultValue);
  };

  // Hide Coder-specific persistence fields behind a helper so callsites stay clean.
  const readSshRuntimeConfig = (configs: LastRuntimeConfigs): SshRuntimeConfig => {
    const host = readRuntimeConfigFrom(configs, RUNTIME_MODE.SSH, "host", "");
    const coderEnabled = readRuntimeConfigFrom(configs, RUNTIME_MODE.SSH, "coderEnabled", false);
    const coderConfig = readRuntimeConfigFrom<CoderWorkspaceConfig | null>(
      configs,
      RUNTIME_MODE.SSH,
      "coderConfig",
      null
    );

    return {
      host,
      coder: coderEnabled && coderConfig ? coderConfig : undefined,
    };
  };

  const lastSsh = readSshRuntimeConfig(lastRuntimeConfigs);
  const lastDockerImage = readRuntimeConfig(RUNTIME_MODE.DOCKER, "image", "");
  const lastShareCredentials = readRuntimeConfig(RUNTIME_MODE.DOCKER, "shareCredentials", false);
  const lastDevcontainerConfigPath = readRuntimeConfig(RUNTIME_MODE.DEVCONTAINER, "configPath", "");
  const lastDevcontainerShareCredentials = readRuntimeConfig(
    RUNTIME_MODE.DEVCONTAINER,
    "shareCredentials",
    false
  );

  const coderDefaultFromString =
    parsedDefault?.mode === RUNTIME_MODE.SSH && parsedDefault.host === CODER_RUNTIME_PLACEHOLDER;
  // Keep the UI's default checkbox aligned with persisted Coder defaults without extra flags.
  const defaultRuntimeChoice: RuntimeChoice =
    defaultRuntimeMode === RUNTIME_MODE.SSH && (coderDefaultFromString || lastSsh.coder)
      ? "coder"
      : defaultRuntimeMode;

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

  // Persist SSH config while keeping the legacy field shape hidden from callsites.
  const writeSshRuntimeConfig = useCallback(
    (config: SshRuntimeConfig) => {
      if (config.host.trim() && config.host !== CODER_RUNTIME_PLACEHOLDER) {
        setLastRuntimeConfig(RUNTIME_MODE.SSH, "host", config.host);
      }
      const coderEnabled = config.coder !== undefined;
      setLastRuntimeConfig(RUNTIME_MODE.SSH, "coderEnabled", coderEnabled);
      if (config.coder) {
        setLastRuntimeConfig(RUNTIME_MODE.SSH, "coderConfig", config.coder);
      }
    },
    [setLastRuntimeConfig]
  );

  // If the default runtime string contains a host/image (e.g. older persisted values like "ssh devbox"),
  // prefer it as the initial remembered value.
  useEffect(() => {
    if (
      parsedDefault?.mode === RUNTIME_MODE.SSH &&
      !lastSsh.host.trim() &&
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
    lastSsh.host,
    lastDockerImage,
    lastDevcontainerConfigPath,
    setLastRuntimeConfig,
  ]);

  const defaultSshHost =
    parsedDefault?.mode === RUNTIME_MODE.SSH ? parsedDefault.host : lastSsh.host;

  const defaultDockerImage =
    parsedDefault?.mode === RUNTIME_MODE.DOCKER ? parsedDefault.image : lastDockerImage;

  const defaultDevcontainerConfigPath =
    parsedDefault?.mode === RUNTIME_MODE.DEVCONTAINER && parsedDefault.configPath.trim()
      ? parsedDefault.configPath
      : lastDevcontainerConfigPath;

  const defaultRuntime = buildRuntimeForMode(
    defaultRuntimeMode,
    { host: defaultSshHost, coder: lastSsh.coder },
    defaultDockerImage,
    lastShareCredentials,
    defaultDevcontainerConfigPath,
    lastDevcontainerShareCredentials
  );

  // Currently selected runtime for this session (initialized from default)
  // Uses discriminated union: SSH has host, Docker has image
  const [selectedRuntime, setSelectedRuntimeState] = useState<ParsedRuntime>(() => defaultRuntime);

  const prevProjectPathRef = useRef<string | null>(null);
  const prevDefaultRuntimeModeRef = useRef<RuntimeMode | null>(null);

  // When switching projects or changing the persisted default mode, reset the selection.
  // Importantly: do NOT reset selection when lastSsh.host/lastDockerImage changes while typing.
  useEffect(() => {
    const projectChanged = prevProjectPathRef.current !== projectPath;
    const defaultModeChanged = prevDefaultRuntimeModeRef.current !== defaultRuntimeMode;

    if (projectChanged || defaultModeChanged) {
      setSelectedRuntimeState(
        buildRuntimeForMode(
          defaultRuntimeMode,
          { host: defaultSshHost, coder: lastSsh.coder },
          defaultDockerImage,
          lastShareCredentials,
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
    lastSsh.coder,
    defaultDevcontainerConfigPath,
    lastDevcontainerShareCredentials,
  ]);

  // When the user switches into SSH/Docker/Devcontainer mode, seed the field with the remembered config.
  // This avoids clearing the last values when the UI switches modes with an empty field.
  // Skip on initial mount (prevMode === null) since useState initializer handles that case.
  const prevSelectedRuntimeModeRef = useRef<RuntimeMode | null>(null);
  useEffect(() => {
    const prevMode = prevSelectedRuntimeModeRef.current;
    if (prevMode !== null && prevMode !== selectedRuntime.mode) {
      if (selectedRuntime.mode === RUNTIME_MODE.SSH) {
        const needsHostRestore = !selectedRuntime.host.trim() && lastSsh.host.trim();
        const needsCoderRestore = selectedRuntime.coder === undefined && lastSsh.coder != null;
        if (needsHostRestore || needsCoderRestore) {
          setSelectedRuntimeState({
            mode: RUNTIME_MODE.SSH,
            host: needsHostRestore ? lastSsh.host : selectedRuntime.host,
            coder: needsCoderRestore ? lastSsh.coder : selectedRuntime.coder,
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
    lastSsh.host,
    lastDockerImage,
    lastShareCredentials,
    lastSsh.coder,
    lastDevcontainerConfigPath,
    lastDevcontainerShareCredentials,
  ]);

  // Initialize trunk branch from backend recommendation or first branch
  useEffect(() => {
    if (branches.length > 0 && (!trunkBranch || !branches.includes(trunkBranch))) {
      const defaultBranch = recommendedTrunk ?? branches[0];
      setTrunkBranch(defaultBranch);
    }
  }, [branches, recommendedTrunk, trunkBranch, setTrunkBranch]);

  // Setter for selected runtime (also persists host/image/coder for future mode switches)
  const setSelectedRuntime = (runtime: ParsedRuntime) => {
    setSelectedRuntimeState(runtime);

    // Persist host/image/coder so they're remembered when switching modes.
    // Avoid wiping the remembered value when the UI switches modes with an empty field.
    // Avoid persisting the Coder placeholder as the remembered SSH host.
    if (runtime.mode === RUNTIME_MODE.SSH) {
      writeSshRuntimeConfig({ host: runtime.host, coder: runtime.coder });
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
    // Read persisted SSH config so the default snapshot reflects the latest toggle state.
    const freshRuntimeConfigs = readPersistedState<LastRuntimeConfigs>(
      getLastRuntimeConfigKey(projectPath),
      {}
    );
    const freshSsh = readSshRuntimeConfig(freshRuntimeConfigs);

    const newRuntime = buildRuntimeForMode(
      newMode,
      freshSsh,
      lastDockerImage,
      lastShareCredentials,
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
      agentId,
      selectedRuntime,
      defaultRuntimeMode: defaultRuntimeChoice,
      trunkBranch,
    },
    setSelectedRuntime,
    setDefaultRuntimeMode,
    setTrunkBranch,
    getRuntimeString,
  };
}
