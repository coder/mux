import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { cn } from "@/common/lib/utils";
import {
  RIGHT_SIDEBAR_TAB_KEY,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
  getWorkspaceDockLayoutKey,
} from "@/common/constants/storage";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { ReviewNoteData } from "@/common/types/review";
import { useAPI } from "@/browser/contexts/API";
import { useBackgroundBashError } from "@/browser/contexts/BackgroundBashContext";
import { useFeatureFlags } from "@/browser/contexts/FeatureFlagsContext";
import {
  useWorkspaceState,
  useWorkspaceUsage,
  useWorkspaceStatsSnapshot,
} from "@/browser/stores/WorkspaceStore";
import { useReviews } from "@/browser/hooks/useReviews";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import {
  collectAllTabsWithTabset,
  findTabset,
  isDockLayoutState,
  parseDockLayoutState,
  removeTabEverywhere,
  selectTabInTabset,
  setFocusedTabset,
  type DockLayoutState,
} from "@/browser/utils/dockLayout";
import { createTerminalSession, openTerminalPopout } from "@/browser/utils/terminal";
import {
  DEFAULT_CHAT_PANE_ID,
  ensureWorkspaceDockLayoutState,
  getDefaultWorkspaceDockLayoutState,
  isWorkspacePaneId,
  migrateRightSidebarLayoutToWorkspaceDockLayout,
  type WorkspacePaneId,
} from "@/browser/utils/workspaceDockLayout";
import {
  getFilePath,
  getTerminalSessionId,
  isFileTab,
  isTerminalTab,
  isTabType,
  makeFileTabType,
  makeTerminalTabType,
  type TabType,
} from "@/browser/types/rightSidebar";
import { DockLayout, type DockPaneDescriptor } from "./DockLayout";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { ChatPane } from "./ChatPane";
import { PopoverError } from "./PopoverError";
import { CostsTab } from "./RightSidebar/CostsTab";
import { ReviewPanel } from "./RightSidebar/CodeReview/ReviewPanel";
import { ExplorerTab } from "./RightSidebar/ExplorerTab";
import { FileViewerTab } from "./RightSidebar/FileViewer";
import { StatsTab } from "./RightSidebar/StatsTab";
import { TerminalTab } from "./RightSidebar/TerminalTab";
import {
  CostsTabLabel,
  ExplorerTabLabel,
  FileTabLabel,
  ReviewTabLabel,
  StatsTabLabel,
  TerminalTabLabel,
  getTabContentClassName,
  type ReviewStats,
} from "./RightSidebar/tabs";

interface WorkspaceShellProps {
  workspaceId: string;
  projectPath: string;
  projectName: string;
  workspaceName: string;
  namedWorkspacePath: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  runtimeConfig?: RuntimeConfig;
  className?: string;
  /** If 'creating', workspace is still being set up (git operations in progress) */
  status?: "creating";
}

const WorkspacePlaceholder: React.FC<{
  title: string;
  description?: string;
  className?: string;
}> = (props) => (
  <div
    className={cn(
      "flex flex-1 flex-row bg-dark text-light overflow-x-auto overflow-y-hidden [@media(max-width:768px)]:flex-col",
      props.className
    )}
    style={{ containerType: "inline-size" }}
  >
    <div className="text-placeholder flex h-full flex-1 flex-col items-center justify-center text-center">
      <h3 className="m-0 mb-2.5 text-base font-medium">{props.title}</h3>
      {props.description && <p className="m-0 text-[13px]">{props.description}</p>}
    </div>
  </div>
);

export const WorkspaceShell: React.FC<WorkspaceShellProps> = (props) => {
  const findPreferredToolsTabsetId = useCallback(
    (state: DockLayoutState<WorkspacePaneId>): string => {
      const tabsByTabset = new Map<string, WorkspacePaneId[]>();

      for (const entry of collectAllTabsWithTabset(state.root)) {
        const existing = tabsByTabset.get(entry.tabsetId) ?? [];
        existing.push(entry.tab);
        tabsByTabset.set(entry.tabsetId, existing);
      }

      for (const [tabsetId, tabs] of tabsByTabset) {
        const hasAnyToolTab = tabs.some(
          (t) => typeof t === "string" && !t.startsWith("chat:") && isTabType(t)
        );

        if (hasAnyToolTab) {
          return tabsetId;
        }
      }

      return state.focusedTabsetId;
    },
    []
  );

  const { api } = useAPI();
  const { statsTabState } = useFeatureFlags();
  const statsTabEnabled = Boolean(statsTabState?.enabled);

  const [reviewStats, setReviewStats] = useState<ReviewStats | null>(null);
  const [autoFocusTerminalSession, setAutoFocusTerminalSession] = useState<string | null>(null);

  const initialToolTab = useMemo<TabType>(() => {
    const raw = readPersistedState<string>(RIGHT_SIDEBAR_TAB_KEY, "costs");
    return isTabType(raw) ? raw : "costs";
  }, []);

  const getDefaultWorkspaceDockLayout = useCallback((): DockLayoutState<WorkspacePaneId> => {
    return getDefaultWorkspaceDockLayoutState({ initialToolTab, statsTabEnabled });
  }, [initialToolTab, statsTabEnabled]);

  const initialWorkspaceDockLayout = useMemo((): DockLayoutState<WorkspacePaneId> => {
    const oldRightSidebarRaw = readPersistedState<unknown>(
      getRightSidebarLayoutKey(props.workspaceId),
      null
    );

    // Migration: if a legacy right-sidebar layout exists, lift it into the tools region.
    if (oldRightSidebarRaw !== null) {
      return migrateRightSidebarLayoutToWorkspaceDockLayout({
        rightSidebarLayoutRaw: oldRightSidebarRaw,
        initialToolTab,
        statsTabEnabled,
      });
    }

    return getDefaultWorkspaceDockLayout();
  }, [getDefaultWorkspaceDockLayout, initialToolTab, props.workspaceId, statsTabEnabled]);

  const dockLayoutKey = getWorkspaceDockLayoutKey(props.workspaceId);
  const [dockLayoutRaw, setDockLayoutRaw] = usePersistedState<DockLayoutState<WorkspacePaneId>>(
    dockLayoutKey,
    initialWorkspaceDockLayout,
    { listener: true }
  );

  // While dragging tabs (hover-based reorder), keep layout changes in-memory and
  // commit once on drop to avoid localStorage writes on every mousemove.
  const [dockLayoutDraft, setDockLayoutDraft] = useState<DockLayoutState<WorkspacePaneId> | null>(
    null
  );
  const dockLayoutDraftRef = useRef<DockLayoutState<WorkspacePaneId> | null>(null);

  const dockLayoutRawRef = useRef(dockLayoutRaw);
  dockLayoutRawRef.current = dockLayoutRaw;

  const isTabDragInProgressRef = useRef(false);

  const parseWorkspaceDockLayout = useCallback(
    (raw: unknown): DockLayoutState<WorkspacePaneId> => {
      const defaultState = getDefaultWorkspaceDockLayout();

      return parseDockLayoutState(raw, {
        isPaneId: isWorkspacePaneId,
        defaultState,
        ensureRequiredPanes: (state) =>
          ensureWorkspaceDockLayoutState(state, {
            statsTabEnabled,
            getDefaultState: getDefaultWorkspaceDockLayout,
          }),
      });
    },
    [getDefaultWorkspaceDockLayout, statsTabEnabled]
  );

  const dockLayout = useMemo(() => {
    return parseWorkspaceDockLayout(dockLayoutDraft ?? dockLayoutRaw);
  }, [dockLayoutDraft, dockLayoutRaw, parseWorkspaceDockLayout]);

  // If we ever deserialize an invalid layout (e.g. schema changes), reset to defaults.
  React.useEffect(() => {
    if (!isDockLayoutState(dockLayoutRaw, isWorkspacePaneId)) {
      setDockLayoutRaw(dockLayout);
    }
  }, [dockLayout, dockLayoutRaw, setDockLayoutRaw]);

  const handleTabDragStart = useCallback(() => {
    isTabDragInProgressRef.current = true;
    dockLayoutDraftRef.current = null;
  }, []);

  const handleTabDragEnd = useCallback(() => {
    isTabDragInProgressRef.current = false;

    const draft = dockLayoutDraftRef.current;
    if (draft) {
      setDockLayoutRaw(draft);
    }

    dockLayoutDraftRef.current = null;
    setDockLayoutDraft(null);
  }, [setDockLayoutRaw]);

  const setDockLayout = useCallback(
    (updater: (prev: DockLayoutState<WorkspacePaneId>) => DockLayoutState<WorkspacePaneId>) => {
      if (isTabDragInProgressRef.current) {
        const base =
          dockLayoutDraftRef.current ?? parseWorkspaceDockLayout(dockLayoutRawRef.current);
        const next = updater(base);
        dockLayoutDraftRef.current = next;
        setDockLayoutDraft(next);
        return;
      }

      setDockLayoutRaw((prevRaw) => updater(parseWorkspaceDockLayout(prevRaw)));
    },
    [parseWorkspaceDockLayout, setDockLayoutRaw]
  );

  const getFallbackTabForEmptyTabset = useCallback((movedTab: WorkspacePaneId): WorkspacePaneId => {
    return typeof movedTab === "string" && movedTab.startsWith("chat:")
      ? "explorer"
      : DEFAULT_CHAT_PANE_ID;
  }, []);

  const reviews = useReviews(props.workspaceId);
  const { addReview } = reviews;
  const handleReviewNote = useCallback(
    (data: ReviewNoteData) => {
      addReview(data);
    },
    [addReview]
  );

  const workspaceState = useWorkspaceState(props.workspaceId);
  const backgroundBashError = useBackgroundBashError();

  // Costs/stats values are used for tab labels.
  const usage = useWorkspaceUsage(props.workspaceId);
  const sessionCost = useMemo(() => {
    const parts: ChatUsageDisplay[] = [];
    if (usage.sessionTotal) parts.push(usage.sessionTotal);
    if (usage.liveCostUsage) parts.push(usage.liveCostUsage);
    if (parts.length === 0) return null;

    const aggregated = sumUsageHistory(parts);
    if (!aggregated) return null;

    const total =
      (aggregated.input.cost_usd ?? 0) +
      (aggregated.cached.cost_usd ?? 0) +
      (aggregated.cacheCreate.cost_usd ?? 0) +
      (aggregated.output.cost_usd ?? 0) +
      (aggregated.reasoning.cost_usd ?? 0);

    return total > 0 ? total : null;
  }, [usage.liveCostUsage, usage.sessionTotal]);

  const statsSnapshot = useWorkspaceStatsSnapshot(props.workspaceId);
  const sessionDuration = useMemo(() => {
    if (!statsTabEnabled) return null;
    const baseDuration = statsSnapshot?.session?.totalDurationMs ?? 0;
    const activeDuration = statsSnapshot?.active?.elapsedMs ?? 0;
    const total = baseDuration + activeDuration;
    return total > 0 ? total : null;
  }, [statsSnapshot?.active?.elapsedMs, statsSnapshot?.session?.totalDurationMs, statsTabEnabled]);

  // Terminal titles from OSC sequences (e.g., shell setting window title).
  const terminalTitlesKey = getTerminalTitlesKey(props.workspaceId);
  const [terminalTitles, setTerminalTitles] = useState<Map<TabType, string>>(() => {
    const stored = readPersistedState<Record<string, string>>(terminalTitlesKey, {});
    return new Map(Object.entries(stored) as Array<[TabType, string]>);
  });

  const updateTerminalTitle = useCallback(
    (tab: TabType, title: string) => {
      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.set(tab, title);
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [terminalTitlesKey]
  );

  const openFile = useCallback(
    (relativePath: string) => {
      const tab = makeFileTabType(relativePath) as WorkspacePaneId;

      setDockLayout((prev) => {
        const existing = collectAllTabsWithTabset(prev.root).find((t) => t.tab === tab);
        if (existing) {
          const withFocus = setFocusedTabset(prev, existing.tabsetId);
          return selectTabInTabset(withFocus, existing.tabsetId, tab);
        }

        const targetTabsetId = findPreferredToolsTabsetId(prev);
        const withFocus = setFocusedTabset(prev, targetTabsetId);
        return selectTabInTabset(withFocus, targetTabsetId, tab);
      });
    },
    [findPreferredToolsTabsetId, setDockLayout]
  );

  const closeTab = useCallback(
    (tab: WorkspacePaneId) => {
      setDockLayout((prev) => removeTabEverywhere(prev, tab, getDefaultWorkspaceDockLayout));
    },
    [getDefaultWorkspaceDockLayout, setDockLayout]
  );

  const closeTerminal = useCallback(
    (tab: TabType) => {
      const sessionId = getTerminalSessionId(tab);
      if (sessionId) {
        void api?.terminal.close({ sessionId });
      }

      closeTab(tab as WorkspacePaneId);

      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.delete(tab);
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [api, closeTab, terminalTitlesKey]
  );

  const closeFile = useCallback(
    (tab: TabType) => {
      closeTab(tab as WorkspacePaneId);
    },
    [closeTab]
  );

  const handleOpenTerminal = useCallback(
    (options?: TerminalSessionCreateOptions) => {
      void (async () => {
        if (!api) return;

        const session = await createTerminalSession(api, props.workspaceId, options);
        const terminalTab = makeTerminalTabType(session.sessionId) as WorkspacePaneId;

        setAutoFocusTerminalSession(session.sessionId);

        setDockLayout((prev) => {
          const targetTabsetId = findPreferredToolsTabsetId(prev);
          const withFocus = setFocusedTabset(prev, targetTabsetId);
          return selectTabInTabset(withFocus, targetTabsetId, terminalTab);
        });
      })();
    },
    [api, findPreferredToolsTabsetId, props.workspaceId, setDockLayout]
  );

  const popOutTerminal = useCallback(
    (tab: TabType) => {
      if (!api) return;
      const sessionId = getTerminalSessionId(tab);
      if (!sessionId) return;
      openTerminalPopout(api, props.workspaceId, sessionId);
    },
    [api, props.workspaceId]
  );

  const isPaneVisible = useCallback(
    (paneId: WorkspacePaneId): boolean => {
      const entry = collectAllTabsWithTabset(dockLayout.root).find((t) => t.tab === paneId);
      if (!entry) return false;
      const tabset = findTabset(dockLayout.root, entry.tabsetId);
      return tabset?.type === "tabset" ? tabset.activeTab === paneId : false;
    },
    [dockLayout.root]
  );

  const getChatLabel = useCallback(
    (paneId: WorkspacePaneId): React.ReactNode => {
      const all = collectAllTabsWithTabset(dockLayout.root)
        .map((t) => t.tab)
        .filter((t): t is WorkspacePaneId => typeof t === "string" && t.startsWith("chat:"));

      const unique: WorkspacePaneId[] = [];
      const seen = new Set<WorkspacePaneId>();
      for (const t of all) {
        if (!seen.has(t)) {
          seen.add(t);
          unique.push(t);
        }
      }

      const index = unique.indexOf(paneId);
      if (index <= 0) return "Chat";
      return `Chat ${index + 1}`;
    },
    [dockLayout.root]
  );

  const getTerminalIndexInTabset = useCallback(
    (tab: TabType): number => {
      const entry = collectAllTabsWithTabset(dockLayout.root).find((t) => t.tab === tab);
      if (!entry) return 0;
      const tabset = findTabset(dockLayout.root, entry.tabsetId);
      if (tabset?.type !== "tabset") return 0;

      const terminalTabs = tabset.tabs.filter(
        (t): t is TabType => typeof t === "string" && isTabType(t) && isTerminalTab(t)
      );

      const index = terminalTabs.indexOf(tab);
      return index >= 0 ? index : 0;
    },
    [dockLayout.root]
  );

  const getPaneDescriptor = useCallback(
    (paneId: WorkspacePaneId): DockPaneDescriptor => {
      if (typeof paneId === "string" && paneId.startsWith("chat:")) {
        return {
          title: getChatLabel(paneId),
          contentClassName: "overflow-hidden p-0",
          keepAlive: true,
          render: () => (
            <ChatPane
              workspaceId={props.workspaceId}
              workspaceState={workspaceState}
              projectPath={props.projectPath}
              projectName={props.projectName}
              workspaceName={props.workspaceName}
              namedWorkspacePath={props.namedWorkspacePath}
              runtimeConfig={props.runtimeConfig}
              status={props.status}
              onOpenTerminal={handleOpenTerminal}
            />
          ),
        };
      }

      // Tool panes all share the RightSidebar TabType model.
      const tab = paneId as TabType;

      if (tab === "costs") {
        return {
          title: <CostsTabLabel sessionCost={sessionCost} />,
          contentClassName: getTabContentClassName(tab),
          render: () => <CostsTab workspaceId={props.workspaceId} />,
        };
      }

      if (tab === "review") {
        return {
          title: <ReviewTabLabel reviewStats={reviewStats} />,
          contentClassName: getTabContentClassName(tab),
          render: () => (
            <ReviewPanel
              workspaceId={props.workspaceId}
              workspacePath={props.namedWorkspacePath}
              projectPath={props.projectPath}
              onReviewNote={handleReviewNote}
              focusTrigger={0}
              isCreating={props.status === "creating"}
              onStatsChange={(stats) => {
                setReviewStats({ total: stats.total, read: stats.read });
              }}
              onOpenFile={openFile}
            />
          ),
        };
      }

      if (tab === "explorer") {
        return {
          title: <ExplorerTabLabel />,
          contentClassName: getTabContentClassName(tab),
          render: () => (
            <ExplorerTab
              workspaceId={props.workspaceId}
              workspacePath={props.namedWorkspacePath}
              onOpenFile={openFile}
            />
          ),
        };
      }

      if (tab === "stats") {
        return {
          title: <StatsTabLabel sessionDuration={sessionDuration} />,
          contentClassName: getTabContentClassName(tab),
          render: () => <StatsTab workspaceId={props.workspaceId} />,
        };
      }

      if (isTerminalTab(tab)) {
        const terminalIndex = getTerminalIndexInTabset(tab);
        const sessionId = getTerminalSessionId(tab);

        return {
          title: (
            <TerminalTabLabel
              terminalIndex={terminalIndex}
              dynamicTitle={terminalTitles.get(tab)}
              onPopOut={() => popOutTerminal(tab)}
              onClose={() => closeTerminal(tab)}
            />
          ),
          contentClassName: getTabContentClassName(tab),
          keepAlive: true,
          canClose: true,
          onClose: () => closeTerminal(tab),
          render: () => (
            <TerminalTab
              workspaceId={props.workspaceId}
              tabType={tab}
              visible={isPaneVisible(tab as WorkspacePaneId)}
              autoFocus={Boolean(sessionId && autoFocusTerminalSession === sessionId)}
              onAutoFocusConsumed={() => setAutoFocusTerminalSession(null)}
              onTitleChange={(title) => updateTerminalTitle(tab, title)}
            />
          ),
        };
      }

      if (isFileTab(tab)) {
        const relativePath = getFilePath(tab) ?? "";

        return {
          title: <FileTabLabel filePath={relativePath} onClose={() => closeFile(tab)} />,
          contentClassName: getTabContentClassName(tab),
          canClose: true,
          onClose: () => closeFile(tab),
          render: () => (
            <FileViewerTab
              workspaceId={props.workspaceId}
              relativePath={relativePath}
              onReviewNote={handleReviewNote}
            />
          ),
        };
      }

      return {
        title: tab,
        render: () => (
          <div className="flex h-full items-center justify-center text-red-400">
            Unknown pane: {tab}
          </div>
        ),
      };
    },
    [
      autoFocusTerminalSession,
      closeFile,
      closeTerminal,
      getChatLabel,
      isPaneVisible,
      getTerminalIndexInTabset,
      handleOpenTerminal,
      handleReviewNote,
      openFile,
      popOutTerminal,
      props.namedWorkspacePath,
      props.projectName,
      props.projectPath,
      props.runtimeConfig,
      props.status,
      props.workspaceId,
      props.workspaceName,
      reviewStats,
      sessionCost,
      sessionDuration,
      terminalTitles,
      updateTerminalTitle,
      workspaceState,
    ]
  );

  if (workspaceState.loading) {
    return <WorkspacePlaceholder title="Loading workspace..." className={props.className} />;
  }

  if (!props.projectName || !props.workspaceName) {
    return (
      <WorkspacePlaceholder
        title="No Workspace Selected"
        description="Select a workspace from the sidebar to view and interact with Claude"
        className={props.className}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-dark text-light",
        props.className
      )}
      style={{ containerType: "inline-size" }}
    >
      <WorkspaceHeader
        workspaceId={props.workspaceId}
        projectName={props.projectName}
        projectPath={props.projectPath}
        workspaceName={props.workspaceName}
        leftSidebarCollapsed={props.leftSidebarCollapsed}
        onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
        namedWorkspacePath={props.namedWorkspacePath}
        runtimeConfig={props.runtimeConfig}
        onOpenTerminal={handleOpenTerminal}
      />

      <DockLayout
        baseId={`workspace-dock-${props.workspaceId}`}
        layout={dockLayout}
        setLayout={setDockLayout}
        getPaneDescriptor={getPaneDescriptor}
        getFallbackTabForEmptyTabset={getFallbackTabForEmptyTabset}
        onTabDragStart={handleTabDragStart}
        onTabDragEnd={handleTabDragEnd}
      />

      <PopoverError
        error={backgroundBashError.error}
        prefix="Failed to terminate:"
        onDismiss={backgroundBashError.clearError}
      />
    </div>
  );
};
