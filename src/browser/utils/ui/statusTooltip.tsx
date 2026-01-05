import React from "react";
import { ModelDisplay } from "@/browser/components/Messages/ModelDisplay";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";

/**
 * Compute tooltip content for StatusIndicator based on workspace state.
 * Handles both sidebar (with unread/recency) and header (simpler) cases.
 */
export function getStatusTooltip(options: {
  isStreaming: boolean;
  isAwaitingInput?: boolean;
  streamingModel: string | null;
  agentStatus?: { emoji: string; message: string; url?: string };
  isUnread?: boolean;
  recencyTimestamp?: number | null;
}): React.ReactNode {
  const { isStreaming, isAwaitingInput, streamingModel, agentStatus, isUnread, recencyTimestamp } =
    options;

  // If agent status is set, show message and URL (if available)
  if (agentStatus) {
    if (agentStatus.url) {
      return (
        <>
          {agentStatus.message}
          <br />
          <span style={{ opacity: 0.7, fontSize: "0.9em" }}>{agentStatus.url}</span>
        </>
      );
    }
    return agentStatus.message;
  }

  // Show awaiting input status
  if (isAwaitingInput) {
    return "Awaiting your input";
  }

  // Otherwise show streaming/idle status
  if (isStreaming && streamingModel) {
    return (
      <span>
        <ModelDisplay modelString={streamingModel} showTooltip={false} /> is responding
      </span>
    );
  }

  if (isStreaming) {
    return "Assistant is responding";
  }

  // Only show unread if explicitly provided (sidebar only)
  if (isUnread) {
    return "Unread messages";
  }

  // Show recency if available (sidebar only)
  if (recencyTimestamp) {
    return `Idle • Last used ${formatRelativeTime(recencyTimestamp)}`;
  }

  return "Idle";
}
