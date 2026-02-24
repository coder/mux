/**
 * ReviewControls - Consolidated one-line control bar for review panel
 */

import React from "react";
import { ArrowLeft, Maximize2 } from "lucide-react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";
import { KEYBINDS, formatKeybind } from "@/browser/utils/ui/keybinds";
import { STORAGE_KEYS, WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { ReviewFilters, ReviewStats, ReviewSortOrder } from "@/common/types/review";
import type { LastRefreshInfo } from "@/browser/utils/RefreshController";
import { RefreshButton } from "./RefreshButton";
import { BaseSelectorPopover } from "./BaseSelectorPopover";

const SORT_OPTIONS: Array<{ value: ReviewSortOrder; label: string }> = [
  { value: "file-order", label: "File order" },
  { value: "last-edit", label: "Last edit" },
];

interface ReviewControlsProps {
  filters: ReviewFilters;
  stats: ReviewStats;
  onFiltersChange: (filters: ReviewFilters | ((prev: ReviewFilters) => ReviewFilters)) => void;
  onDiffBaseInteraction?: (value: string) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
  /** Whether refresh is blocked (e.g., user composing review note) */
  isRefreshBlocked?: boolean;
  projectPath: string;
  /** Debug info about last refresh */
  lastRefreshInfo?: LastRefreshInfo | null;
  /** Whether immersive review mode is active */
  isImmersive?: boolean;
  /** Toggle immersive review mode */
  onToggleImmersive?: () => void;
}

export const ReviewControls: React.FC<ReviewControlsProps> = ({
  filters,
  stats,
  onFiltersChange,
  onDiffBaseInteraction,
  onRefresh,
  isLoading = false,
  isRefreshBlocked = false,
  projectPath,
  lastRefreshInfo,
  isImmersive = false,
  onToggleImmersive,
}) => {
  // Per-project default base (used for new workspaces in this project)
  const [defaultBase, setDefaultBase] = usePersistedState<string>(
    STORAGE_KEYS.reviewDefaultBase(projectPath),
    WORKSPACE_DEFAULTS.reviewBase,
    { listener: true }
  );
  const { startSequence } = useTutorial();

  // Show the immersive review tutorial the first time the review panel is visible
  React.useEffect(() => {
    // Small delay to ensure the button is rendered and measurable
    const timer = setTimeout(() => startSequence("review"), 500);
    return () => clearTimeout(timer);
  }, [startSequence]);

  // Use callback form to avoid stale closure issues with filters prop
  const handleBaseChange = (value: string) => {
    onDiffBaseInteraction?.(value);
    onFiltersChange((prev) => ({ ...prev, diffBase: value }));
  };

  const handleUncommittedToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    onFiltersChange((prev) => ({ ...prev, includeUncommitted: checked }));
  };

  const handleShowReadToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    onFiltersChange((prev) => ({ ...prev, showReadHunks: checked }));
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const sortOrder = e.target.value as ReviewSortOrder;
    onFiltersChange((prev) => ({ ...prev, sortOrder }));
  };

  const handleSetDefault = () => {
    setDefaultBase(filters.diffBase);
  };

  // Show "Set Default" button if current base is different from default
  const showSetDefault = filters.diffBase !== defaultBase;

  return (
    <div className="border-border-light flex flex-wrap items-center gap-2 border-b px-2 py-1 text-[11px]">
      {onRefresh && (
        <RefreshButton
          onClick={onRefresh}
          isLoading={isLoading}
          disabled={isRefreshBlocked}
          lastRefreshInfo={lastRefreshInfo}
        />
      )}

      <div
        className="text-muted flex items-center gap-1 whitespace-nowrap"
        data-testid="review-base-selector"
      >
        <span>Base:</span>
        <BaseSelectorPopover
          value={filters.diffBase}
          onChange={handleBaseChange}
          data-testid="review-base-value"
        />
        {showSetDefault && (
          <button
            onClick={handleSetDefault}
            className="text-dim font-primary hover:text-muted cursor-pointer border-none bg-transparent p-0 text-[10px] whitespace-nowrap transition-colors duration-150"
            title="Set as default base"
          >
            ★
          </button>
        )}
      </div>

      <div className="bg-border-light h-3 w-px" />

      <label className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1 whitespace-nowrap">
        <span>Uncommitted:</span>
        <input
          type="checkbox"
          checked={filters.includeUncommitted}
          onChange={handleUncommittedToggle}
          className="h-3 w-3 cursor-pointer"
        />
      </label>

      <div className="bg-border-light h-3 w-px" />

      <label className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1 whitespace-nowrap">
        <span>Read:</span>
        <input
          type="checkbox"
          checked={filters.showReadHunks}
          onChange={handleShowReadToggle}
          className="h-3 w-3 cursor-pointer"
        />
      </label>

      <div className="bg-border-light h-3 w-px" />

      <label className="text-muted flex items-center gap-1 whitespace-nowrap">
        <span>Sort:</span>
        <select
          aria-label="Sort hunks by"
          value={filters.sortOrder}
          onChange={handleSortChange}
          className="text-muted-light hover:bg-hover hover:text-foreground cursor-pointer rounded-sm bg-transparent px-1 py-0.5 font-mono transition-colors focus:outline-none"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      {onToggleImmersive && (
        <>
          <div className="bg-border-light ml-auto h-3 w-px" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onToggleImmersive}
                className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-[11px] transition-colors duration-150"
                aria-label={isImmersive ? "Exit immersive review" : "Enter immersive review"}
                data-tutorial="immersive-review"
              >
                {isImmersive ? (
                  <ArrowLeft aria-hidden="true" className="h-3 w-3" />
                ) : (
                  <Maximize2 aria-hidden="true" className="h-3 w-3" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isImmersive ? "Exit" : "Enter"} immersive review (
              {formatKeybind(KEYBINDS.TOGGLE_REVIEW_IMMERSIVE)})
            </TooltipContent>
          </Tooltip>
        </>
      )}

      <span className={`text-dim whitespace-nowrap ${onToggleImmersive ? "" : "ml-auto"}`}>
        {stats.read}/{stats.total}
      </span>
    </div>
  );
};
