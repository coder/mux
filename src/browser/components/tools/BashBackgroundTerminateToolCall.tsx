import React from "react";
import type {
  BashBackgroundTerminateArgs,
  BashBackgroundTerminateResult,
} from "@/common/types/tools";
import { ToolContainer, ToolHeader, StatusIndicator, ToolIcon } from "./shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./shared/toolUtils";

interface BashBackgroundTerminateToolCallProps {
  args: BashBackgroundTerminateArgs;
  result?: BashBackgroundTerminateResult;
  status?: ToolStatus;
}

export const BashBackgroundTerminateToolCall: React.FC<BashBackgroundTerminateToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const statusDisplay = getStatusDisplay(status);

  return (
    <ToolContainer expanded={false}>
      <ToolHeader>
        <ToolIcon toolName="bash_background_terminate" />
        <span className="text-text font-mono">
          {result?.success === true ? (result.display_name ?? args.process_id) : args.process_id}
        </span>
        {result?.success === true && (
          <span className="text-text-secondary text-[10px]">terminated</span>
        )}
        {result?.success === false && (
          <span className="text-danger text-[10px]">{result.error}</span>
        )}
        <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>
    </ToolContainer>
  );
};
