import React from "react";
import {
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  getRightSidebarLayoutKey,
  getTerminalTitlesKey,
} from "@/common/constants/storage";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useWorkspaceUsage, useWorkspaceStatsSnapshot } from "@/browser/stores/WorkspaceStore";
import { useFeatureFlags } from "@/browser/contexts/FeatureFlagsContext";
import { useAPI } from "@/browser/contexts/API";
import { CostsTab } from "./RightSidebar/CostsTab";

import { ReviewPanel } from "./RightSidebar/CodeReview/ReviewPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { StatsTab } from "./RightSidebar/StatsTab";

import { sumUsageHistory, type ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { matchesKeybind, KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { SidebarCollapseButton } from "./ui/SidebarCollapseButton";
import { cn } from "@/common/lib/utils";
import type { ReviewNoteData } from "@/common/types/review";
import { TerminalTab } from "./RightSidebar/TerminalTab";
import {
  RIGHT_SIDEBAR_TABS,
  isTabType,
  isTerminalTab,
  isFileTab,
  getTerminalSessionId,
  getFilePath,
  makeTerminalTabType,
  makeFileTabType,
  type TabType,
} from "@/browser/types/rightSidebar";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  addTabToFocusedTabset,
  collectAllTabs,
  collectAllTabsWithTabset,
  dockTabToEdge,
  findTabset,
  getDefaultRightSidebarLayoutState,
  getFocusedActiveTab,
  isRightSidebarLayoutState,
  moveTabToTabset,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
  reorderTabInTabset,
  selectTabByIndex,
  selectTabInTabset,
  setFocusedTabset,
  updateSplitSizes,
  type RightSidebarLayoutNode,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import {
  RightSidebarTabStrip,
  getTabName,
  type TabDragData,
} from "./RightSidebar/RightSidebarTabStrip";
import {
  createTerminalSession,
  openTerminalPopout,
  type TerminalSessionCreateOptions,
} from "@/browser/utils/terminal";
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
import { FileViewerTab } from "./RightSidebar/FileViewer";
import { ExplorerTab } from "./RightSidebar/ExplorerTab";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";

// Re-export for consumers
export type { ReviewStats };

interface SidebarContainerProps {
  collapsed: boolean;
  /** Custom width from drag-resize (unified across all tabs) */
  customWidth?: number;
  /** Whether actively dragging resize handle (disables transition) */
  isResizing?: boolean;
  /** Whether running in Electron desktop mode (hides border when collapsed) */
  isDesktop?: boolean;
  children: React.ReactNode;
  role: string;
  "aria-label": string;
}

/**
 * SidebarContainer - Main sidebar wrapper with dynamic width
 *
 * Width priority (first match wins):
 * 1. collapsed (20px) - Shows collapse button only
 * 2. customWidth - From drag-resize (unified width from AIView)
 * 3. default (400px) - Fallback when no custom width set
 */
const SidebarContainer: React.FC<SidebarContainerProps> = ({
  collapsed,
  customWidth,
  isResizing,
  isDesktop,
  children,
  role,
  "aria-label": ariaLabel,
}) => {
  const width = collapsed ? "20px" : customWidth ? `${customWidth}px` : "400px";

  return (
    <div
      className={cn(
        "bg-sidebar border-l border-border-light flex flex-col overflow-hidden flex-shrink-0",
        !isResizing && "transition-[width] duration-200",
        collapsed && "sticky right-0 z-10 shadow-[-2px_0_4px_rgba(0,0,0,0.2)]",
        // Mobile: Show vertical meter when collapsed (20px), full width when expanded
        "max-md:border-l-0 max-md:border-t max-md:border-border-light",
        !collapsed && "max-md:w-full max-md:relative max-md:max-h-[50vh]",
        // In desktop mode, hide the left border when collapsed to avoid
        // visual separation in the titlebar area (overlay buttons zone)
        isDesktop && collapsed && "border-l-0"
      )}
      style={{ width }}
      role={role}
      aria-label={ariaLabel}
    >
      {children}
    </div>
  );
};

export { RIGHT_SIDEBAR_TABS, isTabType };
export type { TabType };

interface RightSidebarProps {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  /** Custom width in pixels (persisted per-tab, provided by AIView) */
  width?: number;
  /** Drag start handler for resize */
  onStartResize?: (e: React.MouseEvent) => void;
  /** Whether currently resizing */
  isResizing?: boolean;
  /** Callback when user adds a review note from Code Review tab */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Workspace is still being created (git operations in progress) */
  isCreating?: boolean;
  /** Ref callback to expose addTerminal function to parent */
  addTerminalRef?: React.MutableRefObject<
    ((options?: TerminalSessionCreateOptions) => void) | null
  >;
}

/**
 * Wrapper component for PanelResizeHandle that disables pointer events during tab drag.
 * Uses isDragging prop passed from parent DndContext.
 */
const DragAwarePanelResizeHandle: React.FC<{
  direction: "horizontal" | "vertical";
  isDraggingTab: boolean;
}> = ({ direction, isDraggingTab }) => {
  const className = cn(
    direction === "horizontal"
      ? "w-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-col-resize bg-border-light hover:bg-accent"
      : "h-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-row-resize bg-border-light hover:bg-accent",
    isDraggingTab && "pointer-events-none"
  );

  return <PanelResizeHandle className={className} />;
};

type TabsetNode = Extract<RightSidebarLayoutNode, { type: "tabset" }>;

interface RightSidebarTabsetNodeProps {
  node: TabsetNode;
  baseId: string;
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  isCreating: boolean;
  focusTrigger: number;
  onReviewNote?: (data: ReviewNoteData) => void;
  reviewStats: ReviewStats | null;
  onReviewStatsChange: (stats: ReviewStats | null) => void;
  sessionCost: number | null;
  statsTabEnabled: boolean;
  sessionDuration: number | null;
  /** Whether any sidebar tab is currently being dragged */
  isDraggingTab: boolean;
  /** Data about the currently dragged tab (if any) */
  activeDragData: TabDragData | null;
  setLayout: (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => void;
  /** Handler to pop out a terminal tab to a separate window */
  onPopOutTerminal: (tab: TabType) => void;
  /** Handler to add a new terminal tab */
  onAddTerminal: () => void;
  /** Handler to close a terminal tab */
  onCloseTerminal: (tab: TabType) => void;
  /** Map of terminal tab types to their current titles (from OSC sequences) */
  terminalTitles: Map<TabType, string>;
  /** Handler to update a terminal's title */
  onTerminalTitleChange: (tab: TabType, title: string) => void;
  /** Map of tab → global position index (0-based) for keybind tooltips */
  tabPositions: Map<TabType, number>;
  /** Terminal session ID that should be auto-focused (cleared once focus lands) */
  autoFocusTerminalSession: string | null;
  /** Callback to request terminal focus when a tab is selected */
  onRequestTerminalFocus: (sessionId: string) => void;
  /** Callback to clear the auto-focus state after it's been consumed */
  onAutoFocusConsumed: () => void;
  /** Handler to open a file in a new tab */
  onOpenFile: (relativePath: string) => void;
  /** Handler to close a file tab */
  onCloseFile: (tab: TabType) => void;
}

const RightSidebarTabsetNode: React.FC<RightSidebarTabsetNodeProps> = (props) => {
  const tabsetBaseId = `${props.baseId}-${props.node.id}`;

  // Content container class comes from tab registry - each tab defines its own padding/overflow
  const tabsetContentClassName = cn(
    "relative flex-1 min-h-0",
    getTabContentClassName(props.node.activeTab)
  );

  // Drop zones using @dnd-kit's useDroppable
  const { setNodeRef: contentRef, isOver: isOverContent } = useDroppable({
    id: `content:${props.node.id}`,
    data: { type: "content", tabsetId: props.node.id },
  });

  const { setNodeRef: topRef, isOver: isOverTop } = useDroppable({
    id: `edge:${props.node.id}:top`,
    data: { type: "edge", tabsetId: props.node.id, edge: "top" },
  });

  const { setNodeRef: bottomRef, isOver: isOverBottom } = useDroppable({
    id: `edge:${props.node.id}:bottom`,
    data: { type: "edge", tabsetId: props.node.id, edge: "bottom" },
  });

  const { setNodeRef: leftRef, isOver: isOverLeft } = useDroppable({
    id: `edge:${props.node.id}:left`,
    data: { type: "edge", tabsetId: props.node.id, edge: "left" },
  });

  const { setNodeRef: rightRef, isOver: isOverRight } = useDroppable({
    id: `edge:${props.node.id}:right`,
    data: { type: "edge", tabsetId: props.node.id, edge: "right" },
  });

  const showDockHints =
    props.isDraggingTab &&
    (isOverContent || isOverTop || isOverBottom || isOverLeft || isOverRight);

  const setFocused = () => {
    props.setLayout((prev) => setFocusedTabset(prev, props.node.id));
  };

  const selectTab = (tab: TabType) => {
    if (isTerminalTab(tab)) {
      const sessionId = getTerminalSessionId(tab);
      if (sessionId) {
        props.onRequestTerminalFocus(sessionId);
      }
    }

    props.setLayout((prev) => {
      const withFocus = setFocusedTabset(prev, props.node.id);
      return selectTabInTabset(withFocus, props.node.id, tab);
    });
  };

  // Count terminal tabs in this tabset for numbering (Terminal, Terminal 2, etc.)
  const terminalTabs = props.node.tabs.filter(isTerminalTab);

  const items = props.node.tabs.flatMap((tab) => {
    if (tab === "stats" && !props.statsTabEnabled) {
      return [];
    }

    const tabId = `${tabsetBaseId}-tab-${tab}`;
    const panelId = `${tabsetBaseId}-panel-${tab}`;

    // Show keybind for tabs 1-9 based on their position in the layout
    const isTerminal = isTerminalTab(tab);
    const isFile = isFileTab(tab);
    const tabPosition = props.tabPositions.get(tab);
    const keybinds = [
      KEYBINDS.SIDEBAR_TAB_1,
      KEYBINDS.SIDEBAR_TAB_2,
      KEYBINDS.SIDEBAR_TAB_3,
      KEYBINDS.SIDEBAR_TAB_4,
      KEYBINDS.SIDEBAR_TAB_5,
      KEYBINDS.SIDEBAR_TAB_6,
      KEYBINDS.SIDEBAR_TAB_7,
      KEYBINDS.SIDEBAR_TAB_8,
      KEYBINDS.SIDEBAR_TAB_9,
    ];
    const keybindStr =
      tabPosition !== undefined && tabPosition < keybinds.length
        ? formatKeybind(keybinds[tabPosition])
        : undefined;

    // For file tabs, show path + keybind; for others just keybind
    let tooltip: React.ReactNode;
    if (isFile) {
      const filePath = getFilePath(tab);
      tooltip = (
        <div className="flex flex-col">
          <span>{filePath}</span>
          {keybindStr && <span className="text-muted-foreground">{keybindStr}</span>}
        </div>
      );
    } else {
      tooltip = keybindStr;
    }

    // Build label using tab-specific label components
    let label: React.ReactNode;

    if (tab === "costs") {
      label = <CostsTabLabel sessionCost={props.sessionCost} />;
    } else if (tab === "review") {
      label = <ReviewTabLabel reviewStats={props.reviewStats} />;
    } else if (tab === "explorer") {
      label = <ExplorerTabLabel />;
    } else if (tab === "stats") {
      label = <StatsTabLabel sessionDuration={props.sessionDuration} />;
    } else if (isTerminal) {
      const terminalIndex = terminalTabs.indexOf(tab);
      label = (
        <TerminalTabLabel
          dynamicTitle={props.terminalTitles.get(tab)}
          terminalIndex={terminalIndex}
          onPopOut={() => props.onPopOutTerminal(tab)}
          onClose={() => props.onCloseTerminal(tab)}
        />
      );
    } else if (isFileTab(tab)) {
      const filePath = getFilePath(tab);
      label = <FileTabLabel filePath={filePath ?? tab} onClose={() => props.onCloseFile(tab)} />;
    } else {
      label = tab;
    }

    return [
      {
        id: tabId,
        panelId,
        selected: props.node.activeTab === tab,
        onSelect: () => selectTab(tab),
        label,
        tooltip,
        tab,
        // Terminal and file tabs are closeable
        onClose: isTerminal
          ? () => props.onCloseTerminal(tab)
          : isFileTab(tab)
            ? () => props.onCloseFile(tab)
            : undefined,
      },
    ];
  });

  const costsPanelId = `${tabsetBaseId}-panel-costs`;
  const reviewPanelId = `${tabsetBaseId}-panel-review`;
  const explorerPanelId = `${tabsetBaseId}-panel-explorer`;
  const statsPanelId = `${tabsetBaseId}-panel-stats`;

  const costsTabId = `${tabsetBaseId}-tab-costs`;
  const reviewTabId = `${tabsetBaseId}-tab-review`;
  const explorerTabId = `${tabsetBaseId}-tab-explorer`;
  const statsTabId = `${tabsetBaseId}-tab-stats`;

  // Generate sortable IDs for tabs in this tabset
  const sortableIds = items.map((item) => `${props.node.id}:${item.tab}`);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onMouseDownCapture={setFocused}>
      <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
        <RightSidebarTabStrip
          ariaLabel="Sidebar views"
          items={items}
          tabsetId={props.node.id}
          onAddTerminal={props.onAddTerminal}
        />
      </SortableContext>
      <div
        ref={contentRef}
        className={cn(
          tabsetContentClassName,
          props.isDraggingTab && isOverContent && "bg-accent/10 ring-1 ring-accent/50"
        )}
      >
        {/* Edge docking zones - always rendered but only visible/interactive during drag */}
        <div
          ref={topRef}
          className={cn(
            "absolute inset-x-0 top-0 z-10 h-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverTop ? "bg-accent/20 border-b border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={bottomRef}
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 h-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverBottom ? "bg-accent/20 border-t border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={leftRef}
          className={cn(
            "absolute inset-y-0 left-0 z-10 w-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverLeft ? "bg-accent/20 border-r border-accent" : "bg-accent/5"
          )}
        />
        <div
          ref={rightRef}
          className={cn(
            "absolute inset-y-0 right-0 z-10 w-10 transition-opacity",
            props.isDraggingTab
              ? showDockHints
                ? "opacity-100"
                : "opacity-0"
              : "opacity-0 pointer-events-none",
            isOverRight ? "bg-accent/20 border-l border-accent" : "bg-accent/5"
          )}
        />

        {props.node.activeTab === "costs" && (
          <div role="tabpanel" id={costsPanelId} aria-labelledby={costsTabId}>
            <CostsTab workspaceId={props.workspaceId} />
          </div>
        )}

        {/* Render all terminal tabs (keep-alive: hidden but mounted) */}
        {terminalTabs.map((terminalTab) => {
          const terminalTabId = `${tabsetBaseId}-tab-${terminalTab}`;
          const terminalPanelId = `${tabsetBaseId}-panel-${terminalTab}`;
          const isActive = props.node.activeTab === terminalTab;
          // Check if this terminal should be auto-focused (was just opened via keybind)
          const terminalSessionId = getTerminalSessionId(terminalTab);
          const shouldAutoFocus = isActive && terminalSessionId === props.autoFocusTerminalSession;

          return (
            <div
              key={terminalPanelId}
              role="tabpanel"
              id={terminalPanelId}
              aria-labelledby={terminalTabId}
              className="h-full"
              hidden={!isActive}
            >
              <TerminalTab
                workspaceId={props.workspaceId}
                tabType={terminalTab}
                visible={isActive}
                onTitleChange={(title) => props.onTerminalTitleChange(terminalTab, title)}
                autoFocus={shouldAutoFocus}
                onAutoFocusConsumed={shouldAutoFocus ? props.onAutoFocusConsumed : undefined}
              />
            </div>
          );
        })}

        {props.node.tabs.includes("stats") && props.statsTabEnabled && (
          <div
            role="tabpanel"
            id={statsPanelId}
            aria-labelledby={statsTabId}
            hidden={props.node.activeTab !== "stats"}
          >
            <ErrorBoundary workspaceInfo="Stats tab">
              <StatsTab workspaceId={props.workspaceId} />
            </ErrorBoundary>
          </div>
        )}

        {props.node.activeTab === "explorer" && (
          <div
            role="tabpanel"
            id={explorerPanelId}
            aria-labelledby={explorerTabId}
            className="h-full"
          >
            <ExplorerTab
              workspaceId={props.workspaceId}
              workspacePath={props.workspacePath}
              onOpenFile={props.onOpenFile}
            />
          </div>
        )}

        {/* Render file viewer tabs */}
        {props.node.tabs.filter(isFileTab).map((fileTab) => {
          const filePath = getFilePath(fileTab);
          const fileTabId = `${tabsetBaseId}-tab-${fileTab}`;
          const filePanelId = `${tabsetBaseId}-panel-${fileTab}`;
          const isActive = props.node.activeTab === fileTab;

          return (
            <div
              key={filePanelId}
              role="tabpanel"
              id={filePanelId}
              aria-labelledby={fileTabId}
              className="h-full"
              hidden={!isActive}
            >
              {isActive && filePath && (
                <FileViewerTab
                  workspaceId={props.workspaceId}
                  relativePath={filePath}
                  onReviewNote={props.onReviewNote}
                />
              )}
            </div>
          );
        })}

        {props.node.activeTab === "review" && (
          <div role="tabpanel" id={reviewPanelId} aria-labelledby={reviewTabId} className="h-full">
            <ReviewPanel
              key={`${props.workspaceId}:${props.node.id}`}
              workspaceId={props.workspaceId}
              workspacePath={props.workspacePath}
              projectPath={props.projectPath}
              onReviewNote={props.onReviewNote}
              focusTrigger={props.focusTrigger}
              isCreating={props.isCreating}
              onStatsChange={props.onReviewStatsChange}
              onOpenFile={props.onOpenFile}
            />
          </div>
        )}
      </div>
    </div>
  );
};

const RightSidebarComponent: React.FC<RightSidebarProps> = ({
  workspaceId,
  workspacePath,
  projectPath,
  width,
  onStartResize,
  isResizing = false,
  onReviewNote,
  isCreating = false,
  addTerminalRef,
}) => {
  // Trigger for focusing Review panel (preserves hunk selection)
  const [focusTrigger, _setFocusTrigger] = React.useState(0);

  // Review stats reported by ReviewPanel
  const [reviewStats, setReviewStats] = React.useState<ReviewStats | null>(null);

  // Terminal session ID that should be auto-focused (new terminal or explicit tab focus).
  const [autoFocusTerminalSession, setAutoFocusTerminalSession] = React.useState<string | null>(
    null
  );

  // Manual collapse state (persisted globally)
  const [collapsed, setCollapsed] = usePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false, {
    listener: true,
  });

  // Stats tab feature flag
  const { statsTabState } = useFeatureFlags();
  const statsTabEnabled = Boolean(statsTabState?.enabled);

  // Read last-used focused tab for better defaults when initializing a new layout.
  const initialActiveTab = React.useMemo<TabType>(() => {
    const raw = readPersistedState<string>(RIGHT_SIDEBAR_TAB_KEY, "costs");
    return isTabType(raw) ? raw : "costs";
  }, []);

  const defaultLayout = React.useMemo(
    () => getDefaultRightSidebarLayoutState(initialActiveTab),
    [initialActiveTab]
  );

  // Layout is per-workspace so each workspace can have its own split/tab configuration
  // (e.g., different numbers of terminals). Width and collapsed state remain global.
  const layoutKey = getRightSidebarLayoutKey(workspaceId);
  const [layoutRaw, setLayoutRaw] = usePersistedState<RightSidebarLayoutState>(
    layoutKey,
    defaultLayout,
    {
      listener: true,
    }
  );

  // While dragging tabs (hover-based reorder), keep layout changes in-memory and
  // commit once on drop to avoid localStorage writes on every mousemove.
  const [layoutDraft, setLayoutDraft] = React.useState<RightSidebarLayoutState | null>(null);
  const layoutDraftRef = React.useRef<RightSidebarLayoutState | null>(null);

  // Ref to access latest layoutRaw without causing callback recreation
  const layoutRawRef = React.useRef(layoutRaw);
  layoutRawRef.current = layoutRaw;

  const isSidebarTabDragInProgressRef = React.useRef(false);

  const handleSidebarTabDragStart = React.useCallback(() => {
    isSidebarTabDragInProgressRef.current = true;
    layoutDraftRef.current = null;
  }, []);

  const handleSidebarTabDragEnd = React.useCallback(() => {
    isSidebarTabDragInProgressRef.current = false;

    const draft = layoutDraftRef.current;
    if (draft) {
      setLayoutRaw(draft);
    }

    layoutDraftRef.current = null;
    setLayoutDraft(null);
  }, [setLayoutRaw]);

  const layout = React.useMemo(
    () => parseRightSidebarLayoutState(layoutDraft ?? layoutRaw, initialActiveTab),
    [layoutDraft, layoutRaw, initialActiveTab]
  );

  // If the Stats tab feature is enabled, ensure it exists in the layout.
  // If disabled, ensure it doesn't linger in persisted layouts.
  React.useEffect(() => {
    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasStats = collectAllTabs(prev.root).includes("stats");

      if (statsTabEnabled && !hasStats) {
        // Add stats tab to the focused tabset without stealing focus.
        return addTabToFocusedTabset(prev, "stats", false);
      }

      if (!statsTabEnabled && hasStats) {
        return removeTabEverywhere(prev, "stats");
      }

      return prev;
    });
  }, [initialActiveTab, setLayoutRaw, statsTabEnabled]);
  // If we ever deserialize an invalid layout (e.g. schema changes), reset to defaults.
  React.useEffect(() => {
    if (!isRightSidebarLayoutState(layoutRaw)) {
      setLayoutRaw(layout);
    }
  }, [layout, layoutRaw, setLayoutRaw]);

  const getBaseLayout = React.useCallback(() => {
    return (
      layoutDraftRef.current ?? parseRightSidebarLayoutState(layoutRawRef.current, initialActiveTab)
    );
  }, [initialActiveTab]);

  const focusActiveTerminal = React.useCallback(
    (state: RightSidebarLayoutState) => {
      const activeTab = getFocusedActiveTab(state, initialActiveTab);
      if (!isTerminalTab(activeTab)) {
        return;
      }
      const sessionId = getTerminalSessionId(activeTab);
      if (sessionId) {
        setAutoFocusTerminalSession(sessionId);
      }
    },
    [initialActiveTab, setAutoFocusTerminalSession]
  );

  const setLayout = React.useCallback(
    (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => {
      if (isSidebarTabDragInProgressRef.current) {
        // Use ref to get latest layoutRaw without dependency
        const base =
          layoutDraftRef.current ??
          parseRightSidebarLayoutState(layoutRawRef.current, initialActiveTab);
        const next = updater(base);
        layoutDraftRef.current = next;
        setLayoutDraft(next);
        return;
      }

      setLayoutRaw((prevRaw) => updater(parseRightSidebarLayoutState(prevRaw, initialActiveTab)));
    },
    [initialActiveTab, setLayoutRaw]
  );

  // Keyboard shortcuts for tab switching by position (Cmd/Ctrl+1-9)
  // Auto-expands sidebar if collapsed
  React.useEffect(() => {
    const tabKeybinds = [
      KEYBINDS.SIDEBAR_TAB_1,
      KEYBINDS.SIDEBAR_TAB_2,
      KEYBINDS.SIDEBAR_TAB_3,
      KEYBINDS.SIDEBAR_TAB_4,
      KEYBINDS.SIDEBAR_TAB_5,
      KEYBINDS.SIDEBAR_TAB_6,
      KEYBINDS.SIDEBAR_TAB_7,
      KEYBINDS.SIDEBAR_TAB_8,
      KEYBINDS.SIDEBAR_TAB_9,
    ];

    const handleKeyDown = (e: KeyboardEvent) => {
      for (let i = 0; i < tabKeybinds.length; i++) {
        if (matchesKeybind(e, tabKeybinds[i])) {
          e.preventDefault();

          const currentLayout = parseRightSidebarLayoutState(
            layoutRawRef.current,
            initialActiveTab
          );
          const allTabs = collectAllTabsWithTabset(currentLayout.root);
          const target = allTabs[i];
          if (target && isTerminalTab(target.tab)) {
            const sessionId = getTerminalSessionId(target.tab);
            if (sessionId) {
              setAutoFocusTerminalSession(sessionId);
            }
          }

          setLayout((prev) => selectTabByIndex(prev, i));
          setCollapsed(false);
          return;
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [initialActiveTab, setAutoFocusTerminalSession, setCollapsed, setLayout]);

  const usage = useWorkspaceUsage(workspaceId);

  const baseId = `right-sidebar-${workspaceId}`;

  // Build map of tab → position for keybind tooltips
  const tabPositions = React.useMemo(() => {
    const allTabs = collectAllTabsWithTabset(layout.root);
    const positions = new Map<TabType, number>();
    allTabs.forEach(({ tab }, index) => {
      positions.set(tab, index);
    });
    return positions;
  }, [layout.root]);

  // Calculate session cost for tab display
  const sessionCost = React.useMemo(() => {
    const parts: ChatUsageDisplay[] = [];
    if (usage.sessionTotal) parts.push(usage.sessionTotal);
    if (usage.liveCostUsage) parts.push(usage.liveCostUsage);
    if (parts.length === 0) return null;

    const aggregated = sumUsageHistory(parts);
    if (!aggregated) return null;

    // Sum all cost components
    const total =
      (aggregated.input.cost_usd ?? 0) +
      (aggregated.cached.cost_usd ?? 0) +
      (aggregated.cacheCreate.cost_usd ?? 0) +
      (aggregated.output.cost_usd ?? 0) +
      (aggregated.reasoning.cost_usd ?? 0);
    return total > 0 ? total : null;
  }, [usage.sessionTotal, usage.liveCostUsage]);

  const statsSnapshot = useWorkspaceStatsSnapshot(workspaceId);

  const sessionDuration = (() => {
    if (!statsTabEnabled) return null;
    const baseDuration = statsSnapshot?.session?.totalDurationMs ?? 0;
    const activeDuration = statsSnapshot?.active?.elapsedMs ?? 0;
    const total = baseDuration + activeDuration;
    return total > 0 ? total : null;
  })();

  // @dnd-kit state for tracking active drag
  const [activeDragData, setActiveDragData] = React.useState<TabDragData | null>(null);

  // Terminal titles from OSC sequences (e.g., shell setting window title)
  // Persisted to localStorage so they survive reload
  const terminalTitlesKey = getTerminalTitlesKey(workspaceId);
  const [terminalTitles, setTerminalTitles] = React.useState<Map<TabType, string>>(() => {
    const stored = readPersistedState<Record<string, string>>(terminalTitlesKey, {});
    return new Map(Object.entries(stored) as Array<[TabType, string]>);
  });

  // API for opening terminal windows and managing sessions
  const { api } = useAPI();

  // Keyboard shortcut for closing active tab (Ctrl/Cmd+W)
  // Works for terminal tabs and file tabs
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!matchesKeybind(e, KEYBINDS.CLOSE_TAB)) return;

      const focusedTabset = findTabset(layout.root, layout.focusedTabsetId);
      if (focusedTabset?.type !== "tabset") return;

      const activeTab = focusedTabset.activeTab;

      // Handle terminal tabs
      if (isTerminalTab(activeTab)) {
        e.preventDefault();

        // Close the backend session
        const sessionId = getTerminalSessionId(activeTab);
        if (sessionId) {
          void api?.terminal.close({ sessionId });
        }

        const nextLayout = removeTabEverywhere(layout, activeTab);
        setLayout(() => nextLayout);
        focusActiveTerminal(nextLayout);

        // Clean up title (and persist)
        setTerminalTitles((prev) => {
          const next = new Map(prev);
          next.delete(activeTab);
          updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
          return next;
        });
        return;
      }

      // Handle file tabs
      if (isFileTab(activeTab)) {
        e.preventDefault();
        const nextLayout = removeTabEverywhere(layout, activeTab);
        setLayout(() => nextLayout);
        focusActiveTerminal(nextLayout);
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [api, focusActiveTerminal, layout, setLayout, terminalTitlesKey]);

  // Sync terminal tabs with backend sessions on workspace mount.
  // - Adds tabs for backend sessions that don't have tabs (restore after reload)
  // - Removes "ghost" tabs for sessions that no longer exist (cleanup after app restart)
  React.useEffect(() => {
    if (!api) return;

    let cancelled = false;

    void api.terminal.listSessions({ workspaceId }).then((backendSessionIds) => {
      if (cancelled) return;

      const backendSessionSet = new Set(backendSessionIds);

      // Get current terminal tabs in layout
      const currentTabs = collectAllTabs(layout.root);
      const currentTerminalTabs = currentTabs.filter(isTerminalTab);
      const currentTerminalSessionIds = new Set(
        currentTerminalTabs.map(getTerminalSessionId).filter(Boolean)
      );

      // Find sessions that don't have tabs yet (add them)
      const missingSessions = backendSessionIds.filter(
        (sid) => !currentTerminalSessionIds.has(sid)
      );

      // Find tabs for sessions that no longer exist in backend (remove them)
      const ghostTabs = currentTerminalTabs.filter((tab) => {
        const sessionId = getTerminalSessionId(tab);
        return sessionId && !backendSessionSet.has(sessionId);
      });

      if (missingSessions.length > 0 || ghostTabs.length > 0) {
        setLayout((prev) => {
          let next = prev;

          // Remove ghost tabs first
          for (const ghostTab of ghostTabs) {
            next = removeTabEverywhere(next, ghostTab);
          }

          // Add tabs for backend sessions that don't have tabs
          for (const sessionId of missingSessions) {
            next = addTabToFocusedTabset(next, makeTerminalTabType(sessionId), false);
          }

          return next;
        });
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only run on workspace change, not layout change. layout.root would cause infinite loop.
  }, [api, workspaceId, setLayout]);

  // Handler to update a terminal's title (from OSC sequences)
  // Also persists to localStorage for reload survival
  const handleTerminalTitleChange = React.useCallback(
    (tab: TabType, title: string) => {
      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.set(tab, title);
        // Persist to localStorage
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [terminalTitlesKey]
  );

  // Handler to add a new terminal tab.
  // Creates the backend session first, then adds the tab with the real sessionId.
  // This ensures the tabType (and React key) never changes, preventing remounts.
  const handleAddTerminal = React.useCallback(
    (options?: TerminalSessionCreateOptions) => {
      if (!api) return;

      // Also expand sidebar if collapsed
      setCollapsed(false);

      void createTerminalSession(api, workspaceId, options).then((session) => {
        const newTab = makeTerminalTabType(session.sessionId);
        setLayout((prev) => addTabToFocusedTabset(prev, newTab));
        // Schedule focus for this terminal (will be consumed when the tab mounts)
        setAutoFocusTerminalSession(session.sessionId);
      });
    },
    [api, workspaceId, setLayout, setCollapsed]
  );

  // Expose handleAddTerminal to parent via ref (for Cmd/Ctrl+T keybind)
  React.useEffect(() => {
    if (addTerminalRef) {
      addTerminalRef.current = handleAddTerminal;
    }
    return () => {
      if (addTerminalRef) {
        addTerminalRef.current = null;
      }
    };
  }, [addTerminalRef, handleAddTerminal]);

  // Handler to close a terminal tab
  const handleCloseTerminal = React.useCallback(
    (tab: TabType) => {
      // Close the backend session
      const sessionId = getTerminalSessionId(tab);
      if (sessionId) {
        void api?.terminal.close({ sessionId });
      }

      const nextLayout = removeTabEverywhere(getBaseLayout(), tab);
      setLayout(() => nextLayout);
      focusActiveTerminal(nextLayout);

      // Clean up title (and persist)
      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.delete(tab);
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [api, focusActiveTerminal, getBaseLayout, setLayout, terminalTitlesKey]
  );

  // Handler to pop out a terminal to a separate window, then remove the tab
  const handlePopOutTerminal = React.useCallback(
    (tab: TabType) => {
      if (!api) return;

      // Session ID is embedded in the tab type
      const sessionId = getTerminalSessionId(tab);
      if (!sessionId) return; // Can't pop out without a session

      // Open the pop-out window (handles browser vs Electron modes)
      openTerminalPopout(api, workspaceId, sessionId);

      // Remove the tab from the sidebar (terminal now lives in its own window)
      // Don't close the session - the pop-out window takes over
      setLayout((prev) => removeTabEverywhere(prev, tab));

      // Clean up title (and persist)
      setTerminalTitles((prev) => {
        const next = new Map(prev);
        next.delete(tab);
        updatePersistedState(terminalTitlesKey, Object.fromEntries(next));
        return next;
      });
    },
    [workspaceId, api, setLayout, terminalTitlesKey]
  );

  // Configure sensors with distance threshold for click vs drag disambiguation

  // Handler to open a file in a new tab
  const handleOpenFile = React.useCallback(
    (relativePath: string) => {
      const fileTabType = makeFileTabType(relativePath);

      // Check if the file is already open
      const allTabs = collectAllTabs(layout.root);
      if (allTabs.includes(fileTabType)) {
        // File already open - just select it
        const tabsetId = collectAllTabsWithTabset(layout.root).find(
          (t) => t.tab === fileTabType
        )?.tabsetId;
        if (tabsetId) {
          setLayout((prev) => {
            const withFocus = setFocusedTabset(prev, tabsetId);
            return selectTabInTabset(withFocus, tabsetId, fileTabType);
          });
        }
        return;
      }

      // Add new file tab to the focused tabset
      setLayout((prev) => addTabToFocusedTabset(prev, fileTabType));
    },
    [layout.root, setLayout]
  );

  // Handler to close a file tab
  const handleCloseFile = React.useCallback(
    (tab: TabType) => {
      const nextLayout = removeTabEverywhere(getBaseLayout(), tab);
      setLayout(() => nextLayout);
      focusActiveTerminal(nextLayout);
    },
    [focusActiveTerminal, getBaseLayout, setLayout]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // 8px movement required before drag starts
      },
    })
  );

  const handleDragStart = React.useCallback(
    (event: DragStartEvent) => {
      const data = event.active.data.current as TabDragData | undefined;
      if (data) {
        setActiveDragData(data);
        handleSidebarTabDragStart();
      }
    },
    [handleSidebarTabDragStart]
  );

  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeData = active.data.current as TabDragData | undefined;

      if (activeData && over) {
        const overData = over.data.current as
          | { type: "edge"; tabsetId: string; edge: "top" | "bottom" | "left" | "right" }
          | { type: "content"; tabsetId: string }
          | { tabsetId: string }
          | TabDragData
          | undefined;

        if (overData) {
          // Handle dropping on edge zones (create splits)
          if ("type" in overData && overData.type === "edge") {
            setLayout((prev) =>
              dockTabToEdge(
                prev,
                activeData.tab,
                activeData.sourceTabsetId,
                overData.tabsetId,
                overData.edge
              )
            );
          }
          // Handle dropping on content area (move to tabset)
          else if ("type" in overData && overData.type === "content") {
            if (activeData.sourceTabsetId !== overData.tabsetId) {
              setLayout((prev) =>
                moveTabToTabset(prev, activeData.tab, activeData.sourceTabsetId, overData.tabsetId)
              );
            }
          }
          // Handle dropping on another tabstrip (move to tabset)
          else if ("tabsetId" in overData && !("tab" in overData)) {
            if (activeData.sourceTabsetId !== overData.tabsetId) {
              setLayout((prev) =>
                moveTabToTabset(prev, activeData.tab, activeData.sourceTabsetId, overData.tabsetId)
              );
            }
          }
          // Handle reordering within same tabset (sortable handles this via arrayMove pattern)
          else if ("tab" in overData && "sourceTabsetId" in overData) {
            // Both are tabs - check if same tabset for reorder
            if (activeData.sourceTabsetId === overData.sourceTabsetId) {
              const fromIndex = activeData.index;
              const toIndex = overData.index;
              if (fromIndex !== toIndex) {
                setLayout((prev) =>
                  reorderTabInTabset(prev, activeData.sourceTabsetId, fromIndex, toIndex)
                );
              }
            } else {
              // Different tabsets - move tab
              setLayout((prev) =>
                moveTabToTabset(
                  prev,
                  activeData.tab,
                  activeData.sourceTabsetId,
                  overData.sourceTabsetId
                )
              );
            }
          }
        }
      }

      setActiveDragData(null);
      handleSidebarTabDragEnd();
    },
    [setLayout, handleSidebarTabDragEnd]
  );

  const isDraggingTab = activeDragData !== null;

  const renderLayoutNode = (node: RightSidebarLayoutNode): React.ReactNode => {
    if (node.type === "split") {
      // Our layout uses "horizontal" to mean a horizontal divider (top/bottom panes).
      // react-resizable-panels uses "vertical" for top/bottom.
      const groupDirection = node.direction === "horizontal" ? "vertical" : "horizontal";

      return (
        <PanelGroup
          direction={groupDirection}
          className="flex min-h-0 min-w-0 flex-1"
          onLayout={(sizes) => {
            if (sizes.length !== 2) return;
            const nextSizes: [number, number] = [
              typeof sizes[0] === "number" ? sizes[0] : 50,
              typeof sizes[1] === "number" ? sizes[1] : 50,
            ];
            setLayout((prev) => updateSplitSizes(prev, node.id, nextSizes));
          }}
        >
          <Panel defaultSize={node.sizes[0]} minSize={15} className="flex min-h-0 min-w-0 flex-col">
            {renderLayoutNode(node.children[0])}
          </Panel>
          <DragAwarePanelResizeHandle direction={groupDirection} isDraggingTab={isDraggingTab} />
          <Panel defaultSize={node.sizes[1]} minSize={15} className="flex min-h-0 min-w-0 flex-col">
            {renderLayoutNode(node.children[1])}
          </Panel>
        </PanelGroup>
      );
    }

    return (
      <RightSidebarTabsetNode
        key={node.id}
        node={node}
        baseId={baseId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        projectPath={projectPath}
        isCreating={Boolean(isCreating)}
        focusTrigger={focusTrigger}
        onReviewNote={onReviewNote}
        reviewStats={reviewStats}
        statsTabEnabled={statsTabEnabled}
        sessionDuration={sessionDuration}
        onReviewStatsChange={setReviewStats}
        isDraggingTab={isDraggingTab}
        activeDragData={activeDragData}
        sessionCost={sessionCost}
        setLayout={setLayout}
        onPopOutTerminal={handlePopOutTerminal}
        onAddTerminal={handleAddTerminal}
        onCloseTerminal={handleCloseTerminal}
        terminalTitles={terminalTitles}
        onTerminalTitleChange={handleTerminalTitleChange}
        tabPositions={tabPositions}
        onRequestTerminalFocus={setAutoFocusTerminalSession}
        autoFocusTerminalSession={autoFocusTerminalSession}
        onAutoFocusConsumed={() => setAutoFocusTerminalSession(null)}
        onOpenFile={handleOpenFile}
        onCloseFile={handleCloseFile}
      />
    );
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <SidebarContainer
        collapsed={collapsed}
        isResizing={isResizing}
        isDesktop={isDesktopMode()}
        customWidth={width} // Unified width from AIView (applies to all tabs)
        role="complementary"
        aria-label="Workspace insights"
      >
        {!collapsed && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-row">
            {/* Resize handle (left edge) */}
            {onStartResize && (
              <div
                className={cn(
                  "w-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-col-resize",
                  isResizing ? "bg-accent" : "bg-border-light hover:bg-accent"
                )}
                onMouseDown={(e) => onStartResize(e as unknown as React.MouseEvent)}
              />
            )}

            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {renderLayoutNode(layout.root)}
            </div>
          </div>
        )}

        <SidebarCollapseButton
          collapsed={collapsed}
          onToggle={() => setCollapsed(!collapsed)}
          side="right"
        />
      </SidebarContainer>

      {/* Drag overlay - shows tab being dragged at cursor position */}
      <DragOverlay>
        {activeDragData ? (
          <div className="border-border bg-background/95 cursor-grabbing rounded-md border px-3 py-1 text-xs font-medium shadow">
            {getTabName(activeDragData.tab)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
};

// Memoize to prevent re-renders when parent (AIView) re-renders during streaming
// Only re-renders when workspaceId or chatAreaRef changes, or internal state updates
export const RightSidebar = React.memo(RightSidebarComponent);
