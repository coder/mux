import React, { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Globe, Loader2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export type BranchPickerSelection =
  | { kind: "local"; branch: string }
  | { kind: "remote"; remote: string; branch: string };

export interface BranchPickerRemoteGroup {
  remote: string;
  branches: string[];
  isLoading?: boolean;
  fetched?: boolean;
  truncated?: boolean;
}

interface BranchPickerPopoverProps {
  trigger: React.ReactNode;
  disabled?: boolean;

  isLoading?: boolean;
  localBranches: string[];
  localBranchesTruncated?: boolean;

  remotes: BranchPickerRemoteGroup[];

  selection: BranchPickerSelection | null;

  onOpen?: () => void | Promise<void>;
  onClose?: () => void;
  onSelectLocalBranch: (branch: string) => void | Promise<void>;
  onSelectRemoteBranch: (remote: string, branch: string) => void | Promise<void>;
  onExpandRemote?: (remote: string) => void | Promise<void>;
}

export function BranchPickerPopover(props: BranchPickerPopoverProps) {
  const { onClose, onExpandRemote, onOpen, onSelectLocalBranch, onSelectRemoteBranch } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedRemotes, setExpandedRemotes] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    void onOpen?.();
  }, [isOpen, onOpen]);

  useEffect(() => {
    if (!isOpen) {
      onClose?.();
      setSearch("");
      setExpandedRemotes(new Set());
      return;
    }

    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [isOpen, onClose]);

  const searchLower = search.toLowerCase();

  const filteredLocalBranches = useMemo(
    () => props.localBranches.filter((b) => b.toLowerCase().includes(searchLower)),
    [props.localBranches, searchLower]
  );

  const remoteGroups = useMemo(() => {
    return props.remotes.map((remote) => ({
      remote: remote.remote,
      branches: remote.branches,
      isLoading: remote.isLoading ?? false,
      fetched: remote.fetched ?? true,
      truncated: remote.truncated ?? false,
    }));
  }, [props.remotes]);

  const getFilteredRemoteBranches = (remote: string) => {
    const group = remoteGroups.find((g) => g.remote === remote);
    if (!group) return [];
    return group.branches.filter((b) => b.toLowerCase().includes(searchLower));
  };

  const hasMatchingRemoteBranches = remoteGroups.some((group) => {
    if (!group.fetched) return true;
    return getFilteredRemoteBranches(group.remote).length > 0;
  });

  const toggleRemote = (remote: string) => {
    setExpandedRemotes((prev) => {
      const next = new Set(prev);
      if (next.has(remote)) {
        next.delete(remote);
      } else {
        next.add(remote);
        void onExpandRemote?.(remote);
      }
      return next;
    });
  };

  const handleSelectLocalBranch = (branch: string) => {
    setIsOpen(false);
    void onSelectLocalBranch(branch);
  };

  const handleSelectRemoteBranch = (remote: string, branch: string) => {
    setIsOpen(false);
    void onSelectRemoteBranch(remote, branch);
  };

  const isRemoteBranchSelected = (remote: string, branch: string) => {
    const selection = props.selection;
    if (!selection) return false;

    if (selection.kind === "remote") {
      return selection.remote === remote && selection.branch === branch;
    }

    // Useful for workspaces where selection is the local branch, but we still want the
    // remote list to indicate which remote branch corresponds to the current branch.
    return selection.branch === branch;
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>{props.trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-0">
        {/* Search input */}
        <div className="border-border border-b px-2 py-1.5">
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search branches..."
            className="text-foreground placeholder:text-muted w-full bg-transparent font-mono text-[11px] outline-none"
          />
        </div>

        <div className="max-h-[280px] overflow-y-auto p-1">
          {/* Remotes as expandable groups */}
          {remoteGroups.length > 0 && hasMatchingRemoteBranches && (
            <>
              {remoteGroups.map((group) => {
                const isExpanded = expandedRemotes.has(group.remote);
                const filteredRemoteBranches = getFilteredRemoteBranches(group.remote);

                // Hide remote if fetched and no matching branches
                if (group.fetched && filteredRemoteBranches.length === 0 && search) {
                  return null;
                }

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
                        {group.isLoading ? (
                          <div className="text-muted flex items-center justify-center py-2">
                            <Loader2 className="h-3 w-3 animate-spin" />
                          </div>
                        ) : filteredRemoteBranches.length === 0 ? (
                          <div className="text-muted py-1.5 pl-2 text-[10px]">No branches</div>
                        ) : (
                          <>
                            {filteredRemoteBranches.map((branch) => (
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
                            {group.truncated && !search && (
                              <div className="text-muted px-2 py-1 text-[10px] italic">
                                +more branches (use search)
                              </div>
                            )}
                          </>
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
          {props.isLoading && props.localBranches.length <= 1 ? (
            <div className="text-muted flex items-center justify-center py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
          ) : filteredLocalBranches.length === 0 ? (
            <div className="text-muted py-2 text-center text-[10px]">No matching branches</div>
          ) : (
            <>
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
                      props.selection?.kind === "local" && props.selection.branch === branch
                        ? "opacity-100"
                        : "opacity-0"
                    )}
                  />
                  <span className="truncate">{branch}</span>
                </button>
              ))}
              {props.localBranchesTruncated && !search && (
                <div className="text-muted px-2 py-1 text-[10px] italic">
                  +more branches (use search)
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
