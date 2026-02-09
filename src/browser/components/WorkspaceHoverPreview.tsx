import { cn } from "@/common/lib/utils";
import { RuntimeBadge } from "./RuntimeBadge";
import { BranchSelector } from "./BranchSelector";
import { WorkspaceLinks } from "./WorkspaceLinks";
import type { RuntimeConfig } from "@/common/types/runtime";

interface WorkspaceHoverPreviewProps {
  workspaceId: string;
  projectName: string;
  workspaceName: string;
  namedWorkspacePath: string;
  runtimeConfig?: RuntimeConfig;
  isWorking: boolean;
  className?: string;
}

/**
 * Dense workspace info preview for hover cards.
 * Shows runtime badge, project name, branch selector, git status, and PR link.
 */
export function WorkspaceHoverPreview({
  workspaceId,
  projectName,
  workspaceName,
  namedWorkspacePath,
  runtimeConfig,
  isWorking,
  className,
}: WorkspaceHoverPreviewProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-[11px]", className)}>
      <RuntimeBadge
        runtimeConfig={runtimeConfig}
        isWorking={isWorking}
        workspacePath={namedWorkspacePath}
        workspaceName={workspaceName}
        tooltipSide="bottom"
      />
      <span className="min-w-0 truncate font-mono text-[11px]">{projectName}</span>
      <div className="flex items-center gap-1">
        <BranchSelector workspaceId={workspaceId} workspaceName={workspaceName} />
        <WorkspaceLinks workspaceId={workspaceId} />
      </div>
    </div>
  );
}
