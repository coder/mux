import React from "react";
import type { StatusSetToolArgs, StatusSetToolResult } from "@/common/types/tools";
import { ToolContainer, ToolHeader, StatusIndicator, ToolIcon } from "./shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./shared/toolUtils";

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
        <ToolIcon toolName="status_set" emoji={args.emoji} />
        <span className="text-muted-foreground italic">{args.message}</span>
        {errorMessage && <span className="text-error-foreground">({errorMessage})</span>}
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
};
