import React from "react";
import {
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_LAYOUT_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
} from "@/common/constants/storage";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useWorkspaceUsage, useWorkspaceStatsSnapshot } from "@/browser/stores/WorkspaceStore";
import { useFeatureFlags } from "@/browser/contexts/FeatureFlagsContext";
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
import { RIGHT_SIDEBAR_TABS, isTabType, type TabType } from "@/browser/types/rightSidebar";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  collectActiveTabs,
  dockTabToEdge,
  getDefaultRightSidebarLayoutState,
  getFocusedActiveTab,
  isRightSidebarLayoutState,
  moveTabToTabset,
  parseRightSidebarLayoutState,
  removeTabEverywhere,
  reorderTabInTabset,
  selectTabInFocusedTabset,
  selectTabInTabset,
  setFocusedTabset,
  updateSplitSizes,
  type RightSidebarLayoutNode,
  type RightSidebarLayoutState,
} from "@/browser/utils/rightSidebarLayout";
import {
  RightSidebarTabStrip,
  SIDEBAR_TAB_DRAG_TYPE,
  type TabDragItem,
} from "./RightSidebar/RightSidebarTabStrip";
import { DndProvider, useDragLayer, useDrop } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";

/** Stats reported by ReviewPanel for tab display */
export interface ReviewStats {
  total: number;
  read: number;
}

/** Format duration for tab display (compact format) */
function formatTabDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
}

interface SidebarContainerProps {
  collapsed: boolean;
  wide?: boolean;
  /** Custom width from drag-resize (persisted per-tab by AIView) */
  customWidth?: number;
  /** Whether actively dragging resize handle (disables transition) */
  isResizing?: boolean;
  children: React.ReactNode;
  role: string;
  "aria-label": string;
}

/**
 * SidebarContainer - Main sidebar wrapper with dynamic width
 *
 * Width priority (first match wins):
 * 1. collapsed (20px) - Shows collapse button only
 * 2. customWidth - From drag-resize (always available now)
 * 3. wide - Auto-calculated max width for Review/Terminal tabs (when not resizing)
 * 4. default (300px) - Fallback for Costs tab
 */
const SidebarContainer: React.FC<SidebarContainerProps> = ({
  collapsed,
  wide,
  customWidth,
  isResizing,
  children,
  role,
  "aria-label": ariaLabel,
}) => {
  const width = collapsed
    ? "20px"
    : customWidth
      ? `${customWidth}px`
      : wide
        ? "min(1200px, calc(100vw - 400px))"
        : "300px";

  return (
    <div
      className={cn(
        "bg-sidebar border-l border-border-light flex flex-col overflow-hidden flex-shrink-0",
        !isResizing && "transition-[width] duration-200",
        collapsed && "sticky right-0 z-10 shadow-[-2px_0_4px_rgba(0,0,0,0.2)]",
        // Mobile: Show vertical meter when collapsed (20px), full width when expanded
        "max-md:border-l-0 max-md:border-t max-md:border-border-light",
        !collapsed && "max-md:w-full max-md:relative max-md:max-h-[50vh]"
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
}

type TabsetNode = Extract<RightSidebarLayoutNode, { type: "tabset" }>;

interface RightSidebarTabsetNodeProps {
  node: TabsetNode;
  baseId: string;
  workspaceId: string;
  workspacePath: string;
  isCreating: boolean;
  focusTrigger: number;
  onReviewNote?: (data: ReviewNoteData) => void;
  onReviewSelected: () => void;
  reviewStats: ReviewStats | null;
  onReviewStatsChange: (stats: ReviewStats | null) => void;
  sessionCost: number | null;
  statsTabEnabled: boolean;
  sessionDuration: number | null;
  setLayout: (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => void;
}

const RightSidebarTabsetNode: React.FC<RightSidebarTabsetNodeProps> = (props) => {
  const tabsetBaseId = `${props.baseId}-${props.node.id}`;

  const tabsetContentClassName = cn(
    "relative flex-1 min-h-0",
    props.node.activeTab === "terminal" ? "overflow-hidden p-0" : "overflow-y-auto",
    props.node.activeTab === "review"
      ? "p-0"
      : props.node.activeTab === "costs" || props.node.activeTab === "stats"
        ? "p-[15px]"
        : "p-0"
  );

  const isDraggingSidebarTab = useDragLayer(
    (monitor) => monitor.isDragging() && monitor.getItemType() === SIDEBAR_TAB_DRAG_TYPE
  );

  const [{ isOver: isOverContent, canDrop: canDropContent }, contentDrop] = useDrop<
    TabDragItem,
    void,
    { isOver: boolean; canDrop: boolean }
  >(() => ({
    accept: SIDEBAR_TAB_DRAG_TYPE,
    drop: (dragItem, monitor) => {
      if (monitor.didDrop()) return;
      props.setLayout((prev) =>
        moveTabToTabset(prev, dragItem.tab, dragItem.sourceTabsetId, props.node.id)
      );
      if (dragItem.tab === "review") {
        props.onReviewSelected();
      }
    },
    canDrop: () => true,
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
      canDrop: monitor.canDrop(),
    }),
  }));

  // Edge drop zones (for creating splits)
  const [{ isOver: isOverTop }, topDrop] = useDrop<TabDragItem, void, { isOver: boolean }>(() => ({
    accept: SIDEBAR_TAB_DRAG_TYPE,
    drop: (dragItem, monitor) => {
      if (monitor.didDrop()) return;
      props.setLayout((prev) =>
        dockTabToEdge(prev, dragItem.tab, dragItem.sourceTabsetId, props.node.id, "top")
      );
      if (dragItem.tab === "review") {
        props.onReviewSelected();
      }
    },
    canDrop: () => true,
    collect: (monitor) => ({
      isOver: monitor.isOver({ shallow: true }),
    }),
  }));

  const [{ isOver: isOverBottom }, bottomDrop] = useDrop<TabDragItem, void, { isOver: boolean }>(
    () => ({
      accept: SIDEBAR_TAB_DRAG_TYPE,
      drop: (dragItem, monitor) => {
        if (monitor.didDrop()) return;
        props.setLayout((prev) =>
          dockTabToEdge(prev, dragItem.tab, dragItem.sourceTabsetId, props.node.id, "bottom")
        );
        if (dragItem.tab === "review") {
          props.onReviewSelected();
        }
      },
      canDrop: () => true,
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
      }),
    })
  );

  const [{ isOver: isOverLeft }, leftDrop] = useDrop<TabDragItem, void, { isOver: boolean }>(
    () => ({
      accept: SIDEBAR_TAB_DRAG_TYPE,
      drop: (dragItem, monitor) => {
        if (monitor.didDrop()) return;
        props.setLayout((prev) =>
          dockTabToEdge(prev, dragItem.tab, dragItem.sourceTabsetId, props.node.id, "left")
        );
        if (dragItem.tab === "review") {
          props.onReviewSelected();
        }
      },
      canDrop: () => true,
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
      }),
    })
  );

  const [{ isOver: isOverRight }, rightDrop] = useDrop<TabDragItem, void, { isOver: boolean }>(
    () => ({
      accept: SIDEBAR_TAB_DRAG_TYPE,
      drop: (dragItem, monitor) => {
        if (monitor.didDrop()) return;
        props.setLayout((prev) =>
          dockTabToEdge(prev, dragItem.tab, dragItem.sourceTabsetId, props.node.id, "right")
        );
        if (dragItem.tab === "review") {
          props.onReviewSelected();
        }
      },
      canDrop: () => true,
      collect: (monitor) => ({
        isOver: monitor.isOver({ shallow: true }),
      }),
    })
  );

  const showDockHints =
    isDraggingSidebarTab &&
    (isOverContent || isOverTop || isOverBottom || isOverLeft || isOverRight);

  const setFocused = () => {
    props.setLayout((prev) => setFocusedTabset(prev, props.node.id));
  };

  const selectTab = (tab: TabType) => {
    props.setLayout((prev) => {
      const withFocus = setFocusedTabset(prev, props.node.id);
      return selectTabInTabset(withFocus, props.node.id, tab);
    });

    if (tab === "review") {
      props.onReviewSelected();
    }
  };

  const items = props.node.tabs.flatMap((tab) => {
    if (tab === "stats" && !props.statsTabEnabled) {
      return [];
    }

    const tabId = `${tabsetBaseId}-tab-${tab}`;
    const panelId = `${tabsetBaseId}-panel-${tab}`;

    const tooltip =
      tab === "costs"
        ? formatKeybind(KEYBINDS.COSTS_TAB)
        : tab === "review"
          ? formatKeybind(KEYBINDS.REVIEW_TAB)
          : tab === "terminal"
            ? formatKeybind(KEYBINDS.TERMINAL_TAB)
            : formatKeybind(KEYBINDS.STATS_TAB);

    const label =
      tab === "costs" ? (
        <>
          Costs
          {props.sessionCost !== null && (
            <span className="text-muted text-[10px]">
              ${props.sessionCost < 0.01 ? "<0.01" : props.sessionCost.toFixed(2)}
            </span>
          )}
        </>
      ) : tab === "review" ? (
        <>
          Review
          {props.reviewStats !== null && props.reviewStats.total > 0 && (
            <span
              className={cn(
                "text-[10px]",
                props.reviewStats.read === props.reviewStats.total ? "text-muted" : "text-muted"
              )}
            >
              {props.reviewStats.read}/{props.reviewStats.total}
            </span>
          )}
        </>
      ) : tab === "stats" ? (
        <>
          Stats
          {props.sessionDuration !== null && (
            <span className="text-muted text-[10px]">
              {formatTabDuration(props.sessionDuration)}
            </span>
          )}
        </>
      ) : (
        <>Terminal</>
      );

    return [
      {
        id: tabId,
        panelId,
        selected: props.node.activeTab === tab,
        onSelect: () => selectTab(tab),
        label,
        tooltip,
        tab,
      },
    ];
  });

  const handleTabReorder = (fromIndex: number, toIndex: number) => {
    props.setLayout((prev) => reorderTabInTabset(prev, props.node.id, fromIndex, toIndex));
  };
  const handleTabDrop = (droppedTab: TabType, sourceTabsetId: string) => {
    props.setLayout((prev) => moveTabToTabset(prev, droppedTab, sourceTabsetId, props.node.id));

    if (droppedTab === "review") {
      props.onReviewSelected();
    }
  };

  const costsPanelId = `${tabsetBaseId}-panel-costs`;
  const reviewPanelId = `${tabsetBaseId}-panel-review`;
  const terminalPanelId = `${tabsetBaseId}-panel-terminal`;
  const statsPanelId = `${tabsetBaseId}-panel-stats`;

  const costsTabId = `${tabsetBaseId}-tab-costs`;
  const reviewTabId = `${tabsetBaseId}-tab-review`;
  const terminalTabId = `${tabsetBaseId}-tab-terminal`;
  const statsTabId = `${tabsetBaseId}-tab-stats`;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onMouseDownCapture={setFocused}>
      <RightSidebarTabStrip
        ariaLabel="Sidebar views"
        items={items}
        tabsetId={props.node.id}
        onTabDrop={handleTabDrop}
        onTabReorder={handleTabReorder}
      />
      <div
        ref={contentDrop}
        className={cn(
          tabsetContentClassName,
          isDraggingSidebarTab &&
            canDropContent &&
            isOverContent &&
            "bg-accent/10 ring-1 ring-accent/50"
        )}
      >
        {/* Edge docking zones - only active while dragging a sidebar tab */}
        {isDraggingSidebarTab && (
          <>
            <div
              ref={topDrop}
              className={cn(
                "absolute inset-x-0 top-0 z-10 h-10 transition-opacity",
                showDockHints ? "opacity-100" : "opacity-0",
                isOverTop ? "bg-accent/20 border-b border-accent" : "bg-accent/5"
              )}
            />
            <div
              ref={bottomDrop}
              className={cn(
                "absolute inset-x-0 bottom-0 z-10 h-10 transition-opacity",
                showDockHints ? "opacity-100" : "opacity-0",
                isOverBottom ? "bg-accent/20 border-t border-accent" : "bg-accent/5"
              )}
            />
            <div
              ref={leftDrop}
              className={cn(
                "absolute inset-y-0 left-0 z-10 w-10 transition-opacity",
                showDockHints ? "opacity-100" : "opacity-0",
                isOverLeft ? "bg-accent/20 border-r border-accent" : "bg-accent/5"
              )}
            />
            <div
              ref={rightDrop}
              className={cn(
                "absolute inset-y-0 right-0 z-10 w-10 transition-opacity",
                showDockHints ? "opacity-100" : "opacity-0",
                isOverRight ? "bg-accent/20 border-l border-accent" : "bg-accent/5"
              )}
            />
          </>
        )}

        {props.node.activeTab === "costs" && (
          <div role="tabpanel" id={costsPanelId} aria-labelledby={costsTabId}>
            <CostsTab workspaceId={props.workspaceId} />
          </div>
        )}

        {props.node.tabs.includes("terminal") && (
          <div
            role="tabpanel"
            id={terminalPanelId}
            aria-labelledby={terminalTabId}
            className="h-full"
            hidden={props.node.activeTab !== "terminal"}
          >
            <TerminalTab
              workspaceId={props.workspaceId}
              visible={props.node.activeTab === "terminal"}
            />
          </div>
        )}

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

        {props.node.activeTab === "review" && (
          <div role="tabpanel" id={reviewPanelId} aria-labelledby={reviewTabId} className="h-full">
            <ReviewPanel
              key={`${props.workspaceId}:${props.node.id}`}
              workspaceId={props.workspaceId}
              workspacePath={props.workspacePath}
              onReviewNote={props.onReviewNote}
              focusTrigger={props.focusTrigger}
              isCreating={props.isCreating}
              onStatsChange={props.onReviewStatsChange}
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
  width,
  onStartResize,
  isResizing = false,
  onReviewNote,
  isCreating = false,
}) => {
  // Trigger for focusing Review panel (preserves hunk selection)
  const [focusTrigger, setFocusTrigger] = React.useState(0);

  // Review stats reported by ReviewPanel
  const [reviewStats, setReviewStats] = React.useState<ReviewStats | null>(null);

  // Manual collapse state (persisted globally)
  const [collapsed, setCollapsed] = usePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false);

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

  const [layoutRaw, setLayoutRaw] = usePersistedState<RightSidebarLayoutState>(
    RIGHT_SIDEBAR_LAYOUT_KEY,
    defaultLayout,
    {
      listener: true,
    }
  );

  const layout = React.useMemo(
    () => parseRightSidebarLayoutState(layoutRaw, initialActiveTab),
    [layoutRaw, initialActiveTab]
  );

  // If the Stats tab feature is disabled, ensure it doesn't linger in persisted layouts.
  React.useEffect(() => {
    if (statsTabEnabled) return;

    setLayoutRaw((prevRaw) => {
      const prev = parseRightSidebarLayoutState(prevRaw, initialActiveTab);
      const hasStats = collectActiveTabs(prev.root).includes("stats");
      if (!hasStats) return prev;
      return removeTabEverywhere(prev, "stats");
    });
  }, [initialActiveTab, setLayoutRaw, statsTabEnabled]);
  // If we ever deserialize an invalid layout (e.g. schema changes), reset to defaults.
  React.useEffect(() => {
    if (!isRightSidebarLayoutState(layoutRaw)) {
      setLayoutRaw(layout);
    }
  }, [layout, layoutRaw, setLayoutRaw]);

  const setLayout = React.useCallback(
    (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => {
      setLayoutRaw((prevRaw) => updater(parseRightSidebarLayoutState(prevRaw, initialActiveTab)));
    },
    [initialActiveTab, setLayoutRaw]
  );

  const focusedActiveTab = React.useMemo(
    () => getFocusedActiveTab(layout, initialActiveTab),
    [initialActiveTab, layout]
  );

  // Mirror current focused tab selection for persistence + AIView boot-time layout flash avoidance.
  const lastPersistedTabRef = React.useRef<TabType | null>(null);
  React.useEffect(() => {
    if (lastPersistedTabRef.current === focusedActiveTab) return;
    lastPersistedTabRef.current = focusedActiveTab;
    updatePersistedState(RIGHT_SIDEBAR_TAB_KEY, focusedActiveTab, "costs");
  }, [focusedActiveTab]);

  // Keyboard shortcuts for tab switching (auto-expands if collapsed)
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.COSTS_TAB)) {
        e.preventDefault();
        setLayout((prev) => selectTabInFocusedTabset(prev, "costs"));
        setCollapsed(false);
      } else if (matchesKeybind(e, KEYBINDS.REVIEW_TAB)) {
        e.preventDefault();
        setLayout((prev) => selectTabInFocusedTabset(prev, "review"));
        setCollapsed(false);
        setFocusTrigger((prev) => prev + 1);
      } else if (matchesKeybind(e, KEYBINDS.TERMINAL_TAB)) {
        e.preventDefault();
        setLayout((prev) => selectTabInFocusedTabset(prev, "terminal"));
        setCollapsed(false);
      } else if (statsTabEnabled && matchesKeybind(e, KEYBINDS.STATS_TAB)) {
        e.preventDefault();
        setLayout((prev) => selectTabInFocusedTabset(prev, "stats"));
        setCollapsed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setLayout, setCollapsed, statsTabEnabled]);

  const usage = useWorkspaceUsage(workspaceId);

  const baseId = `right-sidebar-${workspaceId}`;

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

  const activeTabs = React.useMemo(() => collectActiveTabs(layout.root), [layout.root]);

  const renderLayoutNode = (node: RightSidebarLayoutNode): React.ReactNode => {
    if (node.type === "split") {
      // Our layout uses "horizontal" to mean a horizontal divider (top/bottom panes).
      // react-resizable-panels uses "vertical" for top/bottom.
      const groupDirection = node.direction === "horizontal" ? "vertical" : "horizontal";

      const handleClassName =
        groupDirection === "horizontal"
          ? "w-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-col-resize bg-border-light hover:bg-accent"
          : "h-0.5 flex-shrink-0 z-10 transition-[background] duration-150 cursor-row-resize bg-border-light hover:bg-accent";

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
          <PanelResizeHandle className={handleClassName} />
          <Panel defaultSize={node.sizes[1]} minSize={15} className="flex min-h-0 min-w-0 flex-col">
            {renderLayoutNode(node.children[1])}
          </Panel>
        </PanelGroup>
      );
    }

    return (
      <RightSidebarTabsetNode
        node={node}
        baseId={baseId}
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        isCreating={Boolean(isCreating)}
        focusTrigger={focusTrigger}
        onReviewNote={onReviewNote}
        onReviewSelected={() => setFocusTrigger((prev) => prev + 1)}
        reviewStats={reviewStats}
        statsTabEnabled={statsTabEnabled}
        sessionDuration={sessionDuration}
        onReviewStatsChange={setReviewStats}
        sessionCost={sessionCost}
        setLayout={setLayout}
      />
    );
  };

  // Determine if we should be wide (Review or Terminal visible in any pane)
  const hasWideTab = activeTabs.some((t) => t === "review" || t === "terminal");

  return (
    <DndProvider backend={HTML5Backend}>
      <SidebarContainer
        collapsed={collapsed}
        isResizing={isResizing}
        wide={hasWideTab && !width} // Auto-wide only if not drag-resizing
        customWidth={width} // Drag-resized width from AIView
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
    </DndProvider>
  );
};

// Memoize to prevent re-renders when parent (AIView) re-renders during streaming
// Only re-renders when workspaceId or chatAreaRef changes, or internal state updates
export const RightSidebar = React.memo(RightSidebarComponent);
