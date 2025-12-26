/**
 * ReviewControls - Consolidated one-line control bar for review panel
 */

import React from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import type { ReviewFilters, ReviewStats, ReviewSortOrder } from "@/common/types/review";
import type { LastRefreshInfo } from "@/browser/utils/RefreshController";
import { RefreshButton } from "./RefreshButton";
import { UntrackedStatus } from "./UntrackedStatus";
import { BaseSelectorPopover } from "./BaseSelectorPopover";

const SORT_OPTIONS: Array<{ value: ReviewSortOrder; label: string }> = [
  { value: "file-order", label: "File order" },
  { value: "last-edit", label: "Last edit" },
];

interface ReviewControlsProps {
  filters: ReviewFilters;
  stats: ReviewStats;
  onFiltersChange: (filters: ReviewFilters) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
  workspaceId: string;
  workspacePath: string;
  refreshTrigger?: number;
  /** Debug info about last refresh */
  lastRefreshInfo?: LastRefreshInfo | null;
}

export const ReviewControls: React.FC<ReviewControlsProps> = ({
  filters,
  stats,
  onFiltersChange,
  onRefresh,
  isLoading = false,
  workspaceId,
  workspacePath,
  refreshTrigger,
  lastRefreshInfo,
}) => {
  // Global default base (used for new workspaces)
  const [defaultBase, setDefaultBase] = usePersistedState<string>("review-default-base", "HEAD");

  const handleBaseChange = (value: string) => {
    onFiltersChange({ ...filters, diffBase: value });
  };

  const handleUncommittedToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, includeUncommitted: e.target.checked });
  };

  const handleShowReadToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, showReadHunks: e.target.checked });
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    onFiltersChange({ ...filters, sortOrder: e.target.value as ReviewSortOrder });
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
          lastRefreshInfo={lastRefreshInfo}
        />
      )}

      <div className="text-muted flex items-center gap-1 whitespace-nowrap">
        <span>Base:</span>
        <BaseSelectorPopover value={filters.diffBase} onChange={handleBaseChange} />
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

      <div className="ml-auto flex items-center gap-2">
        <UntrackedStatus
          workspaceId={workspaceId}
          workspacePath={workspacePath}
          refreshTrigger={refreshTrigger}
          onRefresh={onRefresh}
        />

        <span className="text-dim whitespace-nowrap">
          {stats.read}/{stats.total}
        </span>
      </div>
    </div>
  );
};
