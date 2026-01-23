import React, { useEffect, useRef, useState } from "react";
import { FileText, Info, Layers, Loader2 } from "lucide-react";
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
import { useForegroundBashToolCallIds } from "@/browser/stores/BackgroundBashStore";
import { useBackgroundBashActions } from "@/browser/contexts/BackgroundBashContext";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { BackgroundBashOutputDialog } from "../BackgroundBashOutputDialog";

interface BashToolCallProps {
  workspaceId?: string;
  toolCallId?: string;
  args: BashToolArgs;
  result?: BashToolResult;
  status?: ToolStatus;
  startedAt?: number;
}

/**
 * Isolated component for elapsed time display.
 * Uses requestAnimationFrame + local state to avoid re-rendering parent component.
 */
const ElapsedTimeDisplay: React.FC<{ startedAt: number | undefined; isActive: boolean }> = ({
  startedAt,
  isActive,
}) => {
  const elapsedRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);
  const baseStart = useRef(startedAt ?? Date.now());

  useEffect(() => {
    if (!isActive) {
      elapsedRef.current = 0;
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      return;
    }

    baseStart.current = startedAt ?? Date.now();
    let lastSecond = -1;

    const tick = () => {
      const now = Date.now();
      const elapsed = now - baseStart.current;
      const currentSecond = Math.floor(elapsed / 1000);

      // Only update when second changes to minimize renders
      if (currentSecond !== lastSecond) {
        lastSecond = currentSecond;
        elapsedRef.current = elapsed;
        forceUpdate();
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    tick();

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [isActive, startedAt]);

  if (!isActive || elapsedRef.current === 0) {
    return null;
  }

  return <> • {Math.round(elapsedRef.current / 1000)}s</>;
};

type BashLiveOutputView = NonNullable<ReturnType<typeof useBashToolLiveOutput>>;

const EMPTY_LIVE_OUTPUT: BashLiveOutputView = {
  stdout: "",
  stderr: "",
  combined: "",
  truncated: false,
  phase: undefined,
};

export const BashToolCall: React.FC<BashToolCallProps> = ({
  workspaceId,
  toolCallId,
  args,
  result,
  status = "pending",
  startedAt,
}) => {
  const { expanded, setExpanded, toggleExpanded } = useToolExpansion();
  const [outputDialogOpen, setOutputDialogOpen] = useState(false);

  const foregroundBashToolCallIds = useForegroundBashToolCallIds(workspaceId);
  const { sendToBackground } = useBackgroundBashActions();

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

  const isPending = status === "executing" || status === "pending";
  const backgroundProcessId =
    result && "backgroundProcessId" in result ? result.backgroundProcessId : null;
  const isBackground = args.run_in_background ?? Boolean(backgroundProcessId);

  // Override status for backgrounded processes: the aggregator sees success=true and marks "completed",
  // but for a foreground→background migration we want to show "backgrounded"
  const effectiveStatus: ToolStatus =
    status === "completed" && result && "backgroundProcessId" in result ? "backgrounded" : status;

  const resultHasOutput = typeof (result as { output?: unknown } | undefined)?.output === "string";

  const showLiveOutput =
    !isBackground && (status === "executing" || (Boolean(liveOutput) && !resultHasOutput));

  const isFilteringLiveOutput = showLiveOutput && liveOutputView.phase === "filtering";

  const canSendToBackground = Boolean(
    toolCallId && workspaceId && foregroundBashToolCallIds.has(toolCallId)
  );
  const handleSendToBackground =
    toolCallId && workspaceId
      ? () => {
          sendToBackground(toolCallId);
        }
      : undefined;
  const truncatedInfo = result && "truncated" in result ? result.truncated : undefined;
  const note = result && "note" in result ? result.note : undefined;

  const isBackgroundResult = Boolean(result && "backgroundProcessId" in result);
  const completedOutput = isBackgroundResult ? undefined : result?.output;
  const completedHasOutput = typeof completedOutput === "string" && completedOutput.length > 0;
  const showCompletedOutputSection = !isBackgroundResult && (completedHasOutput || Boolean(note));

  const handleToggle = () => {
    userToggledRef.current = true;
    toggleExpanded();
  };
  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={handleToggle}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="bash" />
        <span className="text-text font-monospace max-w-96 truncate">{args.script}</span>
        {isBackground && backgroundProcessId && workspaceId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOutputDialogOpen(true);
                }}
                className="text-muted hover:text-secondary ml-2 rounded p-1 transition-colors"
              >
                <FileText size={12} />
              </button>
            </TooltipTrigger>
            <TooltipContent>View output</TooltipContent>
          </Tooltip>
        )}
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
              {!result && <ElapsedTimeDisplay startedAt={startedAt} isActive={isPending} />}
            </span>
            {result && <ExitCodeBadge exitCode={result.exitCode} className="ml-2" />}
          </>
        )}
        <StatusIndicator status={effectiveStatus}>
          {getStatusDisplay(effectiveStatus)}
        </StatusIndicator>
        {/* Show "Background" button when bash is executing and can be sent to background.
            Use invisible when executing but not yet confirmed as foreground to avoid layout flash. */}
        {status === "executing" && !isBackground && handleSendToBackground && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation(); // Don't toggle expand
                  handleSendToBackground();
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
      {backgroundProcessId && workspaceId && (
        <BackgroundBashOutputDialog
          open={outputDialogOpen}
          onOpenChange={setOutputDialogOpen}
          workspaceId={workspaceId}
          processId={backgroundProcessId}
          displayName={args.display_name}
        />
      )}

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
                <div className="relative">
                  <DetailContent
                    ref={outputRef}
                    onScroll={(e) => updatePinned(e.currentTarget)}
                    className={cn(
                      "px-2 py-1.5",
                      combinedLiveOutput.length === 0 && "text-muted italic",
                      isFilteringLiveOutput && "opacity-60 blur-[1px]"
                    )}
                  >
                    {combinedLiveOutput.length > 0 ? combinedLiveOutput : "No output yet"}
                  </DetailContent>
                  {isFilteringLiveOutput && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                      <div className="text-muted flex items-center gap-1 rounded border border-white/10 bg-[var(--color-bg-tertiary)]/80 px-2 py-1 text-[10px] backdrop-blur-sm">
                        <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
                        Compacting output…
                      </div>
                    </div>
                  )}
                </div>
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
                // Normal process: show output (and any notice via tooltip)
                showCompletedOutputSection && (
                  <DetailSection>
                    <DetailLabel className="flex items-center gap-1">
                      <span>Output</span>
                      {note && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label="View notice"
                              className="text-muted hover:text-secondary translate-y-[-1px] rounded p-0.5 transition-colors"
                            >
                              <Info size={12} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            <div className="max-w-xs break-words whitespace-pre-wrap">{note}</div>
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </DetailLabel>
                    <DetailContent
                      className={cn("px-2 py-1.5", !completedHasOutput && "text-muted italic")}
                    >
                      {completedHasOutput ? completedOutput : "No output"}
                    </DetailContent>
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
