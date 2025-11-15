import { useCallback, useEffect } from "react";
import type { ProjectConfig } from "@/config";
import type { WorkspaceSelection } from "@/components/ProjectSidebar";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/constants/events";
import { updatePersistedState } from "@/hooks/usePersistedState";
import {
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getRuntimeKey,
  getTrunkBranchKey,
} from "@/constants/storage";
import { RUNTIME_MODE, SSH_RUNTIME_PREFIX } from "@/types/runtime";

export type StartWorkspaceCreationDetail =
  CustomEventPayloads[typeof CUSTOM_EVENTS.START_WORKSPACE_CREATION];

export function normalizeRuntimePreference(runtime: string | undefined): string | undefined {
  if (!runtime) {
    return undefined;
  }

  const trimmed = runtime.trim();
  if (!trimmed) {
    return undefined;
  }

  const lower = trimmed.toLowerCase();
  if (lower === RUNTIME_MODE.LOCAL) {
    return undefined;
  }

  if (lower === RUNTIME_MODE.SSH) {
    return RUNTIME_MODE.SSH;
  }

  if (lower.startsWith(SSH_RUNTIME_PREFIX)) {
    const host = trimmed.slice(SSH_RUNTIME_PREFIX.length).trim();
    return host ? `${RUNTIME_MODE.SSH} ${host}` : RUNTIME_MODE.SSH;
  }

  return trimmed;
}

export function getFirstProjectPath(projects: Map<string, ProjectConfig>): string | null {
  const iterator = projects.keys().next();
  return iterator.done ? null : iterator.value;
}

type PersistFn = typeof updatePersistedState;

export function persistWorkspaceCreationPrefill(
  projectPath: string,
  detail: StartWorkspaceCreationDetail | undefined,
  persist: PersistFn = updatePersistedState
): void {
  if (!detail) {
    return;
  }

  if (detail.startMessage !== undefined) {
    persist(getInputKey(getPendingScopeId(projectPath)), detail.startMessage);
  }

  if (detail.model !== undefined) {
    persist(getModelKey(getProjectScopeId(projectPath)), detail.model);
  }

  if (detail.trunkBranch !== undefined) {
    const normalizedTrunk = detail.trunkBranch.trim();
    persist(
      getTrunkBranchKey(projectPath),
      normalizedTrunk.length > 0 ? normalizedTrunk : undefined
    );
  }

  if (detail.runtime !== undefined) {
    const normalizedRuntime = normalizeRuntimePreference(detail.runtime);
    persist(getRuntimeKey(projectPath), normalizedRuntime);
  }
}

interface UseStartWorkspaceCreationOptions {
  projects: Map<string, ProjectConfig>;
  beginWorkspaceCreation: (projectPath: string) => void;
  setSelectedWorkspace: (selection: WorkspaceSelection | null) => void;
}

function resolveProjectPath(
  projects: Map<string, ProjectConfig>,
  requestedPath: string
): string | null {
  if (projects.has(requestedPath)) {
    return requestedPath;
  }

  return getFirstProjectPath(projects);
}

export function useStartWorkspaceCreation({
  projects,
  beginWorkspaceCreation,
  setSelectedWorkspace,
}: UseStartWorkspaceCreationOptions) {
  const startWorkspaceCreation = useCallback(
    (projectPath: string, detail?: StartWorkspaceCreationDetail) => {
      const resolvedProjectPath = resolveProjectPath(projects, projectPath);

      if (!resolvedProjectPath) {
        console.warn("No projects available for workspace creation");
        return;
      }

      persistWorkspaceCreationPrefill(resolvedProjectPath, detail);
      beginWorkspaceCreation(resolvedProjectPath);
      setSelectedWorkspace(null);
    },
    [projects, beginWorkspaceCreation, setSelectedWorkspace]
  );

  useEffect(() => {
    const handleStartCreation = (event: Event) => {
      const customEvent = event as CustomEvent<StartWorkspaceCreationDetail | undefined>;
      const detail = customEvent.detail;

      if (!detail?.projectPath) {
        console.warn("START_WORKSPACE_CREATION event missing projectPath detail");
        return;
      }

      startWorkspaceCreation(detail.projectPath, detail);
    };

    window.addEventListener(
      CUSTOM_EVENTS.START_WORKSPACE_CREATION,
      handleStartCreation as EventListener
    );

    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.START_WORKSPACE_CREATION,
        handleStartCreation as EventListener
      );
  }, [startWorkspaceCreation]);

  return startWorkspaceCreation;
}
