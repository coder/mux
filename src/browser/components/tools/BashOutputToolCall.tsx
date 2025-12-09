import React from "react";
import { Layers } from "lucide-react";
import type { BashOutputToolArgs, BashOutputToolResult } from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
  ToolIcon,
  ErrorBox,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { cn } from "@/common/lib/utils";

interface BashOutputToolCallProps {
  args: BashOutputToolArgs;
  result?: BashOutputToolResult;
  status?: ToolStatus;
}

/**
 * Display component for bash_output tool calls.
 * Shows output from background processes in a format similar to regular bash tool.
 */
export const BashOutputToolCall: React.FC<BashOutputToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();

  // Derive process status display
  const processStatus = result?.success ? result.status : undefined;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon emoji="🔧" toolName="bash_output" />
        <span className="text-text font-monospace max-w-96 truncate">{args.process_id}</span>
        <span className="text-muted ml-2 flex items-center gap-1 text-[10px] whitespace-nowrap">
          <Layers size={10} />
          output
        </span>
        {result?.success && processStatus && (
          <span
            className={cn(
              "ml-2 inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
              processStatus === "running"
                ? "bg-pending/20 text-pending"
                : processStatus === "exited" && result.exitCode === 0
                  ? "bg-success text-on-success"
                  : "bg-danger text-on-danger"
            )}
          >
            {processStatus}
            {result.exitCode !== undefined && processStatus !== "running" && ` (${result.exitCode})`}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Process ID</DetailLabel>
            <DetailContent className="px-2 py-1.5">
              <code className="font-mono">{args.process_id}</code>
              {args.filter && (
                <span className="text-muted ml-2">
                  (filter: <code className="font-mono">{args.filter}</code>)
                </span>
              )}
            </DetailContent>
          </DetailSection>

          {result && (
            <>
              {result.success === false && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {result.success && result.output && (
                <DetailSection>
                  <DetailLabel>Output</DetailLabel>
                  <DetailContent className="px-2 py-1.5">{result.output}</DetailContent>
                </DetailSection>
              )}

              {result.success && !result.output && (
                <DetailSection>
                  <DetailContent className="text-muted italic">No new output</DetailContent>
                </DetailSection>
              )}
            </>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <DetailContent>
                Waiting for result
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
