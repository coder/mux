import { useEffect, useCallback, useRef } from "react";
import "./styles/globals.css";
import { useWorkspaceContext } from "./contexts/WorkspaceContext";
import { useProjectContext } from "./contexts/ProjectContext";
import type { WorkspaceSelection } from "./components/ProjectSidebar";
import { LeftSidebar } from "./components/LeftSidebar";
import { ProjectCreateModal } from "./components/ProjectCreateModal";
import { AIView } from "./components/AIView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { usePersistedState, updatePersistedState } from "./hooks/usePersistedState";
import { matchesKeybind, KEYBINDS } from "./utils/ui/keybinds";
import { buildSortedWorkspacesByProject } from "./utils/ui/workspaceFiltering";
import { useResumeManager } from "./hooks/useResumeManager";
import { useUnreadTracking } from "./hooks/useUnreadTracking";
import { useWorkspaceStoreRaw, useWorkspaceRecency } from "./stores/WorkspaceStore";
import { ChatInput } from "./components/ChatInput/index";
import type { ChatInputAPI } from "./components/ChatInput/types";

import { useStableReference, compareMaps } from "./hooks/useStableReference";
import { CommandRegistryProvider, useCommandRegistry } from "./contexts/CommandRegistryContext";
import { useOpenTerminal } from "./hooks/useOpenTerminal";
import type { CommandAction } from "./contexts/CommandRegistryContext";
import { ModeProvider } from "./contexts/ModeContext";
import { ProviderOptionsProvider } from "./contexts/ProviderOptionsContext";
import { ThemeProvider, useTheme, type ThemeMode } from "./contexts/ThemeContext";
import { ThinkingProvider } from "./contexts/ThinkingContext";
import { CommandPalette } from "./components/CommandPalette";
import { buildCoreSources, type BuildSourcesParams } from "./utils/commands/sources";

import type { ThinkingLevel } from "@/common/types/thinking";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { isWorkspaceForkSwitchEvent } from "./utils/workspaceEvents";
import { getThinkingLevelKey } from "@/common/constants/storage";
import type { BranchListResult } from "@/common/orpc/types";
import { useTelemetry } from "./hooks/useTelemetry";
import { getRuntimeTypeForTelemetry } from "@/common/telemetry";
import { useStartWorkspaceCreation, getFirstProjectPath } from "./hooks/useStartWorkspaceCreation";
import { useAPI } from "@/browser/contexts/API";
import { AuthTokenModal } from "@/browser/components/AuthTokenModal";

import { SettingsProvider, useSettings } from "./contexts/SettingsContext";
import { SettingsModal } from "./components/Settings/SettingsModal";
import { TutorialProvider } from "./contexts/TutorialContext";
import { TooltipProvider } from "./components/ui/tooltip";
import { ExperimentsProvider } from "./contexts/ExperimentsContext";
import { getWorkspaceSidebarKey } from "./utils/workspace";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

function AppInner() {
  // Get workspace state from context
  const {
    workspaceMetadata,
    setWorkspaceMetadata,
    removeWorkspace,
    renameWorkspace,
    selectedWorkspace,
    setSelectedWorkspace,
    pendingNewWorkspaceProject,
    beginWorkspaceCreation,
    clearPendingWorkspaceCreation,
  } = useWorkspaceContext();
  const { theme, setTheme, toggleTheme } = useTheme();
  const { open: openSettings } = useSettings();
  const setThemePreference = useCallback(
    (nextTheme: ThemeMode) => {
      setTheme(nextTheme);
    },
    [setTheme]
  );
  const { api, status, error, authenticate } = useAPI();

  const {
    projects,
    removeProject,
    openProjectCreateModal,
    isProjectCreateModalOpen,
    closeProjectCreateModal,
    addProject,
  } = useProjectContext();

  // Auto-collapse sidebar on mobile by default
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState("sidebarCollapsed", isMobile);
  const defaultProjectPath = getFirstProjectPath(projects);
  const creationChatInputRef = useRef<ChatInputAPI | null>(null);
  const creationProjectPath = !selectedWorkspace
    ? (pendingNewWorkspaceProject ?? (projects.size === 1 ? defaultProjectPath : null))
    : null;
  const handleCreationChatReady = useCallback((api: ChatInputAPI) => {
    creationChatInputRef.current = api;
    api.focus();
  }, []);

  const startWorkspaceCreation = useStartWorkspaceCreation({
    projects,
    beginWorkspaceCreation,
    setSelectedWorkspace,
  });

  useEffect(() => {
    if (creationProjectPath) {
      creationChatInputRef.current?.focus();
    }
  }, [creationProjectPath]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  // Telemetry tracking
  const telemetry = useTelemetry();

  // Get workspace store for command palette
  const workspaceStore = useWorkspaceStoreRaw();

  // Track telemetry when workspace selection changes
  const prevWorkspaceRef = useRef<WorkspaceSelection | null>(null);
  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    if (prev && selectedWorkspace && prev.workspaceId !== selectedWorkspace.workspaceId) {
      telemetry.workspaceSwitched(prev.workspaceId, selectedWorkspace.workspaceId);
    }
    prevWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace, telemetry]);

  // Track last-read timestamps for unread indicators
  const { lastReadTimestamps, onToggleUnread } = useUnreadTracking(selectedWorkspace);

  // Auto-resume interrupted streams on app startup and when failures occur
  useResumeManager();

  // Sync selectedWorkspace with URL hash
  useEffect(() => {
    if (selectedWorkspace) {
      // Update URL with workspace ID
      const newHash = `#workspace=${encodeURIComponent(selectedWorkspace.workspaceId)}`;
      if (window.location.hash !== newHash) {
        window.history.replaceState(null, "", newHash);
      }

      // Update window title with workspace title (or name for legacy workspaces)
      const metadata = workspaceMetadata.get(selectedWorkspace.workspaceId);
      const workspaceTitle = metadata?.title ?? metadata?.name ?? selectedWorkspace.workspaceId;
      const title = `${workspaceTitle} - ${selectedWorkspace.projectName} - mux`;
      // Set document.title locally for browser mode, call backend for Electron
      document.title = title;
      void api?.window.setTitle({ title });
    } else {
      // Clear hash when no workspace selected
      if (window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      // Set document.title locally for browser mode, call backend for Electron
      document.title = "mux";
      void api?.window.setTitle({ title: "mux" });
    }
  }, [selectedWorkspace, workspaceMetadata, api]);
  // Validate selected workspace exists and has all required fields
  useEffect(() => {
    if (selectedWorkspace) {
      const metadata = workspaceMetadata.get(selectedWorkspace.workspaceId);

      if (!metadata) {
        // Workspace was deleted
        console.warn(
          `Workspace ${selectedWorkspace.workspaceId} no longer exists, clearing selection`
        );
        setSelectedWorkspace(null);
        if (window.location.hash) {
          window.history.replaceState(null, "", window.location.pathname);
        }
      } else if (!selectedWorkspace.namedWorkspacePath && metadata.namedWorkspacePath) {
        // Old localStorage entry missing namedWorkspacePath - update it once
        console.log(`Updating workspace ${selectedWorkspace.workspaceId} with missing fields`);
        setSelectedWorkspace({
          workspaceId: metadata.id,
          projectPath: metadata.projectPath,
          projectName: metadata.projectName,
          namedWorkspacePath: metadata.namedWorkspacePath,
        });
      }
    }
  }, [selectedWorkspace, workspaceMetadata, setSelectedWorkspace]);

  const openWorkspaceInTerminal = useOpenTerminal();

  const handleRemoveProject = useCallback(
    async (path: string): Promise<{ success: boolean; error?: string }> => {
      if (selectedWorkspace?.projectPath === path) {
        setSelectedWorkspace(null);
      }
      return removeProject(path);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedWorkspace, setSelectedWorkspace]
  );

  // Memoize callbacks to prevent LeftSidebar/ProjectSidebar re-renders

  // NEW: Get workspace recency from store
  const workspaceRecency = useWorkspaceRecency();

  // Build sorted workspaces map including pending workspaces
  // Use stable reference to prevent sidebar re-renders when sort order hasn't changed
  const sortedWorkspacesByProject = useStableReference(
    () => buildSortedWorkspacesByProject(projects, workspaceMetadata, workspaceRecency),
    (prev, next) =>
      compareMaps(prev, next, (a, b) => {
        if (a.length !== b.length) return false;
        return a.every((meta, i) => {
          const other = b[i];
          // Compare all fields that affect sidebar display.
          // If you add a new display-relevant field to WorkspaceMetadata,
          // add it to getWorkspaceSidebarKey() in src/browser/utils/workspace.ts
          return other && getWorkspaceSidebarKey(meta) === getWorkspaceSidebarKey(other);
        });
      }),
    [projects, workspaceMetadata, workspaceRecency]
  );

  const handleNavigateWorkspace = useCallback(
    (direction: "next" | "prev") => {
      if (!selectedWorkspace) return;

      // Use sorted workspaces to match visual order in sidebar
      const sortedWorkspaces = sortedWorkspacesByProject.get(selectedWorkspace.projectPath);
      if (!sortedWorkspaces || sortedWorkspaces.length <= 1) return;

      // Find current workspace index in sorted list
      const currentIndex = sortedWorkspaces.findIndex(
        (metadata) => metadata.id === selectedWorkspace.workspaceId
      );
      if (currentIndex === -1) return;

      // Calculate next/prev index with wrapping
      let targetIndex: number;
      if (direction === "next") {
        targetIndex = (currentIndex + 1) % sortedWorkspaces.length;
      } else {
        targetIndex = currentIndex === 0 ? sortedWorkspaces.length - 1 : currentIndex - 1;
      }

      const targetMetadata = sortedWorkspaces[targetIndex];
      if (!targetMetadata) return;

      setSelectedWorkspace({
        projectPath: selectedWorkspace.projectPath,
        projectName: selectedWorkspace.projectName,
        namedWorkspacePath: targetMetadata.namedWorkspacePath,
        workspaceId: targetMetadata.id,
      });
    },
    [selectedWorkspace, sortedWorkspacesByProject, setSelectedWorkspace]
  );

  // Register command sources with registry
  const {
    registerSource,
    isOpen: isCommandPaletteOpen,
    open: openCommandPalette,
    close: closeCommandPalette,
  } = useCommandRegistry();

  const getThinkingLevelForWorkspace = useCallback((workspaceId: string): ThinkingLevel => {
    if (!workspaceId) {
      return "off";
    }

    if (typeof window === "undefined" || !window.localStorage) {
      return "off";
    }

    try {
      const key = getThinkingLevelKey(workspaceId);
      const stored = window.localStorage.getItem(key);
      if (!stored || stored === "undefined") {
        return "off";
      }
      const parsed = JSON.parse(stored) as ThinkingLevel;
      return THINKING_LEVELS.includes(parsed) ? parsed : "off";
    } catch (error) {
      console.warn("Failed to read thinking level", error);
      return "off";
    }
  }, []);

  const setThinkingLevelFromPalette = useCallback((workspaceId: string, level: ThinkingLevel) => {
    if (!workspaceId) {
      return;
    }

    const normalized = THINKING_LEVELS.includes(level) ? level : "off";
    const key = getThinkingLevelKey(workspaceId);

    // Use the utility function which handles localStorage and event dispatch
    // ThinkingProvider will pick this up via its listener
    updatePersistedState(key, normalized);

    // Dispatch toast notification event for UI feedback
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, {
          detail: { workspaceId, level: normalized },
        })
      );
    }
  }, []);

  const registerParamsRef = useRef<BuildSourcesParams | null>(null);

  const openNewWorkspaceFromPalette = useCallback(
    (projectPath: string) => {
      startWorkspaceCreation(projectPath);
    },
    [startWorkspaceCreation]
  );

  const getBranchesForProject = useCallback(
    async (projectPath: string): Promise<BranchListResult> => {
      if (!api) {
        return { branches: [], recommendedTrunk: null };
      }
      const branchResult = await api.projects.listBranches({ projectPath });
      const sanitizedBranches = branchResult.branches.filter(
        (branch): branch is string => typeof branch === "string"
      );

      const recommended =
        branchResult.recommendedTrunk && sanitizedBranches.includes(branchResult.recommendedTrunk)
          ? branchResult.recommendedTrunk
          : (sanitizedBranches[0] ?? null);

      return {
        branches: sanitizedBranches,
        recommendedTrunk: recommended,
      };
    },
    [api]
  );

  const selectWorkspaceFromPalette = useCallback(
    (selection: WorkspaceSelection) => {
      setSelectedWorkspace(selection);
    },
    [setSelectedWorkspace]
  );

  const removeWorkspaceFromPalette = useCallback(
    async (workspaceId: string) => removeWorkspace(workspaceId),
    [removeWorkspace]
  );

  const renameWorkspaceFromPalette = useCallback(
    async (workspaceId: string, newName: string) => renameWorkspace(workspaceId, newName),
    [renameWorkspace]
  );

  const addProjectFromPalette = useCallback(() => {
    openProjectCreateModal();
  }, [openProjectCreateModal]);

  const removeProjectFromPalette = useCallback(
    (path: string) => {
      void handleRemoveProject(path);
    },
    [handleRemoveProject]
  );

  const toggleSidebarFromPalette = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  const navigateWorkspaceFromPalette = useCallback(
    (dir: "next" | "prev") => {
      handleNavigateWorkspace(dir);
    },
    [handleNavigateWorkspace]
  );

  registerParamsRef.current = {
    projects,
    workspaceMetadata,
    selectedWorkspace,
    theme,
    getThinkingLevel: getThinkingLevelForWorkspace,
    onSetThinkingLevel: setThinkingLevelFromPalette,
    onStartWorkspaceCreation: openNewWorkspaceFromPalette,
    getBranchesForProject,
    onSelectWorkspace: selectWorkspaceFromPalette,
    onRemoveWorkspace: removeWorkspaceFromPalette,
    onRenameWorkspace: renameWorkspaceFromPalette,
    onAddProject: addProjectFromPalette,
    onRemoveProject: removeProjectFromPalette,
    onToggleSidebar: toggleSidebarFromPalette,
    onNavigateWorkspace: navigateWorkspaceFromPalette,
    onOpenWorkspaceInTerminal: openWorkspaceInTerminal,
    onToggleTheme: toggleTheme,
    onSetTheme: setThemePreference,
    onOpenSettings: openSettings,
    api,
  };

  useEffect(() => {
    const unregister = registerSource(() => {
      const params = registerParamsRef.current;
      if (!params) return [];

      // Compute streaming models here (only when command palette opens)
      const allStates = workspaceStore.getAllStates();
      const streamingModels = new Map<string, string>();
      for (const [workspaceId, state] of allStates) {
        if (state.canInterrupt && state.currentModel) {
          streamingModels.set(workspaceId, state.currentModel);
        }
      }

      const factories = buildCoreSources({ ...params, streamingModels });
      const actions: CommandAction[] = [];
      for (const factory of factories) {
        actions.push(...factory());
      }
      return actions;
    });
    return unregister;
  }, [registerSource, workspaceStore]);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.NEXT_WORKSPACE)) {
        e.preventDefault();
        handleNavigateWorkspace("next");
      } else if (matchesKeybind(e, KEYBINDS.PREV_WORKSPACE)) {
        e.preventDefault();
        handleNavigateWorkspace("prev");
      } else if (matchesKeybind(e, KEYBINDS.OPEN_COMMAND_PALETTE)) {
        e.preventDefault();
        if (isCommandPaletteOpen) {
          closeCommandPalette();
        } else {
          openCommandPalette();
        }
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_SIDEBAR)) {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if (matchesKeybind(e, KEYBINDS.OPEN_SETTINGS)) {
        e.preventDefault();
        openSettings();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleNavigateWorkspace,
    setSidebarCollapsed,
    isCommandPaletteOpen,
    closeCommandPalette,
    openCommandPalette,
    openSettings,
  ]);

  // Subscribe to menu bar "Open Settings" (macOS Cmd+, from app menu)
  useEffect(() => {
    if (!api) return;

    const abortController = new AbortController();
    const signal = abortController.signal;

    (async () => {
      try {
        const iterator = await api.menu.onOpenSettings(undefined, { signal });
        for await (const _ of iterator) {
          if (signal.aborted) break;
          openSettings();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup
      }
    })();

    return () => abortController.abort();
  }, [api, openSettings]);

  // Handle workspace fork switch event
  useEffect(() => {
    const handleForkSwitch = (e: Event) => {
      if (!isWorkspaceForkSwitchEvent(e)) return;

      const workspaceInfo = e.detail;

      // Find the project in config
      const project = projects.get(workspaceInfo.projectPath);
      if (!project) {
        console.error(`Project not found for path: ${workspaceInfo.projectPath}`);
        return;
      }

      // DEFENSIVE: Ensure createdAt exists
      if (!workspaceInfo.createdAt) {
        console.warn(
          `[Frontend] Workspace ${workspaceInfo.id} missing createdAt in fork switch - using default (2025-01-01)`
        );
        workspaceInfo.createdAt = "2025-01-01T00:00:00.000Z";
      }

      // Update metadata Map immediately (don't wait for async metadata event)
      // This ensures the title bar effect has the workspace name available
      setWorkspaceMetadata((prev) => {
        const updated = new Map(prev);
        updated.set(workspaceInfo.id, workspaceInfo);
        return updated;
      });

      // Switch to the new workspace
      setSelectedWorkspace({
        workspaceId: workspaceInfo.id,
        projectPath: workspaceInfo.projectPath,
        projectName: workspaceInfo.projectName,
        namedWorkspacePath: workspaceInfo.namedWorkspacePath,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH, handleForkSwitch as EventListener);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH,
        handleForkSwitch as EventListener
      );
  }, [projects, setSelectedWorkspace, setWorkspaceMetadata]);

  const handleProviderConfig = useCallback(
    async (provider: string, keyPath: string[], value: string) => {
      if (!api) {
        throw new Error("API not connected");
      }
      const result = await api.providers.setProviderConfig({ provider, keyPath, value });
      if (!result.success) {
        throw new Error(result.error);
      }
    },
    [api]
  );

  // Show auth modal if authentication is required
  if (status === "auth_required") {
    return <AuthTokenModal isOpen={true} onSubmit={authenticate} error={error} />;
  }

  return (
    <>
      <div className="bg-bg-dark mobile-layout flex h-screen overflow-hidden">
        <LeftSidebar
          lastReadTimestamps={lastReadTimestamps}
          onToggleUnread={onToggleUnread}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={handleToggleSidebar}
          sortedWorkspacesByProject={sortedWorkspacesByProject}
          workspaceRecency={workspaceRecency}
        />
        <div className="mobile-main-content flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="mobile-layout flex flex-1 overflow-hidden">
            {selectedWorkspace ? (
              (() => {
                const currentMetadata = workspaceMetadata.get(selectedWorkspace.workspaceId);
                // Guard: Don't render AIView if workspace metadata not found.
                // This can happen when selectedWorkspace (from localStorage) refers to a
                // deleted workspace, or during a race condition on reload before the
                // validation effect clears the stale selection.
                if (!currentMetadata) {
                  return null;
                }
                // Use metadata.name for workspace name (works for both worktree and local runtimes)
                // Fallback to path-based derivation for legacy compatibility
                const workspaceName =
                  currentMetadata.name ??
                  selectedWorkspace.namedWorkspacePath?.split("/").pop() ??
                  selectedWorkspace.workspaceId;
                // Use live metadata path (updates on rename) with fallback to initial path
                const workspacePath =
                  currentMetadata.namedWorkspacePath ?? selectedWorkspace.namedWorkspacePath ?? "";
                return (
                  <ErrorBoundary
                    workspaceInfo={`${selectedWorkspace.projectName}/${workspaceName}`}
                  >
                    <AIView
                      key={selectedWorkspace.workspaceId}
                      workspaceId={selectedWorkspace.workspaceId}
                      projectPath={selectedWorkspace.projectPath}
                      projectName={selectedWorkspace.projectName}
                      branch={workspaceName}
                      namedWorkspacePath={workspacePath}
                      runtimeConfig={currentMetadata.runtimeConfig}
                      incompatibleRuntime={currentMetadata.incompatibleRuntime}
                      status={currentMetadata.status}
                    />
                  </ErrorBoundary>
                );
              })()
            ) : creationProjectPath ? (
              (() => {
                const projectPath = creationProjectPath;
                const projectName =
                  projectPath.split("/").pop() ?? projectPath.split("\\").pop() ?? "Project";
                return (
                  <ModeProvider projectPath={projectPath}>
                    <ProviderOptionsProvider>
                      <ThinkingProvider projectPath={projectPath}>
                        <ChatInput
                          variant="creation"
                          projectPath={projectPath}
                          projectName={projectName}
                          onProviderConfig={handleProviderConfig}
                          onReady={handleCreationChatReady}
                          onWorkspaceCreated={(metadata) => {
                            // IMPORTANT: Add workspace to store FIRST (synchronous) to ensure
                            // the store knows about it before React processes the state updates.
                            // This prevents race conditions where the UI tries to access the
                            // workspace before the store has created its aggregator.
                            workspaceStore.addWorkspace(metadata);

                            // Add to workspace metadata map (triggers React state update)
                            setWorkspaceMetadata((prev) =>
                              new Map(prev).set(metadata.id, metadata)
                            );

                            // Only switch to new workspace if user hasn't selected another one
                            // during the creation process (selectedWorkspace was null when creation started)
                            setSelectedWorkspace((current) => {
                              if (current !== null) {
                                // User has already selected another workspace - don't override
                                return current;
                              }
                              return {
                                workspaceId: metadata.id,
                                projectPath: metadata.projectPath,
                                projectName: metadata.projectName,
                                namedWorkspacePath: metadata.namedWorkspacePath,
                              };
                            });

                            // Track telemetry
                            telemetry.workspaceCreated(
                              metadata.id,
                              getRuntimeTypeForTelemetry(metadata.runtimeConfig)
                            );

                            // Clear pending state
                            clearPendingWorkspaceCreation();
                          }}
                        />
                      </ThinkingProvider>
                    </ProviderOptionsProvider>
                  </ModeProvider>
                );
              })()
            ) : (
              <div
                className="[&_p]:text-muted [&_h2]:text-foreground mx-auto w-full max-w-3xl text-center [&_h2]:mb-4 [&_h2]:font-bold [&_h2]:tracking-tight [&_p]:leading-[1.6]"
                style={{
                  padding: "clamp(40px, 10vh, 100px) 20px",
                  fontSize: "clamp(14px, 2vw, 16px)",
                }}
              >
                <h2 style={{ fontSize: "clamp(24px, 5vw, 36px)", letterSpacing: "-1px" }}>
                  Welcome to Mux
                </h2>
                <p>Select a workspace from the sidebar or add a new one to get started.</p>
              </div>
            )}
          </div>
        </div>
        <CommandPalette
          getSlashContext={() => ({
            providerNames: [],
            workspaceId: selectedWorkspace?.workspaceId,
          })}
        />
        <ProjectCreateModal
          isOpen={isProjectCreateModalOpen}
          onClose={closeProjectCreateModal}
          onSuccess={(normalizedPath, projectConfig) => {
            addProject(normalizedPath, projectConfig);
            beginWorkspaceCreation(normalizedPath);
          }}
        />
        <SettingsModal />
      </div>
    </>
  );
}

function App() {
  return (
    <ThemeProvider>
      <ExperimentsProvider>
        <TooltipProvider delayDuration={200}>
          <SettingsProvider>
            <TutorialProvider>
              <CommandRegistryProvider>
                <AppInner />
              </CommandRegistryProvider>
            </TutorialProvider>
          </SettingsProvider>
        </TooltipProvider>
      </ExperimentsProvider>
    </ThemeProvider>
  );
}

export default App;
