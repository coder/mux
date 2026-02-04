import React from "react";
import { Globe } from "lucide-react";
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
  remoteServerId?: string;
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
  remoteServerId,
  runtimeConfig,
  isWorking,
  className,
}: WorkspaceHoverPreviewProps) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-[11px]", className)}>
      {remoteServerId && (
        <span className="text-muted-foreground inline-flex shrink-0" aria-hidden="true">
          <Globe className="h-3 w-3" />
        </span>
      )}
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
