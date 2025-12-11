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

  const isLegacy = "emoji" in args;
  const iconEmoji = isLegacy ? args.emoji : "📡";

  const summary = isLegacy
    ? args.message
    : `poll=${args.poll_interval_ms}ms: ${args.script.split(/\r?\n/)[0] ?? ""}`;

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
