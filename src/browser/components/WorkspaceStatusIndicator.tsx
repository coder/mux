import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { ModelDisplay } from "@/browser/components/Messages/ModelDisplay";
import { EmojiIcon } from "@/browser/components/icons/EmojiIcon";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { CircleHelp, ExternalLinkIcon } from "lucide-react";
import { memo } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Button } from "./ui/button";

export const WorkspaceStatusIndicator = memo<{
  workspaceId: string;
  fallbackModel: string;
}>(({ workspaceId, fallbackModel }) => {
  const { canInterrupt, isStarting, awaitingUserQuestion, currentModel, agentStatus } =
    useWorkspaceSidebarState(workspaceId);
  const { workspaceMetadata } = useWorkspaceContext();

  const metadata = workspaceMetadata.get(workspaceId);
  const isCreating = metadata?.status === "creating";

  // Show prompt when ask_user_question is pending - make it prominent
  if (awaitingUserQuestion) {
    return (
      <div className="bg-plan-mode-alpha text-plan-mode-light flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs">
        <CircleHelp aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-medium">Mux has a few questions</span>
      </div>
    );
  }

  if (agentStatus) {
    return (
      <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
        {agentStatus.emoji && <EmojiIcon emoji={agentStatus.emoji} className="h-3 w-3 shrink-0" />}
        <span className="min-w-0 truncate">{agentStatus.message}</span>
        {agentStatus.url && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:size-3"
              >
                <a href={agentStatus.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLinkIcon />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent align="center">{agentStatus.url}</TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  const isWorking = (canInterrupt || isStarting || isCreating) && !awaitingUserQuestion;
  if (!isWorking) {
    return null;
  }

  const modelToShow = canInterrupt ? (currentModel ?? fallbackModel) : fallbackModel;

  return (
    <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
      {modelToShow ? (
        <>
          <span className="min-w-0 truncate">
            <ModelDisplay modelString={modelToShow} showTooltip={false} />
          </span>
          <span className="shrink-0 opacity-70">- streaming...</span>
        </>
      ) : (
        <span className="min-w-0 truncate">Assistant - streaming...</span>
      )}
    </div>
  );
});
WorkspaceStatusIndicator.displayName = "WorkspaceStatusIndicator";
