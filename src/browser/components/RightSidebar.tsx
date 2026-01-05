import React from "react";
import {
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  RIGHT_SIDEBAR_TAB_KEY,
  getRightSidebarLayoutKey,
} from "@/common/constants/storage";
import { readPersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
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
  addTabToFocusedTabset,
  collectAllTabs,
  dockTabToEdge,
  getDefaultRightSidebarLayoutState,
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
  getTabName,
  type TabDragData,
} from "./RightSidebar/RightSidebarTabStrip";
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
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";

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
  /** Custom width from drag-resize (unified across all tabs) */
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
 * 2. customWidth - From drag-resize (unified width from AIView)
 * 3. default (400px) - Fallback when no custom width set
 */
const SidebarContainer: React.FC<SidebarContainerProps> = ({
  collapsed,
  customWidth,
  isResizing,
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
    props.setLayout((prev) => {
      const withFocus = setFocusedTabset(prev, props.node.id);
      return selectTabInTabset(withFocus, props.node.id, tab);
    });
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

  // Tab reorder and drop are now handled centrally in DndContext's onDragEnd
  const handleTabDrop = (droppedTab: TabType, sourceTabsetId: string) => {
    props.setLayout((prev) => moveTabToTabset(prev, droppedTab, sourceTabsetId, props.node.id));
  };

  const costsPanelId = `${tabsetBaseId}-panel-costs`;
  const reviewPanelId = `${tabsetBaseId}-panel-review`;
  const terminalPanelId = `${tabsetBaseId}-panel-terminal`;
  const statsPanelId = `${tabsetBaseId}-panel-stats`;

  const costsTabId = `${tabsetBaseId}-tab-costs`;
  const reviewTabId = `${tabsetBaseId}-tab-review`;
  const terminalTabId = `${tabsetBaseId}-tab-terminal`;
  const statsTabId = `${tabsetBaseId}-tab-stats`;

  // Generate sortable IDs for tabs in this tabset
  const sortableIds = items.map((item) => `${props.node.id}:${item.tab}`);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onMouseDownCapture={setFocused}>
      <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
        <RightSidebarTabStrip
          ariaLabel="Sidebar views"
          items={items}
          tabsetId={props.node.id}
          onTabDrop={handleTabDrop}
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
              projectPath={props.projectPath}
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
  projectPath,
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
        // Add stats tab to the focused tabset
        return addTabToFocusedTabset(prev, "stats");
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

  const setLayout = React.useCallback(
    (updater: (prev: RightSidebarLayoutState) => RightSidebarLayoutState) => {
      if (isSidebarTabDragInProgressRef.current) {
        const base =
          layoutDraftRef.current ?? parseRightSidebarLayoutState(layoutRaw, initialActiveTab);
        const next = updater(base);
        layoutDraftRef.current = next;
        setLayoutDraft(next);
        return;
      }

      setLayoutRaw((prevRaw) => updater(parseRightSidebarLayoutState(prevRaw, initialActiveTab)));
    },
    [initialActiveTab, layoutRaw, setLayoutRaw]
  );

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

  // @dnd-kit state for tracking active drag
  const [activeDragData, setActiveDragData] = React.useState<TabDragData | null>(null);

  // Configure sensors with distance threshold for click vs drag disambiguation
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
      />
    );
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <SidebarContainer
        collapsed={collapsed}
        isResizing={isResizing}
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
