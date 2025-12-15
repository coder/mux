import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Globe, Loader2, Wand2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Popover, PopoverContent, PopoverAnchor } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { ExistingBranchSelection } from "@/common/types/branchSelection";
import type { BranchListResult } from "@/common/orpc/types";

interface RemoteGroup {
  remote: string;
  branches: string[];
  truncated?: boolean;
}

export interface BranchNameInputProps {
  /** Current input value (branch name) */
  value: string;
  /** Callback when value changes */
  onChange: (value: string) => void;
  /** Whether auto-generation is enabled */
  autoGenerate: boolean;
  /** Toggle auto-generation */
  onAutoGenerateChange: (enabled: boolean) => void;
  /** Whether name is being generated */
  isGenerating: boolean;
  /** Validation error message */
  error?: string | null;

  /** Local branches for autocomplete */
  localBranches: string[];
  /** Remote branch groups for autocomplete */
  remoteBranchGroups: BranchListResult["remoteBranchGroups"];
  /** Whether branches have finished loading */
  branchesLoaded: boolean;

  /** Currently selected existing branch (if any) */
  selectedExistingBranch: ExistingBranchSelection | null;
  /** Callback when an existing branch is selected from dropdown */
  onSelectExistingBranch: (selection: ExistingBranchSelection | null) => void;

  /** Input placeholder */
  placeholder?: string;
  /** Whether input is disabled */
  disabled?: boolean;
}

/**
 * Unified branch name input with autocomplete.
 *
 * - Shows matching branches as user types (combobox-style)
 * - Selecting a branch → uses existing branch
 * - Typing a non-matching name → creates new branch
 * - Auto-generation via magic wand when input is empty
 */
export function BranchNameInput(props: BranchNameInputProps) {
  const {
    value,
    onChange,
    autoGenerate,
    onAutoGenerateChange,
    isGenerating,
    error,
    localBranches,
    remoteBranchGroups,
    branchesLoaded,
    selectedExistingBranch,
    onSelectExistingBranch,
    placeholder = "workspace-name",
    disabled = false,
  } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(new Set());

  // Convert remote branch groups to internal format
  const remoteGroups: RemoteGroup[] = useMemo(() => {
    return remoteBranchGroups.map((group) => ({
      remote: group.remote,
      branches: group.branches,
      truncated: group.truncated,
    }));
  }, [remoteBranchGroups]);

  // Filter branches based on input
  const searchLower = value.toLowerCase();

  const filteredLocalBranches = useMemo(
    () => localBranches.filter((b) => b.toLowerCase().includes(searchLower)),
    [localBranches, searchLower]
  );

  const getFilteredRemoteBranches = useCallback(
    (remote: string) => {
      const group = remoteGroups.find((g) => g.remote === remote);
      if (!group) return [];
      return group.branches.filter((b) => b.toLowerCase().includes(searchLower));
    },
    [remoteGroups, searchLower]
  );

  const hasMatchingBranches =
    filteredLocalBranches.length > 0 ||
    remoteGroups.some((g) => getFilteredRemoteBranches(g.remote).length > 0);

  // Check if input exactly matches an existing branch
  const exactLocalMatch = localBranches.find((b) => b.toLowerCase() === searchLower);
  const exactRemoteMatch = remoteGroups.find((g) =>
    g.branches.some((b) => b.toLowerCase() === searchLower)
  );

  // Open popover when there's input and matching branches
  useEffect(() => {
    if (value.length > 0 && hasMatchingBranches && !disabled) {
      setIsOpen(true);
    } else if (value.length === 0 || !hasMatchingBranches) {
      setIsOpen(false);
    }
  }, [value, hasMatchingBranches, disabled]);

  // Handle input focus - disable auto-generate so user can edit
  const handleFocus = useCallback(() => {
    if (autoGenerate) {
      onAutoGenerateChange(false);
    }
  }, [autoGenerate, onAutoGenerateChange]);

  // Handle input change
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      onChange(newValue);
      // Clear existing branch selection when user types
      if (selectedExistingBranch) {
        onSelectExistingBranch(null);
      }
    },
    [onChange, selectedExistingBranch, onSelectExistingBranch]
  );

  // Handle selecting a local branch
  const handleSelectLocalBranch = useCallback(
    (branch: string) => {
      onChange(branch);
      onSelectExistingBranch({ kind: "local", branch });
      setIsOpen(false);
      inputRef.current?.blur();
    },
    [onChange, onSelectExistingBranch]
  );

  // Handle selecting a remote branch
  const handleSelectRemoteBranch = useCallback(
    (remote: string, branch: string) => {
      onChange(branch);
      onSelectExistingBranch({ kind: "remote", remote, branch });
      setIsOpen(false);
      inputRef.current?.blur();
    },
    [onChange, onSelectExistingBranch]
  );

  // Handle input blur - check if we should auto-select an exact match
  const handleBlur = useCallback(() => {
    // Small delay to allow click events on dropdown items to fire first
    setTimeout(() => {
      // If input exactly matches a local branch, auto-select it
      if (exactLocalMatch && !selectedExistingBranch) {
        onSelectExistingBranch({ kind: "local", branch: exactLocalMatch });
      }
      setIsOpen(false);
    }, 150);
  }, [exactLocalMatch, selectedExistingBranch, onSelectExistingBranch]);

  // Handle keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        inputRef.current?.blur();
      } else if (e.key === "Enter") {
        // If exact match exists, select it
        if (exactLocalMatch) {
          handleSelectLocalBranch(exactLocalMatch);
        } else if (exactRemoteMatch) {
          const branch = exactRemoteMatch.branches.find((b) => b.toLowerCase() === searchLower);
          if (branch) {
            handleSelectRemoteBranch(exactRemoteMatch.remote, branch);
          }
        } else {
          // No match - close popover and use as new branch name
          setIsOpen(false);
        }
      }
    },
    [
      exactLocalMatch,
      exactRemoteMatch,
      searchLower,
      handleSelectLocalBranch,
      handleSelectRemoteBranch,
    ]
  );

  // Toggle remote expansion
  const toggleRemote = useCallback((remote: string) => {
    setExpandedRemotes((prev) => {
      const next = new Set(prev);
      if (next.has(remote)) {
        next.delete(remote);
      } else {
        next.add(remote);
      }
      return next;
    });
  }, []);

  // Toggle auto-generation via wand button
  const handleWandClick = useCallback(() => {
    onAutoGenerateChange(!autoGenerate);
  }, [autoGenerate, onAutoGenerateChange]);

  // Check if a branch is selected
  const isLocalBranchSelected = (branch: string) =>
    selectedExistingBranch?.kind === "local" && selectedExistingBranch.branch === branch;

  const isRemoteBranchSelected = (remote: string, branch: string) =>
    selectedExistingBranch?.kind === "remote" &&
    selectedExistingBranch.remote === remote &&
    selectedExistingBranch.branch === branch;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <div className="relative inline-grid items-center">
        {/* Hidden sizer span - determines width based on content */}
        <span className="invisible col-start-1 row-start-1 pr-7 text-lg font-semibold whitespace-pre">
          {value || placeholder}
        </span>

        <PopoverAnchor asChild>
          <div className="col-start-1 row-start-1 flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <input
                  ref={inputRef}
                  type="text"
                  size={1}
                  value={value}
                  onChange={handleChange}
                  onFocus={handleFocus}
                  onBlur={handleBlur}
                  onKeyDown={handleKeyDown}
                  placeholder={isGenerating ? "Generating..." : placeholder}
                  disabled={disabled}
                  className={cn(
                    "min-w-0 bg-transparent border-border-medium focus:border-accent h-7 w-full rounded-md border border-transparent text-lg font-semibold focus:border focus:bg-bg-dark focus:outline-none disabled:opacity-50",
                    autoGenerate ? "text-muted" : "text-foreground",
                    error && "border-red-500",
                    selectedExistingBranch && "text-accent"
                  )}
                />
              </TooltipTrigger>
              <TooltipContent align="start" className="max-w-64">
                {selectedExistingBranch
                  ? `Using existing branch "${selectedExistingBranch.branch}"${selectedExistingBranch.kind === "remote" ? ` from ${selectedExistingBranch.remote}` : ""}`
                  : "Type to search existing branches or enter a new branch name"}
              </TooltipContent>
            </Tooltip>
          </div>
        </PopoverAnchor>

        {/* Magic wand / loading indicator */}
        <div className="absolute inset-y-0 right-0 flex items-center pr-2">
          {isGenerating ? (
            <Loader2 className="text-accent h-3.5 w-3.5 animate-spin" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleWandClick}
                  disabled={disabled}
                  className="flex h-full items-center disabled:opacity-50"
                  aria-label={autoGenerate ? "Disable auto-naming" : "Enable auto-naming"}
                >
                  <Wand2
                    className={cn(
                      "h-3.5 w-3.5 transition-colors",
                      autoGenerate
                        ? "text-accent"
                        : "text-muted-foreground opacity-50 hover:opacity-75"
                    )}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent align="center">
                {autoGenerate ? "Auto-naming enabled" : "Click to enable auto-naming"}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Branch suggestions dropdown */}
      <PopoverContent
        align="start"
        className="w-[280px] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="max-h-[280px] overflow-y-auto p-1">
          {/* Loading state */}
          {!branchesLoaded && (
            <div className="text-muted flex items-center justify-center py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
          )}

          {/* Remote branches as expandable groups */}
          {branchesLoaded && remoteGroups.length > 0 && (
            <>
              {remoteGroups.map((group) => {
                const isExpanded = expandedRemotes.has(group.remote);
                const filteredBranches = getFilteredRemoteBranches(group.remote);

                if (filteredBranches.length === 0) return null;

                return (
                  <div key={group.remote}>
                    <button
                      type="button"
                      onClick={() => toggleRemote(group.remote)}
                      className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                    >
                      <ChevronRight
                        className={cn(
                          "text-muted h-3 w-3 shrink-0 transition-transform",
                          isExpanded && "rotate-90"
                        )}
                      />
                      <Globe className="text-muted h-3 w-3 shrink-0" />
                      <span>{group.remote}</span>
                    </button>

                    {isExpanded && (
                      <div className="ml-3">
                        {filteredBranches.map((branch) => (
                          <button
                            key={`${group.remote}/${branch}`}
                            type="button"
                            onClick={() => handleSelectRemoteBranch(group.remote, branch)}
                            className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                          >
                            <Check
                              className={cn(
                                "h-3 w-3 shrink-0",
                                isRemoteBranchSelected(group.remote, branch)
                                  ? "opacity-100"
                                  : "opacity-0"
                              )}
                            />
                            <span className="truncate">{branch}</span>
                          </button>
                        ))}
                        {group.truncated && value.length < 2 && (
                          <div className="text-muted px-2 py-1 text-[10px] italic">
                            +more branches (keep typing)
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              {filteredLocalBranches.length > 0 && <div className="bg-border my-1 h-px" />}
            </>
          )}

          {/* Local branches */}
          {branchesLoaded && filteredLocalBranches.length > 0 && (
            <>
              <div className="text-muted px-2 py-1 text-[10px] font-medium">Local branches</div>
              {filteredLocalBranches.map((branch) => (
                <button
                  key={branch}
                  type="button"
                  onClick={() => handleSelectLocalBranch(branch)}
                  className="hover:bg-hover flex w-full items-center gap-1.5 rounded-sm px-2 py-1 font-mono text-[11px]"
                >
                  <Check
                    className={cn(
                      "h-3 w-3 shrink-0",
                      isLocalBranchSelected(branch) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{branch}</span>
                </button>
              ))}
            </>
          )}

          {/* No matches - show hint */}
          {branchesLoaded && !hasMatchingBranches && value.length > 0 && (
            <div className="text-muted px-2 py-2 text-center text-[11px]">
              Press Enter to create new branch
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
