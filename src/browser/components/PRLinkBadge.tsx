/**
 * PR link badge component for displaying GitHub PR status in header.
 */

import {
  ExternalLink,
  GitPullRequest,
  Loader2,
  Check,
  X,
  AlertCircle,
  CircleDot,
} from "lucide-react";
import type { GitHubPRLinkWithStatus } from "@/common/types/links";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Button } from "./ui/button";
import { cn } from "@/common/lib/utils";

interface PRLinkBadgeProps {
  prLink: GitHubPRLinkWithStatus;
  onRefresh?: () => void;
}

/**
 * Get status color class based on PR merge state
 */
function getStatusColorClass(prLink: GitHubPRLinkWithStatus): string {
  if (prLink.loading) return "text-muted";
  if (prLink.error) return "text-danger-soft";
  if (!prLink.status) return "text-muted";

  const { state, mergeable, mergeStateStatus, isDraft, hasFailedChecks, hasPendingChecks } =
    prLink.status;

  if (state === "MERGED") return "text-purple-500";
  if (state === "CLOSED") return "text-danger-soft";
  if (isDraft || mergeStateStatus === "DRAFT") return "text-muted";

  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") return "text-danger-soft";

  if (mergeStateStatus === "CLEAN") return "text-success";
  if (mergeStateStatus === "BEHIND") return "text-warning";

  // Prefer check rollup when available; fall back to mergeStateStatus.
  if (hasFailedChecks || mergeStateStatus === "UNSTABLE") return "text-danger-soft";
  if (hasPendingChecks) return "text-warning";

  if (mergeStateStatus === "BLOCKED" || mergeStateStatus === "HAS_HOOKS") {
    return "text-warning";
  }

  return "text-muted";
}

/**
 * Get status icon based on PR state
 */
function StatusIcon({ prLink }: { prLink: GitHubPRLinkWithStatus }) {
  if (prLink.loading) {
    return <Loader2 className="h-3 w-3 animate-spin" />;
  }
  if (prLink.error) {
    return <AlertCircle className="h-3 w-3" />;
  }
  if (!prLink.status) {
    return <GitPullRequest className="h-3 w-3" />;
  }

  const { state, mergeable, mergeStateStatus, isDraft, hasFailedChecks, hasPendingChecks } =
    prLink.status;

  if (state === "MERGED") {
    return <Check className="h-3 w-3" />;
  }
  if (state === "CLOSED") {
    return <X className="h-3 w-3" />;
  }

  if (isDraft || mergeStateStatus === "DRAFT") {
    return <GitPullRequest className="h-3 w-3" />;
  }

  if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
    return <X className="h-3 w-3" />;
  }

  if (mergeStateStatus === "CLEAN") {
    return <Check className="h-3 w-3" />;
  }

  // Prefer check rollup when available; fall back to mergeStateStatus.
  if (hasFailedChecks || mergeStateStatus === "UNSTABLE") {
    return <X className="h-3 w-3" />;
  }
  if (hasPendingChecks || mergeStateStatus === "BLOCKED") {
    return <CircleDot className="h-3 w-3" />;
  }

  return <GitPullRequest className="h-3 w-3" />;
}

/**
 * Format PR tooltip content
 */
function getTooltipContent(prLink: GitHubPRLinkWithStatus): string {
  if (prLink.loading) return "Loading PR status...";
  if (prLink.error) return `Error: ${prLink.error}`;
  if (!prLink.status) return `PR #${prLink.number}`;

  const {
    title,
    state,
    mergeable,
    mergeStateStatus,
    isDraft,
    hasFailedChecks,
    hasPendingChecks,
    headRefName,
    baseRefName,
  } = prLink.status;

  const lines = [title || `PR #${prLink.number}`];

  if (isDraft) {
    lines.push("Draft PR");
  } else if (state === "MERGED") {
    lines.push("Merged");
  } else if (state === "CLOSED") {
    lines.push("Closed");
  } else {
    if (mergeable === "CONFLICTING" || mergeStateStatus === "DIRTY") {
      lines.push("Has merge conflicts");
    } else if (mergeStateStatus === "BEHIND") {
      lines.push("Behind base branch");
    } else if (mergeStateStatus === "CLEAN") {
      lines.push("Ready to merge");
    } else if (hasFailedChecks || mergeStateStatus === "UNSTABLE") {
      lines.push("Checks failing");
    } else if (hasPendingChecks) {
      lines.push("Checks pending");
    } else if (mergeStateStatus === "BLOCKED" || mergeStateStatus === "HAS_HOOKS") {
      lines.push("Merge blocked");
    } else {
      lines.push("Open");
    }
  }

  lines.push(`${headRefName} → ${baseRefName}`);

  return lines.join("\n");
}

export function PRLinkBadge({ prLink }: PRLinkBadgeProps) {
  const colorClass = getStatusColorClass(prLink);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("h-6 gap-1 px-2 text-xs font-medium", colorClass)}
          asChild
        >
          <a href={prLink.url} target="_blank" rel="noopener noreferrer">
            <StatusIcon prLink={prLink} />
            <span>#{prLink.number}</span>
            <ExternalLink className="h-3 w-3 opacity-50" />
          </a>
        </Button>
      </TooltipTrigger>
      <TooltipContent align="center" className="whitespace-pre-line">
        {getTooltipContent(prLink)}
      </TooltipContent>
    </Tooltip>
  );
}
