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

export function getFirstProjectPath(
  projects: Map<string, ProjectConfig>,
  options?: { excludeProjectPath?: string | null }
): string | null {
  const excludeProjectPath = options?.excludeProjectPath ?? null;
  for (const projectPath of projects.keys()) {
    if (excludeProjectPath && projectPath === excludeProjectPath) {
      continue;
    }
    return projectPath;
  }
  return null;
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
  /** Workspace creation is disallowed in the Chat with Mux system project. */
  muxChatProjectPath?: string | null;
}

function resolveProjectPath(
  projects: Map<string, ProjectConfig>,
  requestedPath: string,
  muxChatProjectPath: string | null
): string | null {
  if (requestedPath !== muxChatProjectPath && projects.has(requestedPath)) {
    return requestedPath;
  }

  return getFirstProjectPath(projects, { excludeProjectPath: muxChatProjectPath });
}

export function useStartWorkspaceCreation({
  projects,
  createWorkspaceDraft,
  muxChatProjectPath,
}: UseStartWorkspaceCreationOptions) {
  const startWorkspaceCreation = useCallback(
    (projectPath: string, detail?: StartWorkspaceCreationDetail) => {
      const resolvedProjectPath = resolveProjectPath(
        projects,
        projectPath,
        muxChatProjectPath ?? null
      );

      if (!resolvedProjectPath) {
        console.warn("No projects available for workspace creation");
        return;
      }

      const draftId = createWorkspaceDraft(resolvedProjectPath);
      persistWorkspaceCreationPrefill(resolvedProjectPath, detail, { draftId });
    },
    [projects, createWorkspaceDraft, muxChatProjectPath]
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
