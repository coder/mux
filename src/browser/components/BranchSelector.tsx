import React, { useState, useCallback, useEffect } from "react";
import { GitBranch, Loader2, Check, Copy } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { useAPI } from "@/browser/contexts/API";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { BranchPickerPopover } from "./BranchPickerPopover";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { invalidateGitStatus } from "@/browser/stores/GitStatusStore";

interface BranchSelectorProps {
  workspaceId: string;
  /** Fallback name to display if not in a git repo (workspace name) */
  workspaceName: string;
  className?: string;
}

// Max branches to fetch
const MAX_LOCAL_BRANCHES = 100;
const MAX_REMOTE_BRANCHES = 50;

interface RemoteState {
  branches: string[];
  isLoading: boolean;
  fetched: boolean;
  truncated: boolean;
}

/**
 * Displays the current git branch with a searchable popover for switching.
 * If not in a git repo, shows the workspace name without interactive features.
 * Remotes appear as expandable groups that lazy-load their branches.
 */
export function BranchSelector({ workspaceId, workspaceName, className }: BranchSelectorProps) {
  const { api } = useAPI();
  // null = not yet determined, false = not a git repo, string = current branch
  const [currentBranch, setCurrentBranch] = useState<string | null | false>(null);
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [localBranchesTruncated, setLocalBranchesTruncated] = useState(false);
  const [remotes, setRemotes] = useState<string[]>([]);
  const [remoteStates, setRemoteStates] = useState<Record<string, RemoteState>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copyToClipboard } = useCopyToClipboard();

  // Fetch current branch on mount to detect if we're in a git repo
  useEffect(() => {
    if (!api) return;

    void (async () => {
      try {
        const result = await api.workspace.executeBash({
          workspaceId,
          script: `git rev-parse --abbrev-ref HEAD 2>/dev/null`,
          options: { timeout_secs: 5 },
        });

        if (result.success && result.data.success && result.data.output?.trim()) {
          setCurrentBranch(result.data.output.trim());
        } else {
          // Not a git repo or git command failed
          setCurrentBranch(false);
        }
      } catch {
        setCurrentBranch(false);
      }
    })();
  }, [api, workspaceId]);

  const fetchLocalBranches = useCallback(async () => {
    if (!api || currentBranch === false) return;

    setIsLoading(true);

    try {
      // Fetch one extra to detect truncation
      const [branchResult, remoteResult] = await Promise.all([
        api.workspace.executeBash({
          workspaceId,
          script: `git branch --sort=-committerdate --format='%(refname:short)' 2>/dev/null | head -${MAX_LOCAL_BRANCHES + 1}`,
          options: { timeout_secs: 5 },
        }),
        api.workspace.executeBash({
          workspaceId,
          script: `git remote 2>/dev/null`,
          options: { timeout_secs: 5 },
        }),
      ]);

      if (branchResult.success && branchResult.data.success && branchResult.data.output) {
        const branchList = branchResult.data.output
          .split("\n")
          .map((b) => b.trim())
          .filter((b) => b.length > 0);
        if (branchList.length > 0) {
          const truncated = branchList.length > MAX_LOCAL_BRANCHES;
          setLocalBranches(truncated ? branchList.slice(0, MAX_LOCAL_BRANCHES) : branchList);
          setLocalBranchesTruncated(truncated);
        }
      }

      if (remoteResult.success && remoteResult.data.success && remoteResult.data.output) {
        const remoteList = remoteResult.data.output
          .split("\n")
          .map((r) => r.trim())
          .filter((r) => r.length > 0);
        setRemotes(remoteList);
      }
    } catch {
      // Silently fail
    } finally {
      setIsLoading(false);
    }
  }, [api, workspaceId, currentBranch]);

  const fetchRemoteBranches = useCallback(
    async (remote: string) => {
      if (!api || remoteStates[remote]?.fetched) return;

      setRemoteStates((prev) => ({
        ...prev,
        [remote]: { branches: [], isLoading: true, fetched: false, truncated: false },
      }));

      try {
        // Fetch one extra to detect truncation
        const result = await api.workspace.executeBash({
          workspaceId,
          script: `git branch -r --list '${remote}/*' --sort=-committerdate --format='%(refname:short)' 2>/dev/null | head -${MAX_REMOTE_BRANCHES + 1}`,
          options: { timeout_secs: 5 },
        });

        if (result.success && result.data.success && result.data.output) {
          const branches = result.data.output
            .split("\n")
            .map((b) => b.trim())
            .filter((b) => b.length > 0);

          const branchNames = branches
            .map((b) => b.replace(`${remote}/`, ""))
            .filter((b) => b.length > 0 && b !== "HEAD");

          const truncated = branchNames.length > MAX_REMOTE_BRANCHES;
          setRemoteStates((prev) => ({
            ...prev,
            [remote]: {
              branches: truncated ? branchNames.slice(0, MAX_REMOTE_BRANCHES) : branchNames,
              isLoading: false,
              fetched: true,
              truncated,
            },
          }));
        } else {
          setRemoteStates((prev) => ({
            ...prev,
            [remote]: { branches: [], isLoading: false, fetched: true, truncated: false },
          }));
        }
      } catch {
        setRemoteStates((prev) => ({
          ...prev,
          [remote]: { branches: [], isLoading: false, fetched: true, truncated: false },
        }));
      }
    },
    [api, workspaceId, remoteStates]
  );

  const switchBranch = useCallback(
    async (targetBranch: string, isRemote = false) => {
      if (!api) return;

      const checkoutTarget = isRemote ? targetBranch.replace(/^[^/]+\//, "") : targetBranch;

      if (checkoutTarget === currentBranch) {
        return;
      }

      setIsSwitching(true);
      setError(null);
      // Invalidate git status immediately to prevent stale data flash
      invalidateGitStatus(workspaceId);

      try {
        const result = await api.workspace.executeBash({
          workspaceId,
          script: `git checkout ${checkoutTarget} 2>&1`,
          options: { timeout_secs: 30 },
        });

        if (!result.success) {
          setError(result.error ?? "Checkout failed");
          // Re-fetch status since checkout failed (restore accurate state)
          invalidateGitStatus(workspaceId);
        } else if (!result.data.success) {
          const errorMsg = result.data.output?.trim() ?? result.data.error ?? "Checkout failed";
          setError(errorMsg);
          // Re-fetch status since checkout failed
          invalidateGitStatus(workspaceId);
        } else {
          // Update current branch on successful checkout
          setCurrentBranch(checkoutTarget);
          // Refresh git status with new branch state
          invalidateGitStatus(workspaceId);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Checkout failed");
      } finally {
        setIsSwitching(false);
      }
    },
    [api, workspaceId, currentBranch]
  );

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [error]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof currentBranch === "string") {
      void copyToClipboard(currentBranch);
    }
  };

  // Display name: actual git branch if available, otherwise workspace name
  const displayName = typeof currentBranch === "string" ? currentBranch : workspaceName;

  const remoteGroups = remotes.map((remote) => {
    const state = remoteStates[remote];
    return {
      remote,
      branches: state?.branches ?? [],
      isLoading: state?.isLoading ?? false,
      fetched: state?.fetched ?? false,
      truncated: state?.truncated ?? false,
    };
  });

  // Non-git repo: just show workspace name, no interactive features
  if (currentBranch === false) {
    return (
      <div className={cn("group flex items-center gap-0.5", className)}>
        <div className="text-muted-light flex max-w-[180px] min-w-0 items-center gap-1 px-1 py-0.5 font-mono text-[11px]">
          <span className="truncate">{workspaceName}</span>
        </div>
      </div>
    );
  }

  // Still loading git status - use same layout as loaded state to prevent shift
  if (currentBranch === null) {
    return (
      <div className={cn("group flex items-center gap-0.5", className)}>
        <div className="text-muted-light flex max-w-[180px] min-w-0 items-center gap-1 px-1 py-0.5 font-mono text-[11px]">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin opacity-70" />
          <span className="truncate">{workspaceName}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("group flex items-center gap-0.5", className)}>
      <BranchPickerPopover
        trigger={
          <button
            type="button"
            disabled={isSwitching}
            className={cn(
              "text-muted-light hover:bg-hover hover:text-foreground flex min-w-0 max-w-[180px] items-center gap-1 rounded-sm px-1 py-0.5 font-mono text-[11px] transition-colors",
              isSwitching && "opacity-50"
            )}
          >
            {isSwitching ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <>
                <GitBranch className="h-3 w-3 shrink-0 opacity-70" />
                <span className="truncate">{displayName}</span>
              </>
            )}
          </button>
        }
        isLoading={isLoading}
        localBranches={localBranches}
        localBranchesTruncated={localBranchesTruncated}
        remotes={remoteGroups}
        selection={{ kind: "local", branch: currentBranch }}
        onOpen={fetchLocalBranches}
        onClose={() => {
          setRemoteStates({});
        }}
        onExpandRemote={(remote) => fetchRemoteBranches(remote)}
        onSelectLocalBranch={(branch) => switchBranch(branch)}
        onSelectRemoteBranch={(_remote, branch) => switchBranch(branch, true)}
      />

      {/* Copy button - only show on hover */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className="text-muted hover:text-foreground flex h-3.5 w-3.5 shrink-0 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
            aria-label="Copy branch name"
          >
            {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{copied ? "Copied!" : "Copy branch name"}</TooltipContent>
      </Tooltip>

      {error && <span className="text-danger-soft truncate text-[10px]">{error}</span>}
    </div>
  );
}
