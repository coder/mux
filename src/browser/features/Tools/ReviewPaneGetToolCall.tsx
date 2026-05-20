import React from "react";
import type { ReviewPaneGetToolResult } from "@/common/types/tools";
import { ToolContainer, ToolHeader, StatusIndicator, ToolIcon } from "./Shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";

interface ReviewPaneGetToolCallProps {
  result?: ReviewPaneGetToolResult | { success: false; error: string };
  status?: ToolStatus;
}

/**
 * Custom renderer for `review_pane_get`. The tool takes no input and only
 * reports the current pinned set, so we collapse it into a single-line
 * preview ("Inspected N pinned hunks") without an expand affordance — the
 * full list is already visible in the Review pane.
 */
export const ReviewPaneGetToolCall: React.FC<ReviewPaneGetToolCallProps> = ({
  result,
  status = "pending",
}) => {
  const statusDisplay = getStatusDisplay(status);

  const successResult =
    result && typeof result === "object" && "hunks" in result ? result : undefined;
  const errorMessage =
    result && typeof result === "object" && "success" in result && result.success === false
      ? result.error
      : undefined;

  const count = successResult?.hunks.length ?? 0;
  const summary =
    status !== "completed"
      ? "Reading pinned review hunks"
      : count === 0
        ? "No pinned hunks"
        : `Inspected ${count} pinned hunk${count === 1 ? "" : "s"}`;

  return (
    <ToolContainer expanded={false}>
      <ToolHeader>
        <ToolIcon toolName="review_pane_get" />
        <span className="text-muted-foreground truncate italic">{summary}</span>
        {errorMessage && <span className="text-error-foreground">({errorMessage})</span>}
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
};
