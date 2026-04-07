import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { ModelDisplay } from "@/browser/features/Messages/ModelDisplay";
import { EmojiIcon } from "@/browser/components/icons/EmojiIcon/EmojiIcon";
import {
  getWorkspaceStreamingStatusPhase,
  useWorkspaceStreamingStatusPhase,
} from "@/browser/hooks/useWorkspaceStreamingStatusPhase";
import { CircleHelp, ExternalLinkIcon, Loader2 } from "lucide-react";
import { memo } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../Tooltip/Tooltip";

export const WorkspaceStatusIndicator = memo<{
  workspaceId: string;
  fallbackModel: string;
  /** When true the workspace is still being provisioned (show "starting…"). Passed as
   *  a prop so this component doesn't need to subscribe to the full WorkspaceContext. */
  isCreating?: boolean;
}>(({ workspaceId, fallbackModel, isCreating }) => {
  const {
    canInterrupt,
    isStarting,
    awaitingUserQuestion,
    currentModel,
    pendingStreamModel,
    agentStatus,
  } = useWorkspaceSidebarState(workspaceId);

  const phase = getWorkspaceStreamingStatusPhase({
    canInterrupt,
    isStarting,
    isCreating,
  });
  const { displayPhase, shouldCollapsePhaseSlot } = useWorkspaceStreamingStatusPhase(phase);

  // Show prompt when ask_user_question is pending - make it prominent
  if (awaitingUserQuestion) {
    return (
      <div className="bg-plan-mode-alpha text-plan-mode-light flex min-w-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs">
        <CircleHelp aria-hidden="true" className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate font-medium">Mux has a few questions</span>
      </div>
    );
  }

  // Todo-derived status can outlive the stream that produced it. Once the turn is idle,
  // keep refresh-style status icons static so unfinished work does not look actively running.
  const agentStatusSpinOverride = displayPhase !== null ? undefined : false;

  if (agentStatus) {
    return (
      <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
        {agentStatus.emoji && (
          <EmojiIcon
            emoji={agentStatus.emoji}
            spin={agentStatusSpinOverride}
            className="h-3 w-3 shrink-0"
          />
        )}
        <span className="min-w-0 truncate">{agentStatus.message}</span>
        {agentStatus.url && (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* Plain <a> instead of Button to keep the icon compact.
                  !min-h-0 !min-w-0 override the global 44px mobile touch-target
                  rule (globals.css) that forces all <a>/<button> to min 44×44px
                  on pointer:coarse — this inline icon doesn't need a full tap target.
                  stopPropagation prevents the parent workspace-select and DnD
                  handlers from swallowing the tap. */}
              <a
                href={agentStatus.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-4 !min-h-0 w-4 !min-w-0 shrink-0 items-center justify-center [&_svg]:size-3"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <ExternalLinkIcon />
              </a>
            </TooltipTrigger>
            <TooltipContent align="center">{agentStatus.url}</TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  }

  if (!displayPhase) {
    return null;
  }

  const modelToShow =
    displayPhase === "starting"
      ? (pendingStreamModel ?? fallbackModel)
      : (currentModel ?? pendingStreamModel ?? fallbackModel);
  const suffix = displayPhase === "starting" ? "- starting..." : "- streaming...";

  if (displayPhase === "streaming" && !shouldCollapsePhaseSlot) {
    return (
      <div className="text-muted flex min-w-0 items-center gap-1.5 text-xs">
        {modelToShow ? (
          <>
            <span className="min-w-0 truncate">
              <ModelDisplay modelString={modelToShow} showTooltip={false} />
            </span>
            <span className="shrink-0 opacity-70">{suffix}</span>
          </>
        ) : (
          <span className="min-w-0 truncate">Assistant - streaming...</span>
        )}
      </div>
    );
  }

  return (
    <div className="text-muted flex min-w-0 items-center text-xs">
      {/* Keep the old steady-state layout, but hold the spinner slot just long enough to
          animate the start -> stream handoff instead of flashing the label left. */}
      {(displayPhase === "starting" || shouldCollapsePhaseSlot) && (
        <span
          className={
            displayPhase === "starting"
              ? "mr-1.5 inline-flex w-3 shrink-0 overflow-hidden opacity-100"
              : "mr-0 inline-flex w-0 shrink-0 overflow-hidden opacity-0 transition-[margin,width,opacity] duration-150 ease-out"
          }
          data-phase-slot
        >
          <Loader2
            aria-hidden="true"
            className={
              displayPhase === "starting"
                ? "h-3 w-3 shrink-0 animate-spin opacity-70"
                : "h-3 w-3 shrink-0"
            }
          />
        </span>
      )}
      {modelToShow ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">
            <ModelDisplay modelString={modelToShow} showTooltip={false} />
          </span>
          <span className="shrink-0 opacity-70">{suffix}</span>
        </div>
      ) : (
        <span className="min-w-0 truncate">
          {displayPhase === "starting" ? "Assistant - starting..." : "Assistant - streaming..."}
        </span>
      )}
    </div>
  );
});
WorkspaceStatusIndicator.displayName = "WorkspaceStatusIndicator";
