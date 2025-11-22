import React from "react";
import type { DisplayedMessage } from "@/common/types/message";
import { cn } from "@/common/lib/utils";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  StatusIndicator,
} from "../tools/shared/ToolPrimitives";
import { useToolExpansion } from "../tools/shared/toolUtils";

interface ScriptExecutionMessageProps {
  message: Extract<DisplayedMessage, { type: "script-execution" }>;
  className?: string;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export const ScriptExecutionMessage: React.FC<ScriptExecutionMessageProps> = ({
  message,
  className,
}) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const { result } = message;

  const isPending = !result;

  const exitBadgeClass = cn(
    "ml-2 inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
    isPending
      ? "bg-foreground-tertiary text-background"
      : result.exitCode === 0
        ? "bg-success text-on-success"
        : "bg-danger text-on-danger"
  );

  const argsPreview = message.args.length > 0 ? ` ${message.args.join(" ")}` : "";

  return (
    <ToolContainer expanded={expanded} className={className}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <span aria-hidden="true">📝</span>
        <span className="font-monospace max-w-96 truncate">
          {message.command || `/script ${message.scriptName}${argsPreview}`}
        </span>
        {!isPending && (
          <span className="text-foreground-secondary ml-2 text-[10px] whitespace-nowrap">
            took {formatDuration(result.wall_duration_ms)}
          </span>
        )}
        <span className={exitBadgeClass}>
          {isPending ? "Running..." : `exit ${result.exitCode}`}
        </span>
        <StatusIndicator status={isPending ? "executing" : "completed"}>script</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Command</DetailLabel>
            <DetailContent>{message.command}</DetailContent>
          </DetailSection>

          <DetailSection>
            <DetailLabel>Runtime info</DetailLabel>
            <div className="text-foreground-secondary text-[11px]">
              {new Date(message.timestamp).toLocaleString()}
              {!isPending && ` • ${formatDuration(result.wall_duration_ms)}`}
            </div>
            <div className="text-foreground-secondary text-[11px]">
              Visible to you and the model.
            </div>
          </DetailSection>

          {!isPending && result.success === false && result.error && (
            <DetailSection>
              <DetailLabel>Error</DetailLabel>
              <div className="text-danger bg-danger-overlay border-danger rounded border-l-2 px-2 py-1.5 text-[11px]">
                {result.error}
              </div>
            </DetailSection>
          )}

          {!isPending && result.output && (
            <DetailSection>
              <DetailLabel>Stdout / Stderr</DetailLabel>
              <DetailContent>{result.output}</DetailContent>
            </DetailSection>
          )}

          {!isPending && result.outputFile && (
            <DetailSection>
              <DetailLabel>MUX_OUTPUT</DetailLabel>
              <DetailContent>{result.outputFile}</DetailContent>
            </DetailSection>
          )}

          {!isPending && result.promptFile && (
            <DetailSection>
              <DetailLabel>MUX_PROMPT</DetailLabel>
              <DetailContent>{result.promptFile}</DetailContent>
            </DetailSection>
          )}

          {!isPending && result.truncated && (
            <DetailSection>
              <DetailLabel>Truncation</DetailLabel>
              <div className="text-foreground-secondary text-[11px]">
                Output truncated: {result.truncated.reason} ({result.truncated.totalLines} lines
                preserved)
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
