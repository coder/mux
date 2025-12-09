import React, { useState, useEffect, useRef } from "react";
import { Layers } from "lucide-react";
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
  ToolIcon,
  ErrorBox,
} from "./shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  formatDuration,
  type ToolStatus,
} from "./shared/toolUtils";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";

interface BashToolCallProps {
  args: BashToolArgs;
  result?: BashToolResult;
  status?: ToolStatus;
  startedAt?: number;
  /** Whether there's a foreground bash that can be sent to background */
  canSendToBackground?: boolean;
  /** Callback to send the current foreground bash to background */
  onSendToBackground?: () => void;
}

export const BashToolCall: React.FC<BashToolCallProps> = ({
  args,
  result,
  status = "pending",
  startedAt,
  canSendToBackground,
  onSendToBackground,
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
  const isBackground = args.run_in_background ?? (result && "backgroundProcessId" in result);

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon emoji="🔧" toolName="bash" />
        <span className="text-text font-monospace max-w-96 truncate">{args.script}</span>
        {isBackground ? (
          // Background mode: show background badge and optional display name
          <span className="text-muted ml-2 flex items-center gap-1 text-[10px] whitespace-nowrap">
            <Layers size={10} />
            background{args.display_name && ` • ${args.display_name}`}
          </span>
        ) : (
          // Normal mode: show timeout and duration
          <>
            <span
              className={cn(
                "ml-2 text-[10px] whitespace-nowrap [@container(max-width:500px)]:hidden",
                isPending ? "text-pending" : "text-text-secondary"
              )}
            >
              timeout: {args.timeout_secs ?? BASH_DEFAULT_TIMEOUT_SECS}s
              {result && ` • took ${formatDuration(result.wall_duration_ms)}`}
              {!result && isPending && elapsedTime > 0 && ` • ${Math.round(elapsedTime / 1000)}s`}
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
          </>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
        {/* Show "Background" button when bash is executing and can be sent to background.
            Use invisible when executing but not yet confirmed as foreground to avoid layout flash. */}
        {status === "executing" && !isBackground && onSendToBackground && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation(); // Don't toggle expand
                  onSendToBackground();
                }}
                disabled={!canSendToBackground}
                className={cn(
                  "ml-2 flex cursor-pointer items-center gap-1 rounded p-1 text-[10px] font-medium transition-colors",
                  "bg-[var(--color-pending)]/20 text-[var(--color-pending)]",
                  "hover:bg-[var(--color-pending)]/30",
                  "disabled:pointer-events-none disabled:invisible"
                )}
              >
                <Layers size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Send to background — process continues but agent stops waiting
            </TooltipContent>
          </Tooltip>
        )}
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Script</DetailLabel>
            <DetailContent className="px-2 py-1.5">{args.script}</DetailContent>
          </DetailSection>

          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {"backgroundProcessId" in result ? (
                // Background process: show process ID inline with icon
                <DetailSection>
                  <DetailContent className="flex items-center gap-2 px-2 py-1.5">
                    <Layers size={14} className="text-muted shrink-0" />
                    <span className="text-muted">Background process</span>
                    <code className="bg-[var(--color-bg-tertiary)] rounded px-1.5 py-0.5 font-mono text-xs">
                      {result.backgroundProcessId}
                    </code>
                  </DetailContent>
                </DetailSection>
              ) : (
                // Normal process: show output
                result.output && (
                  <DetailSection>
                    <DetailLabel>Output</DetailLabel>
                    <DetailContent className="px-2 py-1.5">{result.output}</DetailContent>
                  </DetailSection>
                )
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
