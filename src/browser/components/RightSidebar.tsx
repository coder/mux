import React from "react";
import { RIGHT_SIDEBAR_TAB_KEY, RIGHT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useWorkspaceUsage } from "@/browser/stores/WorkspaceStore";
import { useResizeObserver } from "@/browser/hooks/useResizeObserver";
import { CostsTab } from "./RightSidebar/CostsTab";
import { ReviewPanel } from "./RightSidebar/CodeReview/ReviewPanel";
import { sumUsageHistory, type ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";
import { matchesKeybind, KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { cn } from "@/common/lib/utils";
import type { ReviewNoteData } from "@/common/types/review";

/** Stats reported by ReviewPanel for tab display */
export interface ReviewStats {
  total: number;
  read: number;
}

interface SidebarContainerProps {
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
 * 1. customWidth - From drag-resize (persisted per-tab)
 * 2. wide - Auto-calculated max width for Review tab (when not drag-resizing)
 * 3. default (300px) - Costs tab when no customWidth saved
 */
const SidebarContainer: React.FC<SidebarContainerProps> = ({
  wide,
  customWidth,
  isResizing,
  children,
  role,
  "aria-label": ariaLabel,
}) => {
  const width = customWidth
    ? `${customWidth}px`
    : wide
      ? "min(1200px, calc(100vw - 400px))"
      : "300px";

  return (
    <div
      className={cn(
        "bg-sidebar border-l border-border-light flex flex-col overflow-hidden flex-shrink-0",
        !isResizing && "transition-[width] duration-200",
        // Mobile: full width
        "max-md:border-l-0 max-md:border-t max-md:border-border-light max-md:w-full max-md:relative max-md:max-h-[50vh]"
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

const RightSidebarComponent: React.FC<RightSidebarProps> = ({
  workspaceId,
  workspacePath,
  chatAreaRef,
  width,
  onStartResize,
  isResizing = false,
  onReviewNote,
  isCreating = false,
}) => {
  // Global tab preference (not per-workspace)
  const [selectedTab, setSelectedTab] = usePersistedState<TabType>(RIGHT_SIDEBAR_TAB_KEY, "costs");

  // Trigger for focusing Review panel (preserves hunk selection)
  const [focusTrigger, setFocusTrigger] = React.useState(0);

  // Review stats reported by ReviewPanel
  const [reviewStats, setReviewStats] = React.useState<ReviewStats | null>(null);

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
  }, [setSelectedTab]);

  const usage = useWorkspaceUsage(workspaceId);
  const chatAreaSize = useResizeObserver(chatAreaRef);

  const baseId = `right-sidebar-${workspaceId}`;
  const costsTabId = `${baseId}-tab-costs`;
  const reviewTabId = `${baseId}-tab-review`;
  const costsPanelId = `${baseId}-panel-costs`;
  const reviewPanelId = `${baseId}-panel-review`;

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

  // Auto-hide sidebar on small screens using hysteresis to prevent oscillation
  // - Observe ChatArea width directly (independent of sidebar width)
  // - ChatArea has min-width and flex: 1
  // - Collapse when chatAreaWidth <= 800px (tight space)
  // - Expand when chatAreaWidth >= 1100px (lots of space)
  // - Between 800-1100: maintain current state (dead zone)
  const COLLAPSE_THRESHOLD = 800;
  const EXPAND_THRESHOLD = 1100;
  const chatAreaWidth = chatAreaSize?.width ?? 1000; // Default to large to avoid flash

  // Persist collapsed state globally (not per-workspace) since chat area width is shared
  const [isHidden, setIsHidden] = usePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false);

  React.useEffect(() => {
    // Never hide when Review tab is active - code review needs space
    if (selectedTab === "review") {
      if (isHidden) {
        setIsHidden(false);
      }
      return;
    }

    // If sidebar is custom-resized wider than default, don't auto-hide
    // (would cause oscillation between hidden and wide states)
    if (width !== undefined && width > 300) {
      if (isHidden) {
        setIsHidden(false);
      }
      return;
    }

    // Normal hysteresis for Costs tab
    if (chatAreaWidth <= COLLAPSE_THRESHOLD) {
      setIsHidden(true);
    } else if (chatAreaWidth >= EXPAND_THRESHOLD) {
      setIsHidden(false);
    }
    // Between thresholds: maintain current state (no change)
  }, [chatAreaWidth, selectedTab, isHidden, setIsHidden, width]);

  // Fully hide sidebar on small screens (context usage now shown in ChatInput)
  if (isHidden) {
    return null;
  }

  return (
    <SidebarContainer
      wide={selectedTab === "review" && !width} // Auto-wide only if not drag-resizing
      customWidth={width} // Per-tab resized width from AIView
      isResizing={isResizing}
      role="complementary"
      aria-label="Workspace insights"
    >
      <div className="flex h-full flex-row">
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

        <div className="flex min-w-0 flex-1 flex-col">
          <div
            className="border-border-light flex gap-1 border-b px-2 py-1.5"
            role="tablist"
            aria-label="Metadata views"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-all duration-150 flex items-baseline gap-1.5",
                    selectedTab === "costs"
                      ? "bg-hover text-foreground"
                      : "bg-transparent text-muted hover:bg-hover/50 hover:text-foreground"
                  )}
                  onClick={() => setSelectedTab("costs")}
                  id={costsTabId}
                  role="tab"
                  type="button"
                  aria-selected={selectedTab === "costs"}
                  aria-controls={costsPanelId}
                >
                  Costs
                  {sessionCost !== null && (
                    <span className="text-muted text-[10px]">
                      ${sessionCost < 0.01 ? "<0.01" : sessionCost.toFixed(2)}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {formatKeybind(KEYBINDS.COSTS_TAB)}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-all duration-150 flex items-baseline gap-1.5",
                    selectedTab === "review"
                      ? "bg-hover text-foreground"
                      : "bg-transparent text-muted hover:bg-hover/50 hover:text-foreground"
                  )}
                  onClick={() => setSelectedTab("review")}
                  id={reviewTabId}
                  role="tab"
                  type="button"
                  aria-selected={selectedTab === "review"}
                  aria-controls={reviewPanelId}
                >
                  Review
                  {reviewStats !== null && reviewStats.total > 0 && (
                    <span
                      className={cn(
                        "text-[10px]",
                        reviewStats.read === reviewStats.total
                          ? "text-muted" // All read - dimmed
                          : "text-muted"
                      )}
                    >
                      {reviewStats.read}/{reviewStats.total}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="center">
                {formatKeybind(KEYBINDS.REVIEW_TAB)}
              </TooltipContent>
            </Tooltip>
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
                  key={workspaceId}
                  workspaceId={workspaceId}
                  workspacePath={workspacePath}
                  onReviewNote={onReviewNote}
                  focusTrigger={focusTrigger}
                  isCreating={isCreating}
                  onStatsChange={setReviewStats}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </SidebarContainer>
  );
};

// Memoize to prevent re-renders when parent (AIView) re-renders during streaming
// Only re-renders when workspaceId or chatAreaRef changes, or internal state updates
export const RightSidebar = React.memo(RightSidebarComponent);
