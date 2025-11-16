import React, { useState, useEffect, useRef } from "react";
import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import { BASH_DEFAULT_TIMEOUT_SECS } from "@/common/constants/toolLimits";
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
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { cn } from "@/common/lib/utils";
import { TooltipWrapper, Tooltip } from "../Tooltip";

interface BashToolCallProps {
  args: BashToolArgs;
  result?: BashToolResult;
  status?: ToolStatus;
  startedAt?: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export const BashToolCall: React.FC<BashToolCallProps> = ({
  args,
  result,
  status = "pending",
  startedAt,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const [elapsedTime, setElapsedTime] = useState(0);
  const startTimeRef = useRef<number>(startedAt ?? Date.now());

  // Track elapsed time for pending/executing status
  useEffect(() => {
    if (status === "executing" || status === "pending") {
      const baseStart = startedAt ?? Date.now();
      startTimeRef.current = baseStart;
      setElapsedTime(Date.now() - baseStart);

      const timer = setInterval(() => {
        setElapsedTime(Date.now() - startTimeRef.current);
      }, 1000);

      return () => clearInterval(timer);
    }

    setElapsedTime(0);
    return undefined;
  }, [status, startedAt]);

  const isPending = status === "executing" || status === "pending";

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TooltipWrapper inline>
          <span>🔧</span>
          <Tooltip>bash</Tooltip>
        </TooltipWrapper>
        <span className="text-text font-monospace max-w-96 truncate">{args.script}</span>
        <span
          className={cn(
            "ml-2 text-[10px] whitespace-nowrap [@container(max-width:500px)]:hidden",
            isPending ? "text-pending" : "text-text-secondary"
          )}
        >
          timeout: {args.timeout_secs ?? BASH_DEFAULT_TIMEOUT_SECS}s
          {result && ` • took ${formatDuration(result.wall_duration_ms)}`}
          {!result && isPending && elapsedTime > 0 && ` • ${formatDuration(elapsedTime)}`}
        </span>
        {result && (
          <span
            className={cn(
              "ml-2 inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
              result.exitCode === 0 ? "bg-success text-on-success" : "bg-danger text-on-danger"
            )}
          >
            {result.exitCode}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Script</DetailLabel>
            <DetailContent>{args.script}</DetailContent>
          </DetailSection>

          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <div className="text-danger bg-danger-overlay border-danger rounded border-l-2 px-2 py-1.5 text-[11px]">
                    {result.error}
                  </div>
                </DetailSection>
              )}

              {result.output && (
                <DetailSection>
                  <DetailLabel>Output</DetailLabel>
                  <pre className="bg-code-bg border-success m-0 max-h-[200px] overflow-y-auto rounded border-l-2 px-2 py-1.5 text-[11px] leading-[1.4] break-words whitespace-pre-wrap">
                    {result.output}
                  </pre>
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
