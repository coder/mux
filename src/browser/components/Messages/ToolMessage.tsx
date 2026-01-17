import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import type { ReviewNoteData } from "@/common/types/review";
import type { BashOutputGroupInfo } from "@/browser/utils/messages/messageUtils";
import { getToolComponent } from "../tools/shared/getToolComponent";
import {
  HookOutputDisplay,
  extractHookOutput,
  extractHookDuration,
} from "../tools/shared/HookOutputDisplay";

interface ToolMessageProps {
  message: DisplayedMessage & { type: "tool" };
  className?: string;
  workspaceId?: string;
  /** Handler for adding review notes from inline diffs */
  onReviewNote?: (data: ReviewNoteData) => void;
  /** Whether this is the latest propose_plan in the conversation */
  isLatestProposePlan?: boolean;
  /** Optional bash_output grouping info */
  bashOutputGroup?: BashOutputGroupInfo;
}

export const ToolMessage: React.FC<ToolMessageProps> = ({
  message,
  className,
  workspaceId,
  onReviewNote,
  isLatestProposePlan,
  bashOutputGroup,
}) => {
  const { toolName, args, result, status, toolCallId } = message;

  // Get the component from the registry (validates args, falls back to GenericToolCall)
  const ToolComponent = getToolComponent(toolName, args);

  // Compute tool-specific extras
  const groupPosition =
    bashOutputGroup?.position === "first" || bashOutputGroup?.position === "last"
      ? bashOutputGroup.position
      : undefined;

  // Extract hook output if present (only shown when hook produced output)
  const hookOutput = extractHookOutput(result);
  const hookDuration = extractHookDuration(result);

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
        // FileEdit-specific
        onReviewNote={onReviewNote}
        // ProposePlan-specific
        isLatest={isLatestProposePlan}
        // BashOutput-specific
        groupPosition={groupPosition}
        // CodeExecution-specific
        nestedCalls={message.nestedCalls}
      />
      {hookOutput && <HookOutputDisplay output={hookOutput} durationMs={hookDuration} />}
    </div>
  );
};
