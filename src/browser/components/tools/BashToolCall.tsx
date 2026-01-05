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
import { useBashToolLiveOutput, useLatestStreamingBashId } from "@/browser/stores/WorkspaceStore";
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

const EMPTY_LIVE_OUTPUT = {
  stdout: "",
  stderr: "",
  combined: "",
  truncated: false,
};

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
  const { expanded, setExpanded, toggleExpanded } = useToolExpansion();
  const [elapsedTime, setElapsedTime] = useState(0);

  const liveOutput = useBashToolLiveOutput(workspaceId, toolCallId);
  const latestStreamingBashId = useLatestStreamingBashId(workspaceId);
  const isLatestStreamingBash = latestStreamingBashId === toolCallId;

  const outputRef = useRef<HTMLPreElement>(null);
  const outputPinnedRef = useRef(true);

  const updatePinned = (el: HTMLPreElement) => {
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    outputPinnedRef.current = distanceToBottom < 40;
  };

  const liveOutputView = liveOutput ?? EMPTY_LIVE_OUTPUT;
  const combinedLiveOutput = liveOutputView.combined;

  useEffect(() => {
    const el = outputRef.current;
    if (!el) return;
    if (outputPinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [combinedLiveOutput]);
  const startTimeRef = useRef<number>(startedAt ?? Date.now());

  // Track whether user manually toggled expansion to avoid fighting with auto-expand
  const userToggledRef = useRef(false);
  // Track whether this bash was auto-expanded (so we know to auto-collapse it)
  const wasAutoExpandedRef = useRef(false);
  // Timer for delayed auto-expand
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-expand after a delay when this is the latest streaming bash.
  // Delay prevents layout flash for fast-completing commands.
  // Auto-collapse when a NEW bash starts streaming (but not on completion).
  useEffect(() => {
    if (userToggledRef.current) return; // Don't override user's choice

    if (isLatestStreamingBash && status === "executing") {
      // Delay expansion - if command completes quickly, we skip the expand entirely
      expandTimerRef.current = setTimeout(() => {
        if (!userToggledRef.current) {
          setExpanded(true);
          wasAutoExpandedRef.current = true;
        }
      }, 300);
    } else {
      // Clear pending expand if command finished before delay
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
      // Collapse if a NEW bash took over (latestStreamingBashId is not null and not us)
      if (wasAutoExpandedRef.current && latestStreamingBashId !== null) {
        setExpanded(false);
        wasAutoExpandedRef.current = false;
      }
    }

    return () => {
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
      }
    };
  }, [isLatestStreamingBash, latestStreamingBashId, status, setExpanded]);

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

  const showLiveOutput =
    !isBackground && (status === "executing" || (Boolean(liveOutput) && !resultHasOutput));

  const truncatedInfo = result && "truncated" in result ? result.truncated : undefined;

  const handleToggle = () => {
    userToggledRef.current = true;
    toggleExpanded();
  };
  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={handleToggle}>
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
          <DetailSection>
            <DetailLabel>Script</DetailLabel>
            <DetailContent className="px-2 py-1.5">{args.script}</DetailContent>
          </DetailSection>

          {showLiveOutput && (
            <>
              {liveOutputView.truncated && (
                <div className="text-muted px-2 text-[10px] italic">
                  Live output truncated (showing last ~1MB)
                </div>
              )}

              <DetailSection>
                <DetailLabel>Output</DetailLabel>
                <DetailContent
                  ref={outputRef}
                  onScroll={(e) => updatePinned(e.currentTarget)}
                  className={cn(
                    "px-2 py-1.5",
                    combinedLiveOutput.length === 0 && "text-muted italic"
                  )}
                >
                  {combinedLiveOutput.length > 0 ? combinedLiveOutput : "No output yet"}
                </DetailContent>
              </DetailSection>
            </>
          )}

          {result && (
            <>
              {result.success === false && result.error && (
                <DetailSection>
                  <DetailLabel>Error</DetailLabel>
                  <ErrorBox>{result.error}</ErrorBox>
                </DetailSection>
              )}

              {truncatedInfo && (
                <div className="text-muted px-2 text-[10px] italic">
                  Output truncated — reason: {truncatedInfo.reason} • totalLines:{" "}
                  {truncatedInfo.totalLines}
                </div>
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
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
