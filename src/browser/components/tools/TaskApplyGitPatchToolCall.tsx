import React from "react";
import type { TaskApplyGitPatchToolArgs, TaskApplyGitPatchToolResult } from "@/common/types/tools";
import {
  DetailContent,
  DetailLabel,
  DetailSection,
  ErrorBox,
  ExpandIcon,
  HeaderButton,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./shared/ToolPrimitives";
import { getStatusDisplay, useToolExpansion, type ToolStatus } from "./shared/toolUtils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { cn } from "@/common/lib/utils";

interface TaskApplyGitPatchToolCallProps {
  args: TaskApplyGitPatchToolArgs;
  result?: TaskApplyGitPatchToolResult | null;
  status?: ToolStatus;
}

function formatCommitCount(count: number): string {
  return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function formatShortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 7) : sha;
}

const CopyableCode: React.FC<{
  value: string;
  tooltipLabel: string;
  className?: string;
}> = ({ value, tooltipLabel, className }) => {
  const { copied, copyToClipboard } = useCopyToClipboard();

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "min-w-0 font-mono text-[11px] text-link opacity-90 hover:opacity-100 hover:underline underline-offset-2 truncate",
            className
          )}
          onClick={() => void copyToClipboard(value)}
        >
          {value}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : tooltipLabel}</TooltipContent>
    </Tooltip>
  );
};

const ErrorOutput: React.FC<{ error: string }> = ({ error }) => (
  <ErrorBox>
    <pre className="m-0 max-h-[200px] overflow-y-auto break-words whitespace-pre-wrap">{error}</pre>
  </ErrorBox>
);

export const TaskApplyGitPatchToolCall: React.FC<TaskApplyGitPatchToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const successResult = result?.success === true ? result : null;
  const errorResult = result?.success === false ? result : null;

  const taskIdFromResult =
    result && typeof result === "object" && result !== null && "taskId" in result
      ? typeof (result as { taskId?: unknown }).taskId === "string"
        ? (result as { taskId: string }).taskId
        : undefined
      : undefined;
  const taskId = taskIdFromResult ?? args.task_id;

  const isDryRun = Boolean(successResult?.dryRun) || args.dry_run === true;

  const errorPreview =
    typeof errorResult?.error === "string" ? errorResult.error.split("\n")[0]?.trim() : undefined;

  // Auto-expand on failures so the user sees actionable notes (git am --continue/--abort, etc.).
  const { expanded, toggleExpanded } = useToolExpansion(Boolean(errorResult));

  const { copied: copiedError, copyToClipboard: copyErrorToClipboard } = useCopyToClipboard();

  const effectiveThreeWay = args.three_way !== false;

  const errorNote = errorResult && "note" in errorResult ? errorResult.note : undefined;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="task_apply_git_patch" />
        <ToolName>task_apply_git_patch</ToolName>
        <span className="text-muted ml-1 max-w-40 truncate text-[10px]">{taskId}</span>
        {isDryRun && <span className="text-backgrounded text-[10px] font-medium">dry-run</span>}
        {successResult && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            {formatCommitCount(successResult.appliedCommitCount)}
          </span>
        )}
        {successResult?.headCommitSha && (
          <span className="text-secondary ml-2 hidden text-[10px] whitespace-nowrap @sm:inline">
            HEAD {formatShortSha(successResult.headCommitSha)}
          </span>
        )}
        {errorPreview && (
          <span className="text-danger ml-2 max-w-64 truncate text-[10px]">{errorPreview}</span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <DetailSection>
            <DetailLabel>Patch source</DetailLabel>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="text-secondary shrink-0 font-medium">Task ID:</span>
                <CopyableCode
                  value={taskId}
                  tooltipLabel="Copy task ID"
                  className="max-w-[260px]"
                />
              </div>
            </div>
          </DetailSection>

          <DetailSection>
            <DetailLabel>Options</DetailLabel>
            <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
              <div className="flex items-center gap-1.5">
                <span className="text-secondary font-medium">dry_run:</span>
                <span className="text-text font-mono">
                  {args.dry_run === true ? "true" : "false"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-secondary font-medium">three_way:</span>
                <span className="text-text font-mono">{effectiveThreeWay ? "true" : "false"}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-secondary font-medium">force:</span>
                <span className="text-text font-mono">
                  {args.force === true ? "true" : "false"}
                </span>
              </div>
            </div>
          </DetailSection>

          {status === "executing" && !result && (
            <DetailSection>
              <DetailContent>
                Applying patch
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}

          {successResult && (
            <>
              <DetailSection>
                <DetailLabel>Result</DetailLabel>
                <div className="bg-code-bg flex flex-wrap gap-4 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
                  <div className="flex items-center gap-1.5">
                    <span className="text-secondary font-medium">
                      {isDryRun ? "Would apply" : "Applied"}:
                    </span>
                    <span className="text-text font-mono">
                      {formatCommitCount(successResult.appliedCommitCount)}
                    </span>
                  </div>
                  {successResult.headCommitSha && (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="text-secondary shrink-0 font-medium">HEAD:</span>
                      <CopyableCode
                        value={successResult.headCommitSha}
                        tooltipLabel="Copy HEAD SHA"
                      />
                    </div>
                  )}
                </div>
              </DetailSection>

              {successResult.note && (
                <DetailSection>
                  <DetailLabel>Note</DetailLabel>
                  <DetailContent className="px-2 py-1.5">{successResult.note}</DetailContent>
                </DetailSection>
              )}
            </>
          )}

          {errorResult && (
            <>
              <DetailSection>
                <DetailLabel className="flex items-center justify-between gap-2">
                  <span>Error</span>
                  <HeaderButton
                    type="button"
                    onClick={() => void copyErrorToClipboard(errorResult.error)}
                    active={copiedError}
                  >
                    {copiedError ? "Copied" : "Copy"}
                  </HeaderButton>
                </DetailLabel>
                <ErrorOutput error={errorResult.error} />
              </DetailSection>

              {errorNote && (
                <DetailSection>
                  <DetailLabel>Note</DetailLabel>
                  <DetailContent className="px-2 py-1.5">{errorNote}</DetailContent>
                </DetailSection>
              )}
            </>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
