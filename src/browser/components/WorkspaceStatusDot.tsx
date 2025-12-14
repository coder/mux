import { cn } from "@/common/lib/utils";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { getStatusTooltip } from "@/browser/utils/ui/statusTooltip";
import { memo, useMemo } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";

export const WorkspaceStatusDot = memo<{
  workspaceId: string;
  lastReadTimestamp?: number;
  onClick?: (e: React.MouseEvent) => void;
  size?: number;
}>(
  ({ workspaceId, lastReadTimestamp, onClick, size = 8 }) => {
    const { canInterrupt, awaitingUserQuestion, currentModel, agentStatus, recencyTimestamp } =
      useWorkspaceSidebarState(workspaceId);

    const streaming = canInterrupt && !awaitingUserQuestion;

    // Compute unread status if lastReadTimestamp provided (sidebar only)
    const unread = useMemo(() => {
      if (lastReadTimestamp === undefined) return false;
      return recencyTimestamp !== null && recencyTimestamp > lastReadTimestamp;
    }, [lastReadTimestamp, recencyTimestamp]);

    // Compute tooltip
    const title = useMemo(
      () =>
        getStatusTooltip({
          isStreaming: streaming,
          isAwaitingInput: awaitingUserQuestion,
          streamingModel: currentModel,
          agentStatus,
          isUnread: unread,
          recencyTimestamp,
        }),
      [streaming, awaitingUserQuestion, currentModel, agentStatus, unread, recencyTimestamp]
    );

    const bgColor = canInterrupt ? "bg-blue-400" : unread ? "bg-gray-300" : "bg-muted-dark";
    const cursor = onClick && !streaming ? "cursor-pointer" : "cursor-default";

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            style={{ width: size, height: size }}
            className={cn(
              "rounded-full shrink-0 transition-colors duration-200",
              bgColor,
              cursor,
              onClick && !streaming && "hover:opacity-70",
              streaming && "animate-pulse"
            )}
            onClick={(e) => {
              e.stopPropagation();
              onClick?.(e);
            }}
          />
        </TooltipTrigger>
        <TooltipContent align="center">{title}</TooltipContent>
      </Tooltip>
    );
  },
  (prevProps, nextProps) =>
    prevProps.workspaceId === nextProps.workspaceId &&
    prevProps.lastReadTimestamp === nextProps.lastReadTimestamp &&
    prevProps.onClick === nextProps.onClick &&
    prevProps.size === nextProps.size
);
WorkspaceStatusDot.displayName = "WorkspaceStatusDot";
