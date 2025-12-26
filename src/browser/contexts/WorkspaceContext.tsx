import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  deleteWorkspaceStorage,
  getModelKey,
  getThinkingLevelKey,
  SELECTED_WORKSPACE_KEY,
} from "@/common/constants/storage";
import { useAPI } from "@/browser/contexts/API";
import { readPersistedState, updatePersistedState } from "@/browser/hooks/usePersistedState";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { isExperimentEnabled } from "@/browser/hooks/useExperiments";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { useRouter } from "@/browser/contexts/RouterContext";

/**
 * Seed per-workspace localStorage from backend workspace metadata.
 *
 * This keeps a workspace's model/thinking consistent across devices/browsers.
 */
function seedWorkspaceLocalStorageFromBackend(metadata: FrontendWorkspaceMetadata): void {
  const ai = metadata.aiSettings;
  if (!ai) {
    return;
  }

  // Seed model selection.
  if (typeof ai.model === "string" && ai.model.length > 0) {
    const modelKey = getModelKey(metadata.id);
    const existingModel = readPersistedState<string | undefined>(modelKey, undefined);
    if (existingModel !== ai.model) {
      updatePersistedState(modelKey, ai.model);
    }
  }

  // Seed thinking level.
  if (ai.thinkingLevel) {
    const thinkingKey = getThinkingLevelKey(metadata.id);
    const existingThinking = readPersistedState<ThinkingLevel | undefined>(thinkingKey, undefined);
    if (existingThinking !== ai.thinkingLevel) {
      updatePersistedState(thinkingKey, ai.thinkingLevel);
    }
  }
}

export function toWorkspaceSelection(metadata: FrontendWorkspaceMetadata): WorkspaceSelection {
  return {
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    projectName: metadata.projectName,
    namedWorkspacePath: metadata.namedWorkspacePath,
  };
}

/**
 * Ensure workspace metadata has createdAt timestamp.
 * DEFENSIVE: Backend guarantees createdAt, but default to 2025-01-01 if missing.
 * This prevents crashes if backend contract is violated.
 */
function ensureCreatedAt(metadata: FrontendWorkspaceMetadata): void {
  if (!metadata.createdAt) {
    console.warn(
      `[Frontend] Workspace ${metadata.id} missing createdAt - using default (2025-01-01)`
    );
    metadata.createdAt = "2025-01-01T00:00:00.000Z";
  }
}

export interface WorkspaceContext {
  // Workspace data
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  loading: boolean;

  // Workspace operations
  createWorkspace: (
    projectPath: string,
    branchName: string,
    trunkBranch: string,
    runtimeConfig?: RuntimeConfig
  ) => Promise<{
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
    workspaceId: string;
  }>;
  removeWorkspace: (
    workspaceId: string,
    options?: { force?: boolean }
  ) => Promise<{ success: boolean; error?: string }>;
  renameWorkspace: (
    workspaceId: string,
    newName: string
  ) => Promise<{ success: boolean; error?: string }>;
  archiveWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  unarchiveWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  refreshWorkspaceMetadata: () => Promise<void>;
  setWorkspaceMetadata: React.Dispatch<
    React.SetStateAction<Map<string, FrontendWorkspaceMetadata>>
  >;

  // Selection
  selectedWorkspace: WorkspaceSelection | null;
  setSelectedWorkspace: React.Dispatch<React.SetStateAction<WorkspaceSelection | null>>;

  // Workspace creation flow
  pendingNewWorkspaceProject: string | null;
  beginWorkspaceCreation: (projectPath: string) => void;

  // Helpers
  getWorkspaceInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
}

const WorkspaceContext = createContext<WorkspaceContext | undefined>(undefined);

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const { api } = useAPI();
  // Get project refresh function from ProjectContext
  const { refreshProjects } = useProjectContext();
  // Get router navigation functions and current route state
  const {
    navigateToWorkspace,
    navigateToProject,
    navigateToHome,
    currentWorkspaceId,
    currentProjectPath,
  } = useRouter();

  const workspaceStore = useWorkspaceStoreRaw();
  const [workspaceMetadata, setWorkspaceMetadataState] = useState<
    Map<string, FrontendWorkspaceMetadata>
  >(new Map());
  const setWorkspaceMetadata = useCallback(
    (update: SetStateAction<Map<string, FrontendWorkspaceMetadata>>) => {
      setWorkspaceMetadataState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        // IMPORTANT: Sync the imperative WorkspaceStore first so hooks (AIView,
        // LeftSidebar, etc.) never render with a selected workspace ID before
        // the store has subscribed and created its aggregator. Otherwise the
        // render path hits WorkspaceStore.assertGet() and throws the
        // "Workspace <id> not found - must call addWorkspace() first" assert.
        workspaceStore.syncWorkspaces(next);
        return next;
      });
    },
    [workspaceStore]
  );
  const [loading, setLoading] = useState(true);

  // pendingNewWorkspaceProject is derived from currentProjectPath in URL
  const pendingNewWorkspaceProject = currentProjectPath;

  // selectedWorkspace is derived from currentWorkspaceId in URL + workspaceMetadata
  const selectedWorkspace = useMemo(() => {
    if (!currentWorkspaceId) return null;
    const metadata = workspaceMetadata.get(currentWorkspaceId);
    if (!metadata) return null;
    return toWorkspaceSelection(metadata);
  }, [currentWorkspaceId, workspaceMetadata]);

  // Keep a ref to the current selectedWorkspace for use in functional updates.
  // This ensures setSelectedWorkspace always has access to the latest value,
  // avoiding stale closure issues when called with a functional updater.
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  useEffect(() => {
    selectedWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace]);

  // setSelectedWorkspace navigates to the workspace URL (or clears if null)
  const setSelectedWorkspace = useCallback(
    (update: SetStateAction<WorkspaceSelection | null>) => {
      // Handle functional updates by resolving against the ref (always fresh)
      const current = selectedWorkspaceRef.current;
      const newValue = typeof update === "function" ? update(current) : update;
      if (newValue) {
        navigateToWorkspace(newValue.workspaceId);
        // Persist to localStorage for next session
        updatePersistedState(SELECTED_WORKSPACE_KEY, newValue);
      } else {
        navigateToHome();
        updatePersistedState(SELECTED_WORKSPACE_KEY, null);
      }
    },
    [navigateToWorkspace, navigateToHome]
  );

  // Used by async subscription handlers to safely access the most recent metadata map
  // without triggering render-phase state updates.
  const workspaceMetadataRef = useRef(workspaceMetadata);
  useEffect(() => {
    workspaceMetadataRef.current = workspaceMetadata;
  }, [workspaceMetadata]);

  const loadWorkspaceMetadata = useCallback(async () => {
    if (!api) return false; // Return false to indicate metadata wasn't loaded
    try {
      const includePostCompaction = isExperimentEnabled(EXPERIMENT_IDS.POST_COMPACTION_CONTEXT);
      const metadataList = await api.workspace.list({ includePostCompaction });
      console.log(
        "[WorkspaceContext] Loaded metadata list:",
        metadataList.map((m) => ({ id: m.id, name: m.name, title: m.title }))
      );
      const metadataMap = new Map<string, FrontendWorkspaceMetadata>();
      for (const metadata of metadataList) {
        // Skip archived workspaces - they should not be tracked by the app
        if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) continue;
        ensureCreatedAt(metadata);
        // Use stable workspace ID as key (not path, which can change)
        seedWorkspaceLocalStorageFromBackend(metadata);
        metadataMap.set(metadata.id, metadata);
      }
      setWorkspaceMetadata(metadataMap);
      return true; // Return true to indicate metadata was loaded
    } catch (error) {
      console.error("Failed to load workspace metadata:", error);
      setWorkspaceMetadata(new Map());
      return true; // Still return true - we tried to load, just got empty result
    }
  }, [setWorkspaceMetadata, api]);

  // Load metadata once on mount (and again when api becomes available)
  useEffect(() => {
    void (async () => {
      const loaded = await loadWorkspaceMetadata();
      if (!loaded) {
        // api not available yet - effect will run again when api connects
        return;
      }
      // After loading metadata (which may trigger migration), reload projects
      // to ensure frontend has the updated config with workspace IDs
      await refreshProjects();
      setLoading(false);
    })();
  }, [loadWorkspaceMetadata, refreshProjects]);

  // URL restoration is now handled by RouterContext which parses the URL on load
  // and provides currentWorkspaceId/currentProjectPath that we derive state from.

  // Check for launch project from server (for --add-project flag)
  // This only applies in server mode, runs after metadata loads
  useEffect(() => {
    if (loading || !api) return;

    // Skip if we already have a selected workspace (from localStorage or URL hash)
    if (selectedWorkspace) return;

    // Skip if user is in the middle of creating a workspace
    if (pendingNewWorkspaceProject) return;

    let cancelled = false;

    const checkLaunchProject = async () => {
      // Only available in server mode (checked via platform/capabilities in future)
      // For now, try the call - it will return null if not applicable
      try {
        const launchProjectPath = await api.server.getLaunchProject(undefined);
        if (cancelled || !launchProjectPath) return;

        // Find first workspace in this project
        const projectWorkspaces = Array.from(workspaceMetadata.values()).filter(
          (meta) => meta.projectPath === launchProjectPath
        );

        if (cancelled || projectWorkspaces.length === 0) return;

        // Select the first workspace in the project.
        // Use functional update to avoid race: user may have clicked a workspace
        // while this async call was in flight.
        const metadata = projectWorkspaces[0];
        setSelectedWorkspace((current) => current ?? toWorkspaceSelection(metadata));
      } catch (error) {
        if (!cancelled) {
          // Ignore errors (e.g. method not found if running against old backend)
          console.debug("Failed to check launch project:", error);
        }
      }
      // If no workspaces exist yet, just leave the project in the sidebar
      // The user will need to create a workspace
    };

    void checkLaunchProject();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    loading,
    selectedWorkspace,
    pendingNewWorkspaceProject,
    workspaceMetadata,
    setSelectedWorkspace,
  ]);

  // Subscribe to metadata updates (for create/rename/delete operations)
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.workspace.onMetadata(undefined, { signal });

        for await (const event of iterator) {
          if (signal.aborted) break;

          if (event.metadata === null) {
            // Workspace deleted - clean up workspace-scoped persisted state.
            deleteWorkspaceStorage(event.workspaceId);

            // If the user is currently viewing a deleted child workspace, fall back to its parent.
            // Otherwise, fall back to another workspace in the same project (best effort).
            const deletedMeta = workspaceMetadataRef.current.get(event.workspaceId);
            setSelectedWorkspace((current) => {
              if (current?.workspaceId !== event.workspaceId) {
                return current;
              }

              const parentWorkspaceId = deletedMeta?.parentWorkspaceId;
              if (parentWorkspaceId) {
                const parentMeta = workspaceMetadataRef.current.get(parentWorkspaceId);
                if (parentMeta) {
                  return {
                    workspaceId: parentMeta.id,
                    projectPath: parentMeta.projectPath,
                    projectName: parentMeta.projectName,
                    namedWorkspacePath: parentMeta.namedWorkspacePath,
                  };
                }
              }

              const projectPath = deletedMeta?.projectPath;
              const fallbackMeta =
                (projectPath
                  ? Array.from(workspaceMetadataRef.current.values()).find(
                      (meta) => meta.projectPath === projectPath && meta.id !== event.workspaceId
                    )
                  : null) ??
                Array.from(workspaceMetadataRef.current.values()).find(
                  (meta) => meta.id !== event.workspaceId
                );
              if (!fallbackMeta) {
                return null;
              }

              return {
                workspaceId: fallbackMeta.id,
                projectPath: fallbackMeta.projectPath,
                projectName: fallbackMeta.projectName,
                namedWorkspacePath: fallbackMeta.namedWorkspacePath,
              };
            });
          }

          if (event.metadata !== null) {
            ensureCreatedAt(event.metadata);
            seedWorkspaceLocalStorageFromBackend(event.metadata);
          }

          setWorkspaceMetadata((prev) => {
            const updated = new Map(prev);
            const isNewWorkspace = !prev.has(event.workspaceId) && event.metadata !== null;
            // Detect transition from "creating" to ready for pending workspace state
            const existingMeta = prev.get(event.workspaceId);
            const wasCreating = existingMeta?.status === "creating";
            const isNowReady = event.metadata !== null && event.metadata.status !== "creating";

            if (event.metadata === null) {
              // Workspace deleted - remove from map
              updated.delete(event.workspaceId);
            } else {
              updated.set(event.workspaceId, event.metadata);
            }

            // Reload projects when:
            // 1. New workspace appears (e.g., from fork)
            // 2. Workspace transitions from "creating" to ready (now saved to config)
            if (isNewWorkspace || (wasCreating && isNowReady)) {
              void refreshProjects();
            }

            return updated;
          });
        }
      } catch (err) {
        if (!signal.aborted) {
          console.error("Failed to subscribe to metadata:", err);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [refreshProjects, setSelectedWorkspace, setWorkspaceMetadata, api]);

  const createWorkspace = useCallback(
    async (
      projectPath: string,
      branchName: string,
      trunkBranch: string,
      runtimeConfig?: RuntimeConfig
    ) => {
      if (!api) throw new Error("API not connected");
      console.assert(
        typeof trunkBranch === "string" && trunkBranch.trim().length > 0,
        "Expected trunk branch to be provided when creating a workspace"
      );
      const result = await api.workspace.create({
        projectPath,
        branchName,
        trunkBranch,
        runtimeConfig,
      });
      if (result.success) {
        // Backend has already updated the config - reload projects to get updated state
        await refreshProjects();

        // Update metadata immediately to avoid race condition with validation effect
        ensureCreatedAt(result.metadata);
        seedWorkspaceLocalStorageFromBackend(result.metadata);
        setWorkspaceMetadata((prev) => {
          const updated = new Map(prev);
          updated.set(result.metadata.id, result.metadata);
          return updated;
        });

        // Return the new workspace selection
        return {
          projectPath,
          projectName: result.metadata.projectName,
          namedWorkspacePath: result.metadata.namedWorkspacePath,
          workspaceId: result.metadata.id,
        };
      } else {
        throw new Error(result.error);
      }
    },
    [api, refreshProjects, setWorkspaceMetadata]
  );

  const removeWorkspace = useCallback(
    async (
      workspaceId: string,
      options?: { force?: boolean }
    ): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.remove({ workspaceId, options });
        if (result.success) {
          // Clean up workspace-specific localStorage keys
          deleteWorkspaceStorage(workspaceId);

          // Backend has already updated the config - reload projects to get updated state
          await refreshProjects();

          // Reload workspace metadata
          await loadWorkspaceMetadata();

          // Clear selected workspace if it was removed
          // Use functional update to check *current* selection, not stale closure value
          setSelectedWorkspace((current) =>
            current?.workspaceId === workspaceId ? null : current
          );
          return { success: true };
        } else {
          console.error("Failed to remove workspace:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to remove workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [loadWorkspaceMetadata, refreshProjects, setSelectedWorkspace, api]
  );

  /**
   * Update workspace title (formerly "rename").
   * Unlike the old rename which changed the git branch/directory name,
   * this only updates the display title and can be called during streaming.
   *
   * Note: This is simpler than the old rename because the workspace ID doesn't change.
   * We just reload metadata after the update - no need to update selectedWorkspace
   * since the ID stays the same and the metadata map refresh handles the title update.
   */
  const renameWorkspace = useCallback(
    async (
      workspaceId: string,
      newTitle: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.updateTitle({ workspaceId, title: newTitle });
        if (result.success) {
          // Reload workspace metadata to get the updated title
          await loadWorkspaceMetadata();
          return { success: true };
        } else {
          console.error("Failed to update workspace title:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to update workspace title:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [loadWorkspaceMetadata, api]
  );

  const archiveWorkspace = useCallback(
    async (workspaceId: string): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.archive({ workspaceId });
        if (result.success) {
          // Reload workspace metadata to get the updated state
          await loadWorkspaceMetadata();
          // Clear selected workspace if it was archived
          setSelectedWorkspace((current) =>
            current?.workspaceId === workspaceId ? null : current
          );
          return { success: true };
        } else {
          console.error("Failed to archive workspace:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to archive workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [loadWorkspaceMetadata, setSelectedWorkspace, api]
  );

  const unarchiveWorkspace = useCallback(
    async (workspaceId: string): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.unarchive({ workspaceId });
        if (result.success) {
          // Reload workspace metadata to get the updated state
          await loadWorkspaceMetadata();
          return { success: true };
        } else {
          console.error("Failed to unarchive workspace:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("Failed to unarchive workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [loadWorkspaceMetadata, api]
  );

  const refreshWorkspaceMetadata = useCallback(async () => {
    await loadWorkspaceMetadata();
  }, [loadWorkspaceMetadata]);

  const getWorkspaceInfo = useCallback(
    async (workspaceId: string) => {
      if (!api) return null;
      const metadata = await api.workspace.getInfo({ workspaceId });
      if (metadata) {
        ensureCreatedAt(metadata);
        seedWorkspaceLocalStorageFromBackend(metadata);
      }
      return metadata;
    },
    [api]
  );

  const beginWorkspaceCreation = useCallback(
    (projectPath: string) => {
      navigateToProject(projectPath);
    },
    [navigateToProject]
  );

  const value = useMemo<WorkspaceContext>(
    () => ({
      workspaceMetadata,
      loading,
      createWorkspace,
      removeWorkspace,
      renameWorkspace,
      archiveWorkspace,
      unarchiveWorkspace,
      refreshWorkspaceMetadata,
      setWorkspaceMetadata,
      selectedWorkspace,
      setSelectedWorkspace,
      pendingNewWorkspaceProject,
      beginWorkspaceCreation,
      getWorkspaceInfo,
    }),
    [
      workspaceMetadata,
      loading,
      createWorkspace,
      removeWorkspace,
      renameWorkspace,
      archiveWorkspace,
      unarchiveWorkspace,
      refreshWorkspaceMetadata,
      setWorkspaceMetadata,
      selectedWorkspace,
      setSelectedWorkspace,
      pendingNewWorkspaceProject,
      beginWorkspaceCreation,
      getWorkspaceInfo,
    ]
  );

  return <WorkspaceContext.Provider value={value}>{props.children}</WorkspaceContext.Provider>;
}

export function useWorkspaceContext(): WorkspaceContext {
  const context = useContext(WorkspaceContext);
  if (!context) {
    throw new Error("useWorkspaceContext must be used within WorkspaceProvider");
  }
  return context;
}
