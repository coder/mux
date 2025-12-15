/**
 * ReviewControls - Consolidated one-line control bar for review panel
 */

import React, { useState } from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import type { ReviewFilters, ReviewStats } from "@/common/types/review";
import { RefreshButton } from "./RefreshButton";
import { UntrackedStatus } from "./UntrackedStatus";

interface ReviewControlsProps {
  filters: ReviewFilters;
  stats: ReviewStats;
  onFiltersChange: (filters: ReviewFilters) => void;
  onRefresh?: () => void;
  isLoading?: boolean;
  workspaceId: string;
  workspacePath: string;
  /** If set, show an auto-refresh countdown (e.g., for origin/* bases). */
  autoRefreshSecondsRemaining?: number | null;
  refreshTrigger?: number;
}

export const ReviewControls: React.FC<ReviewControlsProps> = ({
  filters,
  stats,
  onFiltersChange,
  onRefresh,
  isLoading = false,
  workspaceId,
  workspacePath,
  autoRefreshSecondsRemaining,
  refreshTrigger,
}) => {
  // Local state for input value - only commit on blur/Enter
  const [inputValue, setInputValue] = useState(filters.diffBase);

  // Global default base (used for new workspaces)
  const [defaultBase, setDefaultBase] = usePersistedState<string>("review-default-base", "HEAD");

  // Sync input with external changes (e.g., workspace change)
  React.useEffect(() => {
    setInputValue(filters.diffBase);
  }, [filters.diffBase]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const commitValue = () => {
    const trimmed = inputValue.trim();
    if (trimmed && trimmed !== filters.diffBase) {
      onFiltersChange({ ...filters, diffBase: trimmed });
    }
  };

  const handleBaseBlur = () => {
    commitValue();
  };

  const handleBaseKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      commitValue();
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      // Revert to committed value
      setInputValue(filters.diffBase);
      e.currentTarget.blur();
    }
  };

  const handleUncommittedToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, includeUncommitted: e.target.checked });
  };

  const handleShowReadToggle = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, showReadHunks: e.target.checked });
  };

  const handleSetDefault = () => {
    setDefaultBase(filters.diffBase);
  };

  // Show "Set Default" button if current base is different from default
  const showSetDefault = filters.diffBase !== defaultBase;

  return (
    <div className="bg-separator border-border-light flex flex-wrap items-center gap-3 border-b px-3 py-2 text-[11px]">
      {autoRefreshSecondsRemaining != null && (
        <span className="text-muted whitespace-nowrap tabular-nums">
          Refresh in: {String(autoRefreshSecondsRemaining).padStart(2, "\u2007")}s
        </span>
      )}
      {onRefresh && <RefreshButton onClick={onRefresh} isLoading={isLoading} />}
      <label className="text-muted font-medium whitespace-nowrap">Base:</label>
      <input
        type="text"
        list="base-suggestions"
        value={inputValue}
        onChange={handleInputChange}
        onBlur={handleBaseBlur}
        onKeyDown={handleBaseKeyDown}
        placeholder="HEAD, main, etc."
        className="bg-dark text-foreground border-border-medium hover:border-accent focus:border-accent placeholder:text-dim w-36 rounded border px-2 py-1 font-mono text-[11px] transition-[border-color] duration-200 focus:outline-none"
      />
      <datalist id="base-suggestions">
        <option value="HEAD" />
        <option value="--staged" />
        <option value="main" />
        <option value="origin/main" />
        <option value="HEAD~1" />
        <option value="HEAD~2" />
        <option value="develop" />
        <option value="origin/develop" />
      </datalist>

      {showSetDefault && (
        <button
          onClick={handleSetDefault}
          className="text-muted font-primary hover:bg-white-overlay-light hover:text-foreground cursor-pointer rounded border-none bg-transparent px-2 py-0.5 text-[11px] whitespace-nowrap transition-all duration-200"
        >
          Set Default
        </button>
      )}

      <label className="text-foreground flex cursor-pointer items-center gap-1.5 text-[11px] whitespace-nowrap hover:text-[var(--color-hover-foreground)] [&_input[type='checkbox']]:cursor-pointer">
        <input
          type="checkbox"
          checked={filters.includeUncommitted}
          onChange={handleUncommittedToggle}
        />
        Uncommitted
      </label>

      <label className="text-foreground flex cursor-pointer items-center gap-1.5 text-[11px] whitespace-nowrap hover:text-[var(--color-hover-foreground)] [&_input[type='checkbox']]:cursor-pointer">
        <input type="checkbox" checked={filters.showReadHunks} onChange={handleShowReadToggle} />
        Show read
      </label>

      <UntrackedStatus
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        refreshTrigger={refreshTrigger}
        onRefresh={onRefresh}
      />

      <div className="bg-border-light h-4 w-px" />

      <div className="text-muted rounded border border-transparent bg-transparent px-2.5 py-1 text-[11px] font-medium whitespace-nowrap">
        {stats.read} read / {stats.total} total
      </div>
    </div>
  );
};
