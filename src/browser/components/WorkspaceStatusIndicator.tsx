import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { ExternalLinkIcon } from "lucide-react";
import { memo } from "react";
import { Tooltip, TooltipWrapper } from "./Tooltip";
import { Button } from "./ui/button";

export const WorkspaceStatusIndicator = memo<{ workspaceId: string }>(({ workspaceId }) => {
  const { agentStatus } = useWorkspaceSidebarState(workspaceId);

  if (!agentStatus) {
    return null;
  }

  return (
    <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
      {agentStatus.emoji && (
        // Emojis do not visually center well, so we offset them
        // slightly with negative margin.
        <span className="-mt-0.5 shrink-0 text-[10px]">{agentStatus.emoji}</span>
      )}
      <span className="min-w-0 truncate">{agentStatus.message}</span>
      {agentStatus.url && (
        <TooltipWrapper inline>
          <Button
            variant="ghost"
            size="icon"
            className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:size-3"
          >
            <a href={agentStatus.url} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon />
            </a>
          </Button>

          <Tooltip className="tooltip" align="center">
            {agentStatus.url}
          </Tooltip>
        </TooltipWrapper>
      )}
    </div>
  );
});
WorkspaceStatusIndicator.displayName = "WorkspaceStatusIndicator";
