import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";
import type { BashOutputGroupInfo } from "@/browser/utils/messages/messageUtils";
import { getToolComponent } from "../tools/shared/getToolComponent";

interface ToolMessageProps {
  message: DisplayedMessage & { type: "tool" };
  className?: string;
  workspaceId?: string;
  /** Handler for adding review notes from inline diffs */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Whether this is the latest propose_plan in the conversation */
  isLatestProposePlan?: boolean;
  /** Set of tool call IDs of foreground bashes */
  foregroundBashToolCallIds?: Set<string>;
  /** Callback to send a foreground bash to background */
  onSendBashToBackground?: (toolCallId: string) => void;
  /** Optional bash_output grouping info */
  bashOutputGroup?: BashOutputGroupInfo;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  message,
  className,
  workspaceId,
  onReviewNote,
  isLatestProposePlan,
  foregroundBashToolCallIds,
  onSendBashToBackground,
  bashOutputGroup,
}) => {
  const { toolName, args, result, status, toolCallId } = message;

  // Get the component from the registry (validates args, falls back to GenericToolCall)
  const ToolComponent = getToolComponent(toolName, args);

  // Compute tool-specific extras
  const canSendToBackground = foregroundBashToolCallIds?.has(toolCallId) ?? false;
  const groupPosition =
    bashOutputGroup?.position === "first" || bashOutputGroup?.position === "last"
      ? bashOutputGroup.position
      : undefined;

  return (
    <div className={className}>
      <ToolComponent
        // Base props (all tools)
        args={args}
        result={result ?? null}
        status={status}
        toolName={toolName}
        // Identity props (used by bash for live output, ask_user_question for caching)
        workspaceId={workspaceId}
        toolCallId={toolCallId}
        // Bash-specific
        startedAt={message.timestamp}
        canSendToBackground={canSendToBackground}
        onSendToBackground={
          onSendBashToBackground ? () => onSendBashToBackground(toolCallId) : undefined
        }
        // FileEdit-specific
        onReviewNote={onReviewNote}
        // ProposePlan-specific
        isLatest={isLatestProposePlan}
        // BashOutput-specific
        groupPosition={groupPosition}
        // CodeExecution-specific
        nestedCalls={message.nestedCalls}
      />
    </div>
  );
};
