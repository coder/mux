import { Menu } from "lucide-react";
import { useEffect, useCallback, useRef } from "react";
import { useRouter } from "./contexts/RouterContext";
import { useNavigate } from "react-router-dom";
import "./styles/globals.css";
import { useWorkspaceContext, toWorkspaceSelection } from "./contexts/WorkspaceContext";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { useProjectContext } from "./contexts/ProjectContext";
import type { WorkspaceSelection } from "./components/ProjectSidebar";
import { LeftSidebar } from "./components/LeftSidebar";
import { ProjectCreateModal } from "./components/ProjectCreateModal";
import { AIView } from "./components/AIView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  usePersistedState,
  updatePersistedState,
  readPersistedState,
} from "./hooks/usePersistedState";
import { useResizableSidebar } from "./hooks/useResizableSidebar";
import { matchesKeybind, KEYBINDS } from "./utils/ui/keybinds";
import { handleLayoutSlotHotkeys } from "./utils/ui/layoutSlotHotkeys";
import { buildSortedWorkspacesByProject } from "./utils/ui/workspaceFiltering";
import { getVisibleWorkspaceIds } from "./utils/ui/workspaceDomNav";
import { useUnreadTracking } from "./hooks/useUnreadTracking";
import { useWorkspaceStoreRaw, useWorkspaceRecency } from "./stores/WorkspaceStore";

import { useStableReference, compareMaps } from "./hooks/useStableReference";
import { CommandRegistryProvider, useCommandRegistry } from "./contexts/CommandRegistryContext";
import { useOpenTerminal } from "./hooks/useOpenTerminal";
import type { CommandAction } from "./contexts/CommandRegistryContext";
import { useTheme, type ThemeMode } from "./contexts/ThemeContext";
import { CommandPalette } from "./components/CommandPalette";
import { buildCoreSources, type BuildSourcesParams } from "./utils/commands/sources";

import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { isWorkspaceForkSwitchEvent } from "./utils/workspaceEvents";
import {
  getAgentIdKey,
  getAgentsInitNudgeKey,
  getModelKey,
  getNotifyOnResponseKey,
  getThinkingLevelByModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  getWorkspaceLastReadKey,
  EXPANDED_PROJECTS_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  LEFT_SIDEBAR_WIDTH_KEY,
} from "@/common/constants/storage";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import type { BranchListResult } from "@/common/orpc/types";
import { useTelemetry } from "./hooks/useTelemetry";
import { getRuntimeTypeForTelemetry } from "@/common/telemetry";
import { useStartWorkspaceCreation, getFirstProjectPath } from "./hooks/useStartWorkspaceCreation";
import { useAPI } from "@/browser/contexts/API";
import {
  clearPendingWorkspaceAiSettings,
  markPendingWorkspaceAiSettings,
} from "@/browser/utils/workspaceAiSettingsSync";
import { AuthTokenModal } from "@/browser/components/AuthTokenModal";
import { Button } from "./components/ui/button";
import { ProjectPage } from "@/browser/components/ProjectPage";

import { SettingsProvider, useSettings } from "./contexts/SettingsContext";
import { AboutDialogProvider } from "./contexts/AboutDialogContext";
import { ConfirmDialogProvider, useConfirmDialog } from "./contexts/ConfirmDialogContext";
import { AboutDialog } from "./components/About/AboutDialog";
import { SettingsPage } from "@/browser/components/Settings/SettingsPage";
import { AnalyticsDashboard } from "@/browser/components/analytics/AnalyticsDashboard";
import { MuxGatewaySessionExpiredDialog } from "./components/MuxGatewaySessionExpiredDialog";
import { SshPromptDialog } from "./components/SshPromptDialog";
import { SplashScreenProvider } from "./components/splashScreens/SplashScreenProvider";
import { TutorialProvider } from "./contexts/TutorialContext";
import { PowerModeProvider } from "./contexts/PowerModeContext";
import { TooltipProvider } from "./components/ui/tooltip";
import { useFeatureFlags } from "./contexts/FeatureFlagsContext";
import { UILayoutsProvider, useUILayouts } from "@/browser/contexts/UILayoutsContext";
import { FeatureFlagsProvider } from "./contexts/FeatureFlagsContext";
import { ExperimentsProvider } from "./contexts/ExperimentsContext";
import { ProviderOptionsProvider } from "./contexts/ProviderOptionsContext";
import { getWorkspaceSidebarKey } from "./utils/workspace";
import { WindowsToolchainBanner } from "./components/WindowsToolchainBanner";
import { RosettaBanner } from "./components/RosettaBanner";
import { isDesktopMode } from "./hooks/useDesktopTitlebar";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

function AppInner() {
  // Get workspace state from context
  const {
    workspaceMetadata,
    loading,
    setWorkspaceMetadata,
    removeWorkspace,
    updateWorkspaceTitle,
    refreshWorkspaceMetadata,
    selectedWorkspace,
    setSelectedWorkspace,
    pendingNewWorkspaceProject,
    pendingNewWorkspaceSectionId,
    pendingNewWorkspaceDraftId,
    beginWorkspaceCreation,
  } = useWorkspaceContext();
  const {
    currentWorkspaceId,
    currentSettingsSection,
    isAnalyticsOpen,
    navigateToAnalytics,
    navigateFromAnalytics,
  } = useRouter();
  const { theme, setTheme, toggleTheme } = useTheme();
  const { open: openSettings, isOpen: isSettingsOpen } = useSettings();
  const { confirm: confirmDialog } = useConfirmDialog();
  const setThemePreference = useCallback(
    (nextTheme: ThemeMode) => {
      setTheme(nextTheme);
    },
    [setTheme]
  );
  const { layoutPresets, applySlotToWorkspace, saveCurrentWorkspaceToSlot } = useUILayouts();
  const { api, status, error, authenticate, retry } = useAPI();

  const {
    projects,
    refreshProjects,
    removeProject,
    openProjectCreateModal,
    isProjectCreateModalOpen,
    closeProjectCreateModal,
    addProject,
  } = useProjectContext();

  // Auto-collapse sidebar on mobile by default
  const isMobile = typeof window !== "undefined" && window.innerWidth <= 768;
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedState(
    LEFT_SIDEBAR_COLLAPSED_KEY,
    isMobile,
    {
      listener: true,
    }
  );

  // Left sidebar is drag-resizable (mirrors RightSidebar). Width is persisted globally;
  // collapse remains a separate toggle and the drag handle is hidden in mobile-touch overlay mode.
  const leftSidebar = useResizableSidebar({
    enabled: true,
    defaultWidth: 288,
    minWidth: 200,
    maxWidth: 600,
    // Keep enough room for the main content so you can't drag-resize the left sidebar
    // to a point where the chat pane becomes unusably narrow.
    getMaxWidthPx: () => {
      // Match LeftSidebar's mobile overlay gate. In that mode we don't want viewport-based clamping
      // because the sidebar width is controlled by CSS and shouldn't rewrite the user's desktop
      // width preference.
      const isMobileTouch =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;
      if (isMobileTouch) {
        return Number.POSITIVE_INFINITY;
      }

      const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
      // ChatPane uses tailwind `min-w-96`.
      return viewportWidth - 384;
    },
    storageKey: LEFT_SIDEBAR_WIDTH_KEY,
    side: "left",
  });
  // Sync sidebar collapse state to root element for CSS-based titlebar insets
  useEffect(() => {
    document.documentElement.dataset.leftSidebarCollapsed = String(sidebarCollapsed);
  }, [sidebarCollapsed]);
  const defaultProjectPath = getFirstProjectPath(projects);
  const creationProjectPath =
    !selectedWorkspace && !currentWorkspaceId
      ? (pendingNewWorkspaceProject ?? defaultProjectPath)
      : null;

  // History navigation (back/forward)
  const navigate = useNavigate();

  const startWorkspaceCreation = useStartWorkspaceCreation({
    projects,
    beginWorkspaceCreation,
  });

  // ProjectPage handles its own focus when mounted

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, [setSidebarCollapsed]);

  // Telemetry tracking
  const telemetry = useTelemetry();

  // Get workspace store for command palette
  const workspaceStore = useWorkspaceStoreRaw();

  const { statsTabState } = useFeatureFlags();
  useEffect(() => {
    workspaceStore.setStatsEnabled(Boolean(statsTabState?.enabled));
  }, [workspaceStore, statsTabState?.enabled]);

  // Track telemetry when workspace selection changes
  const prevWorkspaceRef = useRef<WorkspaceSelection | null>(null);
  // Ref for selectedWorkspace to access in callbacks without stale closures
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;
  // Ref for route-level workspace visibility to avoid stale closure in response callbacks
  const currentWorkspaceIdRef = useRef(currentWorkspaceId);
  currentWorkspaceIdRef.current = currentWorkspaceId;
  useEffect(() => {
    const prev = prevWorkspaceRef.current;
    if (prev && selectedWorkspace && prev.workspaceId !== selectedWorkspace.workspaceId) {
      telemetry.workspaceSwitched(prev.workspaceId, selectedWorkspace.workspaceId);
    }
    prevWorkspaceRef.current = selectedWorkspace;
  }, [selectedWorkspace, telemetry]);

  // Track last-read timestamps for unread indicators.
  // Read-marking is gated on chat-route visibility (currentWorkspaceId).
  useUnreadTracking(selectedWorkspace, currentWorkspaceId);

  const workspaceMetadataRef = useRef(workspaceMetadata);
  useEffect(() => {
    workspaceMetadataRef.current = workspaceMetadata;
  }, [workspaceMetadata]);

  const handleOpenMuxChat = useCallback(() => {
    // User requested an F1 shortcut to jump straight into Chat with Mux.
    const metadata = workspaceMetadataRef.current.get(MUX_HELP_CHAT_WORKSPACE_ID);
    setSelectedWorkspace(
      metadata
        ? toWorkspaceSelection(metadata)
        : {
            workspaceId: MUX_HELP_CHAT_WORKSPACE_ID,
            projectPath: "",
            projectName: "Mux",
            namedWorkspacePath: "",
          }
    );

    if (!metadata) {
      refreshWorkspaceMetadata().catch((error) => {
        console.error("Failed to refresh workspace metadata", error);
      });
    }
  }, [refreshWorkspaceMetadata, setSelectedWorkspace]);

  // Update window title based on selected workspace
  // URL syncing is now handled by RouterContext
  useEffect(() => {
    if (selectedWorkspace) {
      // Update window title with workspace title (or name for legacy workspaces)
      const metadata = workspaceMetadata.get(selectedWorkspace.workspaceId);
      const workspaceTitle = metadata?.title ?? metadata?.name ?? selectedWorkspace.workspaceId;
      const title = `${workspaceTitle} - ${selectedWorkspace.projectName} - mux`;
      // Set document.title locally for browser mode, call backend for Electron
      document.title = title;
      void api?.window.setTitle({ title });
    } else {
      // Set document.title locally for browser mode, call backend for Electron
      document.title = "mux";
      void api?.window.setTitle({ title: "mux" });
    }
  }, [selectedWorkspace, workspaceMetadata, api]);

  // Validate selected workspace exists and has all required fields
  // Note: workspace validity is now primarily handled by RouterContext deriving
  // selectedWorkspace from URL + metadata. This effect handles edge cases like
  // stale localStorage or missing fields in legacy workspaces.
  useEffect(() => {
    if (selectedWorkspace) {
      const metadata = workspaceMetadata.get(selectedWorkspace.workspaceId);

      if (!metadata) {
        // Workspace was deleted - navigate home (clears selection)
        console.warn(
          `Workspace ${selectedWorkspace.workspaceId} no longer exists, clearing selection`
        );
        setSelectedWorkspace(null);
      } else if (!selectedWorkspace.namedWorkspacePath && metadata.namedWorkspacePath) {
        // Old localStorage entry missing namedWorkspacePath - update it once
        console.log(`Updating workspace ${selectedWorkspace.workspaceId} with missing fields`);
        setSelectedWorkspace(toWorkspaceSelection(metadata));
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

  // Pre-compute for the sidebar so it doesn't need WorkspaceMetadataContext
  const muxChatProjectPath = workspaceMetadata.get(MUX_HELP_CHAT_WORKSPACE_ID)?.projectPath ?? null;

  const handleNavigateWorkspace = useCallback(
    (direction: "next" | "prev") => {
      // Read actual rendered workspace order from DOM — impossible to drift from sidebar.
      const visibleIds = getVisibleWorkspaceIds();
      if (visibleIds.length === 0) return;

      const currentIndex = selectedWorkspace
        ? visibleIds.indexOf(selectedWorkspace.workspaceId)
        : -1;

      let targetIndex: number;
      if (currentIndex === -1) {
        targetIndex = direction === "next" ? 0 : visibleIds.length - 1;
      } else if (direction === "next") {
        targetIndex = (currentIndex + 1) % visibleIds.length;
      } else {
        targetIndex = currentIndex === 0 ? visibleIds.length - 1 : currentIndex - 1;
      }

      const targetMeta = workspaceMetadata.get(visibleIds[targetIndex]);
      if (targetMeta) setSelectedWorkspace(toWorkspaceSelection(targetMeta));
    },
    [selectedWorkspace, workspaceMetadata, setSelectedWorkspace]
  );

  // Register command sources with registry
  const {
    registerSource,
    isOpen: isCommandPaletteOpen,
    open: openCommandPalette,
    close: closeCommandPalette,
  } = useCommandRegistry();

  /**
   * Get model for a workspace, returning canonical format.
   */
  const getModelForWorkspace = useCallback((workspaceId: string): string => {
    const defaultModel = getDefaultModel();
    const rawModel = readPersistedState<string>(getModelKey(workspaceId), defaultModel);
    return migrateGatewayModel(rawModel || defaultModel);
  }, []);

  const getThinkingLevelForWorkspace = useCallback(
    (workspaceId: string): ThinkingLevel => {
      if (!workspaceId) {
        return "off";
      }

      const scopedKey = getThinkingLevelKey(workspaceId);
      const scoped = readPersistedState<ThinkingLevel | undefined>(scopedKey, undefined);
      if (scoped !== undefined) {
        return THINKING_LEVELS.includes(scoped) ? scoped : "off";
      }

      // Migration: fall back to legacy per-model thinking and seed the workspace-scoped key.
      const model = getModelForWorkspace(workspaceId);
      const legacy = readPersistedState<ThinkingLevel | undefined>(
        getThinkingLevelByModelKey(model),
        undefined
      );
      if (legacy !== undefined && THINKING_LEVELS.includes(legacy)) {
        updatePersistedState(scopedKey, legacy);
        return legacy;
      }

      return "off";
    },
    [getModelForWorkspace]
  );

  const setThinkingLevelFromPalette = useCallback(
    (workspaceId: string, level: ThinkingLevel) => {
      if (!workspaceId) {
        return;
      }

      const normalized = THINKING_LEVELS.includes(level) ? level : "off";
      const model = getModelForWorkspace(workspaceId);
      const key = getThinkingLevelKey(workspaceId);

      // Use the utility function which handles localStorage and event dispatch
      // ThinkingProvider will pick this up via its listener
      updatePersistedState(key, normalized);

      type WorkspaceAISettingsByAgentCache = Partial<
        Record<string, { model: string; thinkingLevel: ThinkingLevel }>
      >;

      const normalizedAgentId =
        readPersistedState<string>(getAgentIdKey(workspaceId), WORKSPACE_DEFAULTS.agentId)
          .trim()
          .toLowerCase() || WORKSPACE_DEFAULTS.agentId;

      updatePersistedState<WorkspaceAISettingsByAgentCache>(
        getWorkspaceAISettingsByAgentKey(workspaceId),
        (prev) => {
          const record: WorkspaceAISettingsByAgentCache =
            prev && typeof prev === "object" ? prev : {};
          return {
            ...record,
            [normalizedAgentId]: { model, thinkingLevel: normalized },
          };
        },
        {}
      );

      // Persist to backend so the palette change follows the workspace across devices.
      if (api) {
        markPendingWorkspaceAiSettings(workspaceId, normalizedAgentId, {
          model,
          thinkingLevel: normalized,
        });

        api.workspace
          .updateAgentAISettings({
            workspaceId,
            agentId: normalizedAgentId,
            aiSettings: { model, thinkingLevel: normalized },
          })
          .then((result) => {
            if (!result.success) {
              clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
            }
          })
          .catch(() => {
            clearPendingWorkspaceAiSettings(workspaceId, normalizedAgentId);
            // Best-effort only.
          });
      }

      // Dispatch toast notification event for UI feedback
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(CUSTOM_EVENTS.THINKING_LEVEL_TOAST, {
            detail: { workspaceId, level: normalized },
          })
        );
      }
    },
    [api, getModelForWorkspace]
  );

  const registerParamsRef = useRef<BuildSourcesParams | null>(null);

  const openNewWorkspaceFromPalette = useCallback(
    (projectPath: string) => {
      startWorkspaceCreation(projectPath);
    },
    [startWorkspaceCreation]
  );

  const archiveMergedWorkspacesInProjectFromPalette = useCallback(
    async (projectPath: string): Promise<void> => {
      const trimmedProjectPath = projectPath.trim();
      if (!trimmedProjectPath) return;

      if (!api) {
        if (typeof window !== "undefined") {
          window.alert("Cannot archive merged workspaces: API not connected");
        }
        return;
      }

      try {
        const result = await api.workspace.archiveMergedInProject({
          projectPath: trimmedProjectPath,
        });

        if (!result.success) {
          if (typeof window !== "undefined") {
            window.alert(result.error);
          }
          return;
        }

        const errorCount = result.data.errors.length;
        if (errorCount > 0) {
          const archivedCount = result.data.archivedWorkspaceIds.length;
          const skippedCount = result.data.skippedWorkspaceIds.length;

          const MAX_ERRORS_TO_SHOW = 5;
          const shownErrors = result.data.errors
            .slice(0, MAX_ERRORS_TO_SHOW)
            .map((e) => `- ${e.workspaceId}: ${e.error}`)
            .join("\n");
          const remainingCount = Math.max(0, errorCount - MAX_ERRORS_TO_SHOW);
          const remainingSuffix = remainingCount > 0 ? `\n… and ${remainingCount} more.` : "";

          if (typeof window !== "undefined") {
            window.alert(
              `Archived merged workspaces with some errors.\n\nArchived: ${archivedCount}\nSkipped: ${skippedCount}\nErrors: ${errorCount}\n\nErrors:\n${shownErrors}${remainingSuffix}`
            );
          }
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (typeof window !== "undefined") {
          window.alert(message);
        }
      }
    },
    [api]
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

  const updateTitleFromPalette = useCallback(
    async (workspaceId: string, newTitle: string) => updateWorkspaceTitle(workspaceId, newTitle),
    [updateWorkspaceTitle]
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
    onArchiveMergedWorkspacesInProject: archiveMergedWorkspacesInProjectFromPalette,
    getBranchesForProject,
    onSelectWorkspace: selectWorkspaceFromPalette,
    onRemoveWorkspace: removeWorkspaceFromPalette,
    onUpdateTitle: updateTitleFromPalette,
    onAddProject: addProjectFromPalette,
    onRemoveProject: removeProjectFromPalette,
    onToggleSidebar: toggleSidebarFromPalette,
    onNavigateWorkspace: navigateWorkspaceFromPalette,
    onOpenWorkspaceInTerminal: (workspaceId, runtimeConfig) => {
      // Best-effort only. Palette actions should never throw.
      void openWorkspaceInTerminal(workspaceId, runtimeConfig).catch(() => {
        // Errors are surfaced elsewhere (toasts/logs) and users can retry.
      });
    },
    onToggleTheme: toggleTheme,
    onSetTheme: setThemePreference,
    onOpenSettings: openSettings,
    layoutPresets,
    onApplyLayoutSlot: (workspaceId, slot) => {
      void applySlotToWorkspace(workspaceId, slot).catch(() => {
        // Best-effort only.
      });
    },
    onCaptureLayoutSlot: async (workspaceId, slot, name) => {
      try {
        await saveCurrentWorkspaceToSlot(workspaceId, slot, name);
      } catch {
        // Best-effort only.
      }
    },
    onClearTimingStats: (workspaceId: string) => workspaceStore.clearTimingStats(workspaceId),
    api,
    confirmDialog,
  };

  useEffect(() => {
    const unregister = registerSource(() => {
      const params = registerParamsRef.current;
      if (!params) return [];

      // Compute streaming models here (only when command palette opens)
      const allStates = workspaceStore.getAllStates();
      const selectedWorkspaceState = params.selectedWorkspace
        ? (allStates.get(params.selectedWorkspace.workspaceId) ?? null)
        : null;
      const streamingModels = new Map<string, string>();
      for (const [workspaceId, state] of allStates) {
        if (state.canInterrupt && state.currentModel) {
          streamingModels.set(workspaceId, state.currentModel);
        }
      }

      const factories = buildCoreSources({
        ...params,
        streamingModels,
        selectedWorkspaceState,
      });
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
      if (e.defaultPrevented) {
        return;
      }

      if (matchesKeybind(e, KEYBINDS.NEXT_WORKSPACE)) {
        e.preventDefault();
        handleNavigateWorkspace("next");
      } else if (matchesKeybind(e, KEYBINDS.PREV_WORKSPACE)) {
        e.preventDefault();
        handleNavigateWorkspace("prev");
      } else if (
        matchesKeybind(e, KEYBINDS.OPEN_COMMAND_PALETTE) ||
        matchesKeybind(e, KEYBINDS.OPEN_COMMAND_PALETTE_ACTIONS)
      ) {
        e.preventDefault();
        if (isCommandPaletteOpen) {
          closeCommandPalette();
        } else {
          // Alternate palette shortcut opens in command mode (with ">") while the
          // primary Ctrl/Cmd+Shift+P shortcut opens default workspace-switch mode.
          const initialQuery = matchesKeybind(e, KEYBINDS.OPEN_COMMAND_PALETTE_ACTIONS)
            ? ">"
            : undefined;
          openCommandPalette(initialQuery);
        }
      } else if (matchesKeybind(e, KEYBINDS.OPEN_MUX_CHAT)) {
        e.preventDefault();
        handleOpenMuxChat();
      } else if (matchesKeybind(e, KEYBINDS.TOGGLE_SIDEBAR)) {
        e.preventDefault();
        setSidebarCollapsed((prev) => !prev);
      } else if (matchesKeybind(e, KEYBINDS.OPEN_SETTINGS)) {
        e.preventDefault();
        openSettings();
      } else if (matchesKeybind(e, KEYBINDS.OPEN_ANALYTICS)) {
        e.preventDefault();
        if (isAnalyticsOpen) {
          navigateFromAnalytics();
        } else {
          navigateToAnalytics();
        }
      } else if (matchesKeybind(e, KEYBINDS.NAVIGATE_BACK)) {
        e.preventDefault();
        void navigate(-1);
      } else if (matchesKeybind(e, KEYBINDS.NAVIGATE_FORWARD)) {
        e.preventDefault();
        void navigate(1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    handleNavigateWorkspace,
    handleOpenMuxChat,
    setSidebarCollapsed,
    isCommandPaletteOpen,
    closeCommandPalette,
    openCommandPalette,
    openSettings,
    isAnalyticsOpen,
    navigateToAnalytics,
    navigateFromAnalytics,
    navigate,
  ]);
  // Mouse back/forward buttons (buttons 3 and 4)
  const handleMouseNavigation = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        void navigate(-1);
      } else if (e.button === 4) {
        e.preventDefault();
        void navigate(1);
      }
    },
    [navigate]
  );

  // Layout slot hotkeys (Ctrl/Cmd+Alt+1..9 by default)
  useEffect(() => {
    const handleKeyDownCapture = (e: KeyboardEvent) => {
      handleLayoutSlotHotkeys(e, {
        isCommandPaletteOpen,
        isSettingsOpen,
        selectedWorkspaceId: selectedWorkspace?.workspaceId ?? null,
        layoutPresets,
        applySlotToWorkspace,
      });
    };

    window.addEventListener("keydown", handleKeyDownCapture, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDownCapture, { capture: true });
  }, [
    isCommandPaletteOpen,
    isSettingsOpen,
    selectedWorkspace,
    layoutPresets,
    applySlotToWorkspace,
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

      // Ensure the workspace's project is present in the sidebar config.
      //
      // IMPORTANT: don't early-return here. In practice this event can fire before
      // ProjectContext has finished loading (or before a refresh runs), and returning
      // would make the forked workspace appear "missing" until a later refresh.
      const project = projects.get(workspaceInfo.projectPath);
      if (!project) {
        console.warn(
          `[Frontend] Project not found for forked workspace path: ${workspaceInfo.projectPath} (will refresh)`
        );
        void refreshProjects();
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
      setSelectedWorkspace(toWorkspaceSelection(workspaceInfo));
    };

    window.addEventListener(CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH, handleForkSwitch as EventListener);
    return () =>
      window.removeEventListener(
        CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH,
        handleForkSwitch as EventListener
      );
  }, [projects, refreshProjects, setSelectedWorkspace, setWorkspaceMetadata]);

  // Set up navigation callback for notification clicks
  useEffect(() => {
    const navigateToWorkspace = (workspaceId: string) => {
      const metadata = workspaceMetadataRef.current.get(workspaceId);
      if (metadata) {
        setSelectedWorkspace(toWorkspaceSelection(metadata));
      }
    };

    // Single source of truth: WorkspaceStore owns the navigation callback.
    // Browser notifications and Electron notification clicks both route through this.
    workspaceStore.setNavigateToWorkspace(navigateToWorkspace);

    // Callback for "notify on response" feature - fires when any assistant response completes.
    // Only notify when isFinal=true (assistant done with all work, no more active streams).
    // finalText is extracted by the aggregator (text after tool calls).
    // compaction is provided when this was a compaction stream (includes continue metadata).
    const handleResponseComplete = (
      workspaceId: string,
      _messageId: string,
      isFinal: boolean,
      finalText: string,
      compaction?: { hasContinueMessage: boolean },
      completedAt?: number | null
    ) => {
      // Only notify on final message (when assistant is done with all work)
      if (!isFinal) return;

      // Only mark read when the user is actively viewing this workspace's chat.
      // Checking currentWorkspaceIdRef ensures we don't advance lastRead when
      // a non-chat route (e.g. /settings) is active — the workspace remains
      // "selected" but the chat content is not visible.
      const isChatVisible = document.hasFocus() && currentWorkspaceIdRef.current === workspaceId;
      if (completedAt != null && isChatVisible) {
        updatePersistedState(getWorkspaceLastReadKey(workspaceId), completedAt);
      }

      // Skip notification if compaction completed with a continue message.
      // We use the compaction metadata instead of queued state since the queue
      // can be drained before compaction finishes.
      if (compaction?.hasContinueMessage) return;

      // Skip notification if the selected workspace is focused (Slack-like behavior).
      // Notification suppression intentionally follows selection state, not chat-route visibility.
      const isWorkspaceFocused =
        document.hasFocus() && selectedWorkspaceRef.current?.workspaceId === workspaceId;
      if (isWorkspaceFocused) return;

      // Check if notifications are enabled for this workspace
      const notifyEnabled = readPersistedState(getNotifyOnResponseKey(workspaceId), false);
      if (!notifyEnabled) return;

      const metadata = workspaceMetadataRef.current.get(workspaceId);
      const title = metadata?.title ?? metadata?.name ?? "Response complete";

      // For compaction completions, use a specific message instead of the summary text
      const body = compaction
        ? "Compaction complete"
        : finalText
          ? finalText.length > 200
            ? `${finalText.slice(0, 197)}…`
            : finalText
          : "Response complete";

      // Send browser notification
      if ("Notification" in window) {
        const showNotification = () => {
          const notification = new Notification(title, { body });
          notification.onclick = () => {
            window.focus();
            navigateToWorkspace(workspaceId);
          };
        };

        if (Notification.permission === "granted") {
          showNotification();
        } else if (Notification.permission !== "denied") {
          void Notification.requestPermission().then((perm) => {
            if (perm === "granted") {
              showNotification();
            }
          });
        }
      }
    };

    workspaceStore.setOnResponseComplete(handleResponseComplete);

    const unsubscribe = window.api?.onNotificationClicked?.((data) => {
      workspaceStore.navigateToWorkspace(data.workspaceId);
    });

    return () => {
      unsubscribe?.();
    };
  }, [setSelectedWorkspace, workspaceStore]);

  // Show auth modal if authentication is required
  if (status === "auth_required") {
    return (
      <AuthTokenModal
        isOpen={true}
        onSubmit={authenticate}
        onSessionAuthenticated={retry}
        error={error}
      />
    );
  }

  return (
    <>
      <div
        className="bg-bg-dark mobile-layout flex h-full overflow-hidden pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[min(env(safe-area-inset-bottom,0px),40px)] pl-[env(safe-area-inset-left)]"
        onMouseUp={handleMouseNavigation}
      >
        <LeftSidebar
          collapsed={sidebarCollapsed}
          onToggleCollapsed={handleToggleSidebar}
          widthPx={leftSidebar.width}
          isResizing={leftSidebar.isResizing}
          onStartResize={leftSidebar.startResize}
          sortedWorkspacesByProject={sortedWorkspacesByProject}
          workspaceRecency={workspaceRecency}
          muxChatProjectPath={muxChatProjectPath}
        />
        <div className="mobile-main-content flex min-w-0 flex-1 flex-col overflow-hidden">
          <WindowsToolchainBanner />
          <RosettaBanner />
          <div className="mobile-layout flex flex-1 overflow-hidden">
            {/* Route-driven settings and analytics render in the main pane so project/workspace navigation stays visible. */}
            {isAnalyticsOpen ? (
              <AnalyticsDashboard
                leftSidebarCollapsed={sidebarCollapsed}
                onToggleLeftSidebarCollapsed={handleToggleSidebar}
              />
            ) : currentSettingsSection ? (
              <SettingsPage
                leftSidebarCollapsed={sidebarCollapsed}
                onToggleLeftSidebarCollapsed={handleToggleSidebar}
              />
            ) : selectedWorkspace ? (
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
                      workspaceId={selectedWorkspace.workspaceId}
                      projectPath={selectedWorkspace.projectPath}
                      projectName={selectedWorkspace.projectName}
                      leftSidebarCollapsed={sidebarCollapsed}
                      onToggleLeftSidebarCollapsed={handleToggleSidebar}
                      workspaceName={workspaceName}
                      namedWorkspacePath={workspacePath}
                      runtimeConfig={currentMetadata.runtimeConfig}
                      incompatibleRuntime={currentMetadata.incompatibleRuntime}
                      isInitializing={currentMetadata.isInitializing === true}
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
                  <ProjectPage
                    projectPath={projectPath}
                    projectName={projectName}
                    leftSidebarCollapsed={sidebarCollapsed}
                    onToggleLeftSidebarCollapsed={handleToggleSidebar}
                    pendingSectionId={pendingNewWorkspaceSectionId}
                    pendingDraftId={pendingNewWorkspaceDraftId}
                    onWorkspaceCreated={(metadata, options) => {
                      // IMPORTANT: Add workspace to store FIRST (synchronous) to ensure
                      // the store knows about it before React processes the state updates.
                      // This prevents race conditions where the UI tries to access the
                      // workspace before the store has created its aggregator.
                      workspaceStore.addWorkspace(metadata);

                      // Add to workspace metadata map (triggers React state update)
                      setWorkspaceMetadata((prev) => new Map(prev).set(metadata.id, metadata));

                      if (options?.autoNavigate !== false) {
                        // Only switch to new workspace if user hasn't selected another one
                        // during the creation process (selectedWorkspace was null when creation started)
                        setSelectedWorkspace((current) => {
                          if (current !== null) {
                            // User has already selected another workspace - don't override
                            return current;
                          }
                          return toWorkspaceSelection(metadata);
                        });
                      }

                      // Track telemetry
                      telemetry.workspaceCreated(
                        metadata.id,
                        getRuntimeTypeForTelemetry(metadata.runtimeConfig)
                      );

                      // Note: No need to call clearPendingWorkspaceCreation() here.
                      // Navigating to the workspace URL automatically clears the pending
                      // state since pendingNewWorkspaceProject is derived from the URL.
                    }}
                  />
                );
              })()
            ) : (
              <div className="bg-dark flex flex-1 flex-col overflow-hidden">
                <div
                  className={cn(
                    "bg-sidebar border-border-light flex shrink-0 items-center border-b px-[15px] [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2",
                    isDesktopMode() ? "h-10 titlebar-drag" : "h-8"
                  )}
                >
                  {sidebarCollapsed && (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={handleToggleSidebar}
                      title="Open sidebar"
                      aria-label="Open sidebar menu"
                      className={cn(
                        "mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 shrink-0",
                        isDesktopMode() && "titlebar-no-drag"
                      )}
                    >
                      <Menu className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <div
                  className="[&_p]:text-muted [&_h2]:text-foreground mx-auto w-full max-w-3xl flex-1 text-center [&_h2]:mb-4 [&_h2]:font-bold [&_h2]:tracking-tight [&_p]:leading-[1.6]"
                  style={{
                    padding: "clamp(40px, 10vh, 100px) 20px",
                    fontSize: "clamp(14px, 2vw, 16px)",
                  }}
                >
                  <h2 style={{ fontSize: "clamp(24px, 5vw, 36px)", letterSpacing: "-1px" }}>
                    {currentWorkspaceId ? "Opening workspace…" : "Welcome to Mux"}
                  </h2>
                  <p>
                    {currentWorkspaceId
                      ? loading
                        ? "Loading workspace metadata…"
                        : "Workspace not found."
                      : "Add a project from the sidebar to get started."}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        <CommandPalette getSlashContext={() => ({ workspaceId: selectedWorkspace?.workspaceId })} />
        <ProjectCreateModal
          isOpen={isProjectCreateModalOpen}
          onClose={closeProjectCreateModal}
          onSuccess={(normalizedPath, projectConfig) => {
            addProject(normalizedPath, projectConfig);
            updatePersistedState(getAgentsInitNudgeKey(normalizedPath), true);
            // Auto-expand new project in sidebar
            updatePersistedState<string[]>(
              EXPANDED_PROJECTS_KEY,
              (prev) => [...(Array.isArray(prev) ? prev : []), normalizedPath],
              []
            );
            beginWorkspaceCreation(normalizedPath);
          }}
        />
        <AboutDialog />
        <MuxGatewaySessionExpiredDialog />
        <SshPromptDialog />
      </div>
    </>
  );
}

function App() {
  return (
    <ExperimentsProvider>
      <FeatureFlagsProvider>
        <UILayoutsProvider>
          <TooltipProvider delayDuration={200}>
            <SettingsProvider>
              <AboutDialogProvider>
                <ProviderOptionsProvider>
                  <SplashScreenProvider>
                    <TutorialProvider>
                      <CommandRegistryProvider>
                        <PowerModeProvider>
                          <ConfirmDialogProvider>
                            <AppInner />
                          </ConfirmDialogProvider>
                        </PowerModeProvider>
                      </CommandRegistryProvider>
                    </TutorialProvider>
                  </SplashScreenProvider>
                </ProviderOptionsProvider>
              </AboutDialogProvider>
            </SettingsProvider>
          </TooltipProvider>
        </UILayoutsProvider>
      </FeatureFlagsProvider>
    </ExperimentsProvider>
  );
}

export default App;
