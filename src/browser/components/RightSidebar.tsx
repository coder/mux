import React from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import { useProviderOptions } from "@/browser/hooks/useProviderOptions";
import { useResizeObserver } from "@/browser/hooks/useResizeObserver";
import { useAutoCompactionSettings } from "@/browser/hooks/useAutoCompactionSettings";
import { CostsTab } from "./RightSidebar/CostsTab";
import { VerticalTokenMeter } from "./RightSidebar/VerticalTokenMeter";
import { ReviewPanel } from "./RightSidebar/CodeReview/ReviewPanel";
import { calculateTokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";
import { matchesKeybind, KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { TooltipWrapper, Tooltip } from "./Tooltip";
import { cn } from "@/common/lib/utils";

interface SidebarContainerProps {
  collapsed: boolean;
  wide?: boolean;
  /** Custom width from drag-resize (takes precedence over collapsed/wide) */
  customWidth?: number;
  children: React.ReactNode;
  role: string;
  "aria-label": string;
}

/**
 * SidebarContainer - Main sidebar wrapper with dynamic width
 *
 * Width priority (first match wins):
 * 1. collapsed (20px) - Shows vertical token meter only
 * 2. customWidth - From drag-resize on Review tab
 * 3. wide - Auto-calculated max width for Review tab (when not resizing)
 * 4. default (300px) - Costs/Tools tabs
 */
const SidebarContainer: React.FC<SidebarContainerProps> = ({
  collapsed,
  wide,
  customWidth,
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
        customWidth ? "" : "transition-[width] duration-200",
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

type TabType = "costs" | "review";

export type { TabType };

interface RightSidebarProps {
  workspaceId: string;
  workspacePath: string;
  chatAreaRef: React.RefObject<HTMLDivElement>;
  /** Callback fired when tab selection changes (used for resize logic in AIView) */
  onTabChange?: (tab: TabType) => void;
  /** Custom width in pixels (overrides default widths when Review tab is resizable) */
  width?: number;
  /** Drag start handler for resize (Review tab only) */
  onStartResize?: (e: React.MouseEvent) => void;
  /** Whether currently resizing */
  isResizing?: boolean;
  /** Callback when user adds a review note from Code Review tab */
  onReviewNote?: (note: string) => void;
  /** Workspace is still being created (git operations in progress) */
  isCreating?: boolean;
}

const RightSidebarComponent: React.FC<RightSidebarProps> = ({
  workspaceId,
  workspacePath,
  chatAreaRef,
  onTabChange,
  width,
  onStartResize,
  isResizing = false,
  onReviewNote,
  isCreating = false,
}) => {
  // Global tab preference (not per-workspace)
  const [selectedTab, setSelectedTab] = usePersistedState<TabType>("right-sidebar-tab", "costs");

  // Trigger for focusing Review panel (preserves hunk selection)
  const [focusTrigger, setFocusTrigger] = React.useState(0);

  // Notify parent (AIView) of tab changes so it can enable/disable resize functionality
  React.useEffect(() => {
    onTabChange?.(selectedTab);
  }, [selectedTab, onTabChange]);

  // Keyboard shortcuts for tab switching
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.COSTS_TAB)) {
        e.preventDefault();
        setSelectedTab("costs");
      } else if (matchesKeybind(e, KEYBINDS.REVIEW_TAB)) {
        e.preventDefault();
        setSelectedTab("review");
        setFocusTrigger((prev) => prev + 1);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setSelectedTab, selectedTab]);

  const usage = useWorkspaceUsage(workspaceId);
  const { options } = useProviderOptions();
  const use1M = options.anthropic?.use1MContext ?? false;
  const chatAreaSize = useResizeObserver(chatAreaRef);

  const baseId = `right-sidebar-${workspaceId}`;
  const costsTabId = `${baseId}-tab-costs`;
  const reviewTabId = `${baseId}-tab-review`;
  const costsPanelId = `${baseId}-panel-costs`;
  const reviewPanelId = `${baseId}-panel-review`;

  // Use lastContextUsage for context window display (last step = actual context size)
  const lastUsage = usage?.liveUsage ?? usage?.lastContextUsage;
  const model = lastUsage?.model ?? null;

  // Auto-compaction settings: threshold per-model
  const { threshold: autoCompactThreshold, setThreshold: setAutoCompactThreshold } =
    useAutoCompactionSettings(workspaceId, model);

  // Memoize vertical meter data calculation to prevent unnecessary re-renders
  const verticalMeterData = React.useMemo(() => {
    return lastUsage
      ? calculateTokenMeterData(lastUsage, model ?? "unknown", use1M, true)
      : { segments: [], totalTokens: 0, totalPercentage: 0 };
  }, [lastUsage, model, use1M]);

  // Calculate if we should show collapsed view with hysteresis
  // Strategy: Observe ChatArea width directly (independent of sidebar width)
  // - ChatArea has min-width: 750px and flex: 1
  // - Use hysteresis to prevent oscillation:
  //   * Collapse when chatAreaWidth <= 800px (tight space)
  //   * Expand when chatAreaWidth >= 1100px (lots of space)
  //   * Between 800-1100: maintain current state (dead zone)
  const COLLAPSE_THRESHOLD = 800; // Collapse below this
  const EXPAND_THRESHOLD = 1100; // Expand above this
  const chatAreaWidth = chatAreaSize?.width ?? 1000; // Default to large to avoid flash

  // Persist collapsed state globally (not per-workspace) since chat area width is shared
  // This prevents animation flash when switching workspaces - sidebar maintains its state
  const [showCollapsed, setShowCollapsed] = usePersistedState<boolean>(
    "right-sidebar:collapsed",
    false
  );

  React.useEffect(() => {
    // Never collapse when Review tab is active - code review needs space
    if (selectedTab === "review") {
      if (showCollapsed) {
        setShowCollapsed(false);
      }
      return;
    }

    // Normal hysteresis for Costs/Tools tabs
    if (chatAreaWidth <= COLLAPSE_THRESHOLD) {
      setShowCollapsed(true);
    } else if (chatAreaWidth >= EXPAND_THRESHOLD) {
      setShowCollapsed(false);
    }
    // Between thresholds: maintain current state (no change)
  }, [chatAreaWidth, selectedTab, showCollapsed, setShowCollapsed]);

  // Single render point for VerticalTokenMeter
  // Shows when: (1) collapsed, OR (2) Review tab is active
  const showMeter = showCollapsed || selectedTab === "review";
  const autoCompactionProps = React.useMemo(
    () => ({
      threshold: autoCompactThreshold,
      setThreshold: setAutoCompactThreshold,
    }),
    [autoCompactThreshold, setAutoCompactThreshold]
  );
  const verticalMeter = showMeter ? (
    <VerticalTokenMeter data={verticalMeterData} autoCompaction={autoCompactionProps} />
  ) : null;

  return (
    <SidebarContainer
      collapsed={showCollapsed}
      wide={selectedTab === "review" && !width} // Auto-wide only if not drag-resizing
      customWidth={width} // Drag-resized width from AIView (Review tab only)
      role="complementary"
      aria-label="Workspace insights"
    >
      {/* Full view when not collapsed */}
      <div className={cn("flex-row h-full", !showCollapsed ? "flex" : "hidden")}>
        {/* Render meter when Review tab is active */}
        {selectedTab === "review" && (
          <div className="bg-sidebar border-border-light flex w-5 shrink-0 flex-col border-r">
            {verticalMeter}
          </div>
        )}

        {/* Render resize handle to right of meter when Review tab is active */}
        {selectedTab === "review" && onStartResize && (
          <div
            className={cn(
              "w-1 flex-shrink-0 z-10 transition-[background] duration-150",
              "bg-border-light cursor-col-resize hover:bg-accent",
              isResizing && "bg-accent"
            )}
            onMouseDown={(e) => onStartResize(e as unknown as React.MouseEvent)}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="bg-background-secondary border-border flex border-b [&>*]:flex-1"
            role="tablist"
            aria-label="Metadata views"
          >
            <TooltipWrapper inline>
              <button
                className={cn(
                  "w-full py-2.5 px-[15px] border-none border-solid cursor-pointer font-primary text-[13px] font-medium transition-all duration-200",
                  selectedTab === "costs"
                    ? "bg-separator border-b-2 border-b-plan-mode text-[var(--color-sidebar-tab-active)]"
                    : "bg-transparent text-secondary border-b-2 border-b-transparent hover:bg-background-secondary hover:text-foreground"
                )}
                onClick={() => setSelectedTab("costs")}
                id={costsTabId}
                role="tab"
                type="button"
                aria-selected={selectedTab === "costs"}
                aria-controls={costsPanelId}
              >
                Costs
              </button>
              <Tooltip className="tooltip" position="bottom" align="center">
                {formatKeybind(KEYBINDS.COSTS_TAB)}
              </Tooltip>
            </TooltipWrapper>
            <TooltipWrapper inline>
              <button
                className={cn(
                  "w-full py-2.5 px-[15px] border-none border-solid cursor-pointer font-primary text-[13px] font-medium transition-all duration-200",
                  selectedTab === "review"
                    ? "bg-separator border-b-2 border-b-plan-mode text-[var(--color-sidebar-tab-active)]"
                    : "bg-transparent text-secondary border-b-2 border-b-transparent hover:bg-background-secondary hover:text-foreground"
                )}
                onClick={() => setSelectedTab("review")}
                id={reviewTabId}
                role="tab"
                type="button"
                aria-selected={selectedTab === "review"}
                aria-controls={reviewPanelId}
              >
                Review
              </button>
              <Tooltip className="tooltip" position="bottom" align="center">
                {formatKeybind(KEYBINDS.REVIEW_TAB)}
              </Tooltip>
            </TooltipWrapper>
          </div>
          <div
            className={cn("flex-1 overflow-y-auto", selectedTab === "review" ? "p-0" : "p-[15px]")}
          >
            {selectedTab === "costs" && (
              <div role="tabpanel" id={costsPanelId} aria-labelledby={costsTabId}>
                <CostsTab workspaceId={workspaceId} />
              </div>
            )}
            {selectedTab === "review" && (
              <div
                role="tabpanel"
                id={reviewPanelId}
                aria-labelledby={reviewTabId}
                className="h-full"
              >
                <ReviewPanel
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                  onReviewNote={onReviewNote}
                  focusTrigger={focusTrigger}
                  isCreating={isCreating}
                />
              </div>
            )}
          </div>
        </div>
      </div>
      {/* Render meter in collapsed view when sidebar is collapsed */}
      <div className={cn("h-full", showCollapsed ? "flex" : "hidden")}>{verticalMeter}</div>
    </SidebarContainer>
  );
};

// Memoize to prevent re-renders when parent (AIView) re-renders during streaming
// Only re-renders when workspaceId or chatAreaRef changes, or internal state updates
export const RightSidebar = React.memo(RightSidebarComponent);
