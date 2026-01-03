import React from "react";
import type { UserNotifyToolResult } from "@/common/types/tools";
import { ToolContainer, ToolHeader, StatusIndicator, ToolIcon } from "./shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./shared/toolUtils";

interface UserNotifyToolCallProps {
  args: { title: string; message?: string };
  result?: UserNotifyToolResult;
  status?: ToolStatus;
}

export const UserNotifyToolCall: React.FC<UserNotifyToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const statusDisplay = getStatusDisplay(status);

  // Show error message if failed
  const errorMessage =
    status === "failed" && result && typeof result === "object" && "error" in result
      ? String(result.error)
      : undefined;

  return (
    <ToolContainer expanded={false}>
      <ToolHeader>
        <ToolIcon emoji="🔔" toolName="user_notify" />
        <span className="text-muted-foreground truncate italic">{args.title}</span>
        {args.message && (
          <span className="text-muted-foreground/60 hidden truncate @[300px]:inline">
            — {args.message}
          </span>
        )}
        {errorMessage && <span className="text-error-foreground">({errorMessage})</span>}
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
};
