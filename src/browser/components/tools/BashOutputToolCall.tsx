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
 * Shows output from background processes in a format matching regular bash tool.
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
          {args.filter && ` (filter: ${args.filter})`}
        </span>
        {result?.success && (
          <span
            className={cn(
              "ml-2 inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
              result.output
                ? "bg-pending/20 text-pending"
                : "bg-muted-foreground/20 text-muted-foreground"
            )}
          >
            {result.output ? "new output" : "no output"}
          </span>
        )}
        {result?.success && processStatus && processStatus !== "running" && (
          <span
            className={cn(
              "ml-2 inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
              processStatus === "exited" && result.exitCode === 0
                ? "bg-success text-on-success"
                : "bg-danger text-on-danger"
            )}
          >
            {processStatus}
            {result.exitCode !== undefined && ` (${result.exitCode})`}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
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
                  <DetailContent className="text-muted px-2 py-1.5 italic">
                    No new output
                  </DetailContent>
                </DetailSection>
              )}
            </>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <DetailContent className="px-2 py-1.5">
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
