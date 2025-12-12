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

  const iconEmoji = "📡";

  const pollLabel = args.poll_interval_s === undefined ? "once" : `${args.poll_interval_s}s`;
  const summary = `poll=${pollLabel}: ${args.script.split(/\r?\n/)[0] ?? ""}`;

  return (
    <ToolContainer expanded={false}>
      <ToolHeader>
        <ToolIcon emoji={iconEmoji} toolName="status_set" />
        <span className="text-muted-foreground italic">{summary}</span>
        {errorMessage && <span className="text-error-foreground">({errorMessage})</span>}
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
};
