import { useCallback, useEffect } from "react";
import type { ProjectConfig } from "@/node/config";
import { CUSTOM_EVENTS, type CustomEventPayloads } from "@/common/constants/events";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getDraftScopeId,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getProjectScopeId,
  getTrunkBranchKey,
} from "@/common/constants/storage";

export type StartWorkspaceCreationDetail =
  CustomEventPayloads[typeof CUSTOM_EVENTS.START_WORKSPACE_CREATION];

export function getFirstProjectPath(projects: Map<string, ProjectConfig>): string | null {
  const iterator = projects.keys().next();
  return iterator.done ? null : iterator.value;
}

type PersistFn = typeof updatePersistedState;

interface PersistWorkspaceCreationPrefillOptions {
  draftId?: string | null;
  persist?: PersistFn;
}

export function persistWorkspaceCreationPrefill(
  projectPath: string,
  detail: StartWorkspaceCreationDetail | undefined,
  options?: PersistWorkspaceCreationPrefillOptions
): void {
  if (!detail) {
    return;
  }

  const persist = options?.persist ?? updatePersistedState;
  const draftId = options?.draftId;

  if (detail.startMessage !== undefined) {
    const scopeId =
      typeof draftId === "string" && draftId.trim().length > 0
        ? getDraftScopeId(projectPath, draftId)
        : getPendingScopeId(projectPath);

    persist(getInputKey(scopeId), detail.startMessage);
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

  // Note: runtime is intentionally NOT persisted here - it's a one-time override.
  // The default runtime can only be changed via the icon selector.
}

interface UseStartWorkspaceCreationOptions {
  projects: Map<string, ProjectConfig>;
  createWorkspaceDraft: (projectPath: string) => string;
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
  createWorkspaceDraft,
}: UseStartWorkspaceCreationOptions) {
  const startWorkspaceCreation = useCallback(
    (projectPath: string, detail?: StartWorkspaceCreationDetail) => {
      const resolvedProjectPath = resolveProjectPath(projects, projectPath);

      if (!resolvedProjectPath) {
        console.warn("No projects available for workspace creation");
        return;
      }

      const draftId = createWorkspaceDraft(resolvedProjectPath);
      persistWorkspaceCreationPrefill(resolvedProjectPath, detail, { draftId });
    },
    [projects, createWorkspaceDraft]
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
