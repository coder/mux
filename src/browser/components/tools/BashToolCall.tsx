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
  ExitCodeBadge,
} from "./shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  formatDuration,
  type ToolStatus,
} from "./shared/toolUtils";
import { cn } from "@/common/lib/utils";
import { useBashToolLiveOutput } from "@/browser/stores/WorkspaceStore";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";

interface BashToolCallProps {
  workspaceId?: string;
  toolCallId?: string;
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
  workspaceId,
  toolCallId,
  args,
  result,
  status = "pending",
  startedAt,
  canSendToBackground,
  onSendToBackground,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const [elapsedTime, setElapsedTime] = useState(0);

  const liveOutput = useBashToolLiveOutput(workspaceId, toolCallId);

  const stdoutRef = useRef<HTMLPreElement>(null);
  const stderrRef = useRef<HTMLPreElement>(null);
  const stdoutPinnedRef = useRef(true);
  const stderrPinnedRef = useRef(true);

  const updatePinned = (el: HTMLPreElement, pinnedRef: React.MutableRefObject<boolean>) => {
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distanceToBottom < 40;
  };

  useEffect(() => {
    const el = stdoutRef.current;
    if (!el) return;
    if (stdoutPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [liveOutput?.stdout]);

  useEffect(() => {
    const el = stderrRef.current;
    if (!el) return;
    if (stderrPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [liveOutput?.stderr]);
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

  // Override status for backgrounded processes: the aggregator sees success=true and marks "completed",
  // but for a foreground→background migration we want to show "backgrounded"
  const effectiveStatus: ToolStatus =
    status === "completed" && result && "backgroundProcessId" in result ? "backgrounded" : status;

  const resultHasOutput = typeof (result as { output?: unknown } | undefined)?.output === "string";
  const showLiveOutput = Boolean(
    liveOutput && !isBackground && (status === "executing" || !resultHasOutput)
  );
  const liveLabelSuffix = status === "executing" ? " (live)" : " (tail)";

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon emoji="🔧" toolName="bash" />
        <span className="text-text font-monospace max-w-96 truncate">{args.script}</span>
        {isBackground && (
          // Background mode: show icon and display name
          <span className="text-muted ml-2 flex items-center gap-1 text-[10px] whitespace-nowrap">
            <Layers size={10} />
            {args.display_name}
          </span>
        )}
        {!isBackground && (
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
            {result && <ExitCodeBadge exitCode={result.exitCode} className="ml-2" />}
          </>
        )}
        <StatusIndicator status={effectiveStatus}>
          {getStatusDisplay(effectiveStatus)}
        </StatusIndicator>
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
          {showLiveOutput && liveOutput && (
            <>
              {liveOutput.truncated && (
                <div className="text-muted px-2 text-[10px] italic">
                  Live output truncated (showing last ~1MB)
                </div>
              )}

              <DetailSection>
                <DetailLabel>{`Stdout${liveLabelSuffix}`}</DetailLabel>
                <DetailContent
                  ref={stdoutRef}
                  onScroll={(e) => updatePinned(e.currentTarget, stdoutPinnedRef)}
                  className={cn(
                    "px-2 py-1.5",
                    liveOutput.stdout.length === 0 && "text-muted italic"
                  )}
                >
                  {liveOutput.stdout.length > 0 ? liveOutput.stdout : "No output yet"}
                </DetailContent>
              </DetailSection>

              <DetailSection>
                <DetailLabel>{`Stderr${liveLabelSuffix}`}</DetailLabel>
                <DetailContent
                  ref={stderrRef}
                  onScroll={(e) => updatePinned(e.currentTarget, stderrPinnedRef)}
                  className={cn(
                    "px-2 py-1.5",
                    liveOutput.stderr.length === 0 && "text-muted italic"
                  )}
                >
                  {liveOutput.stderr.length > 0 ? liveOutput.stderr : "No output yet"}
                </DetailContent>
              </DetailSection>
            </>
          )}
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
                // Background process: show process ID inline with icon (compact, no section wrapper)
                <div className="flex items-center gap-2 text-[11px]">
                  <Layers size={12} className="text-muted shrink-0" />
                  <span className="text-muted">Background process</span>
                  <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
                    {result.backgroundProcessId}
                  </code>
                </div>
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
