import React from "react";
import type { StatusSetToolArgs, StatusSetToolResult } from "@/common/types/tools";
import { ToolContainer, ToolHeader, StatusIndicator } from "./shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { TooltipWrapper, Tooltip } from "../Tooltip";

interface StatusSetToolCallProps {
  args: StatusSetToolArgs;
  result?: StatusSetToolResult;
  status?: ToolStatus;
}

export const StatusSetToolCall: React.FC<StatusSetToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const statusDisplay = getStatusDisplay(status);

  // Show error message if validation failed
  const errorMessage =
    status === "failed" && result && typeof result === "object" && "error" in result
      ? String(result.error)
      : undefined;

  return (
    <ToolContainer expanded={false}>
      <ToolHeader>
        <TooltipWrapper inline>
          <span>{args.emoji}</span>
          <Tooltip>status_set</Tooltip>
        </TooltipWrapper>
        <span className="text-muted-foreground italic">{args.message}</span>
        {errorMessage && <span className="text-error-foreground">({errorMessage})</span>}
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
};
