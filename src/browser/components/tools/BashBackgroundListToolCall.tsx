import React from "react";
import type {
  BashBackgroundListArgs,
  BashBackgroundListResult,
  BashBackgroundListProcess,
} from "@/common/types/tools";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  LoadingDots,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { cn } from "@/common/lib/utils";
import { TooltipWrapper, Tooltip } from "../Tooltip";

interface BashBackgroundListToolCallProps {
  args: BashBackgroundListArgs;
  result?: BashBackgroundListResult;
  status?: ToolStatus;
}

function formatUptime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 3600000)}h`;
}

function getProcessStatusStyle(status: BashBackgroundListProcess["status"]) {
  switch (status) {
    case "running":
      return "bg-success text-on-success";
    case "exited":
      return "bg-[hsl(0,0%,40%)] text-white";
    case "killed":
    case "failed":
      return "bg-danger text-on-danger";
  }
}

export const BashBackgroundListToolCall: React.FC<BashBackgroundListToolCallProps> = ({
  args: _args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(false);

  const processes = result?.success ? result.processes : [];
  const processCount = processes.length;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TooltipWrapper inline>
          <span>📋</span>
          <Tooltip>bash_background_list</Tooltip>
        </TooltipWrapper>
        <span className="text-text-secondary">
          {result?.success
            ? processCount === 0
              ? "No background processes"
              : `${processCount} background process${processCount !== 1 ? "es" : ""}`
            : "Listing background processes"}
        </span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {result?.success === false && (
            <DetailSection>
              <div className="text-danger bg-danger-overlay border-danger rounded border-l-2 px-2 py-1.5 text-[11px]">
                {result.error}
              </div>
            </DetailSection>
          )}

          {result?.success && processes.length > 0 && (
            <DetailSection>
              <div className="space-y-2">
                {processes.map((proc) => (
                  <div
                    key={proc.display_name ?? proc.process_id}
                    className="bg-code-bg rounded px-2 py-1.5 text-[11px]"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <span className="text-text font-mono">
                        {proc.display_name ?? proc.process_id}
                      </span>
                      <span
                        className={cn(
                          "inline-block rounded px-1.5 py-0.5 text-[9px] font-medium uppercase",
                          getProcessStatusStyle(proc.status)
                        )}
                      >
                        {proc.status}
                        {proc.exitCode !== undefined && ` (${proc.exitCode})`}
                      </span>
                      <span className="text-text-secondary ml-auto">
                        {formatUptime(proc.uptime_ms)}
                      </span>
                    </div>
                    <div className="text-text-secondary truncate font-mono" title={proc.script}>
                      {proc.script}
                    </div>
                    <div className="text-text-secondary mt-1 space-y-0.5 text-[10px]">
                      <div>
                        <span className="opacity-60">stdout:</span> {proc.stdout_path}
                      </div>
                      <div>
                        <span className="opacity-60">stderr:</span> {proc.stderr_path}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </DetailSection>
          )}

          {result?.success && processes.length === 0 && (
            <DetailSection>
              <div className="text-text-secondary text-[11px] italic">
                No background processes running
              </div>
            </DetailSection>
          )}

          {status === "executing" && !result && (
            <DetailSection>
              <div className="text-[11px]">
                Listing processes
                <LoadingDots />
              </div>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
