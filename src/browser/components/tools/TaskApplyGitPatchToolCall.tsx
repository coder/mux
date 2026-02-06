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

type TaskApplyGitPatchSuccessResult = Extract<TaskApplyGitPatchToolResult, { success: true }>;
type TaskApplyGitPatchFailureResult = Extract<TaskApplyGitPatchToolResult, { success: false }>;

interface TaskApplyGitPatchToolCallProps {
  args: TaskApplyGitPatchToolArgs;
  /**
   * Tool results may be wrapped as `{ type: "json", value: ... }` (e.g. via streamManager).
   * Treat as unknown and unwrap defensively.
   */
  result?: unknown;
  status?: ToolStatus;
}

function formatCommitCount(count: number): string {
  return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function formatShortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 7) : sha;
}

interface AppliedCommit {
  subject: string;
  sha?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unwrapJsonContainer(value: unknown): unknown {
  let current = value;

  // Tool outputs can be wrapped as `{ type: "json", value: ... }`.
  // Some paths may double-wrap; unwrap a couple layers defensively.
  for (let i = 0; i < 2; i++) {
    if (
      current !== null &&
      typeof current === "object" &&
      "type" in current &&
      (current as { type?: unknown }).type === "json" &&
      "value" in current
    ) {
      current = (current as { value: unknown }).value;
      continue;
    }
    break;
  }

  return current;
}

const MAX_CONFLICT_PATHS_SHOWN = 6;

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const items: string[] = [];
  for (const item of value) {
    const str = readNonEmptyString(item);
    if (str) items.push(str);
  }

  return items.length > 0 ? items : undefined;
}

function readAppliedCommits(result: unknown): AppliedCommit[] | undefined {
  if (!isRecord(result)) return undefined;

  const value = (result as { appliedCommits?: unknown }).appliedCommits;
  if (!Array.isArray(value)) return undefined;

  const commits: AppliedCommit[] = [];
  for (const commit of value) {
    if (!isRecord(commit)) continue;

    const subject = (commit as { subject?: unknown }).subject;
    if (typeof subject !== "string" || subject.length === 0) continue;

    const sha = (commit as { sha?: unknown }).sha;
    commits.push({
      subject,
      sha: typeof sha === "string" && sha.length > 0 ? sha : undefined,
    });
  }

  return commits;
}

function readLegacyAppliedCommitCount(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined;

  const value = (result as { appliedCommitCount?: unknown }).appliedCommitCount;
  return typeof value === "number" ? value : undefined;
}

const CopyableCode: React.FC<{
  value: string;
  displayValue?: string;
  tooltipLabel: string;
  className?: string;
}> = ({ value, displayValue, tooltipLabel, className }) => {
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
          {displayValue ?? value}
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
  const unwrappedResult = unwrapJsonContainer(result);

  const successResult =
    isRecord(unwrappedResult) && unwrappedResult.success === true
      ? (unwrappedResult as TaskApplyGitPatchSuccessResult)
      : null;
  const errorResult =
    isRecord(unwrappedResult) && unwrappedResult.success === false
      ? (unwrappedResult as TaskApplyGitPatchFailureResult)
      : null;

  const taskIdFromResult =
    isRecord(unwrappedResult) &&
    typeof (unwrappedResult as { taskId?: unknown }).taskId === "string"
      ? (unwrappedResult as { taskId: string }).taskId
      : undefined;
  const taskId = taskIdFromResult ?? args.task_id;

  const dryRunFromResult =
    isRecord(unwrappedResult) && typeof unwrappedResult.dryRun === "boolean"
      ? unwrappedResult.dryRun
      : undefined;

  const isDryRun = dryRunFromResult === true || args.dry_run === true;

  // Result schema guarantees appliedCommits, but older persisted history might only have
  // appliedCommitCount. Be defensive and support both.
  const appliedCommits = successResult ? readAppliedCommits(successResult) : undefined;
  const legacyAppliedCommitCount = successResult
    ? readLegacyAppliedCommitCount(successResult)
    : undefined;
  const appliedCommitCount = appliedCommits
    ? appliedCommits.length
    : (legacyAppliedCommitCount ?? 0);

  const errorPreview =
    typeof errorResult?.error === "string" ? errorResult.error.split("\n")[0]?.trim() : undefined;

  // Auto-expand on failures so the user sees actionable notes (git am --continue/--abort, etc.).
  const { expanded, toggleExpanded } = useToolExpansion(Boolean(errorResult));

  const { copied: copiedError, copyToClipboard: copyErrorToClipboard } = useCopyToClipboard();

  const effectiveThreeWay = args.three_way !== false;

  const errorNote = errorResult && "note" in errorResult ? errorResult.note : undefined;

  // Optional structured diagnostics (added to the tool output over time).
  const errorDiagnostics: Record<string, unknown> | null =
    errorResult && isRecord(unwrappedResult) ? unwrappedResult : null;

  const failedPatchSubject = errorDiagnostics
    ? readNonEmptyString(errorDiagnostics.failedPatchSubject)
    : undefined;

  const conflictPaths = errorDiagnostics
    ? readStringArray(errorDiagnostics.conflictPaths)
    : undefined;

  const shownConflictPaths = conflictPaths?.slice(0, MAX_CONFLICT_PATHS_SHOWN);
  const remainingConflictPaths =
    conflictPaths && shownConflictPaths
      ? Math.max(0, conflictPaths.length - shownConflictPaths.length)
      : 0;

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="task_apply_git_patch" />
        <ToolName>Apply patch</ToolName>
        <span className="text-muted ml-1 max-w-40 truncate text-[10px]">{taskId}</span>
        {isDryRun && <span className="text-backgrounded text-[10px] font-medium">dry-run</span>}
        {successResult && (
          <span className="text-secondary ml-2 text-[10px] whitespace-nowrap">
            {formatCommitCount(appliedCommitCount)}
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
                      {formatCommitCount(appliedCommitCount)}
                    </span>
                  </div>
                  {successResult.headCommitSha && (
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="text-secondary shrink-0 font-medium">HEAD:</span>
                      <CopyableCode
                        value={successResult.headCommitSha}
                        displayValue={formatShortSha(successResult.headCommitSha)}
                        tooltipLabel="Copy HEAD SHA"
                      />
                    </div>
                  )}
                </div>
              </DetailSection>

              {appliedCommits && appliedCommits.length > 0 && (
                <DetailSection>
                  <DetailLabel>Commits</DetailLabel>
                  <div className="bg-code-bg flex flex-col gap-1 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
                    {appliedCommits.map((commit, index) => (
                      <div
                        // SHA is intentionally optional (dry-run results omit it).
                        key={`${commit.sha ?? index}-${commit.subject}`}
                        className="flex min-w-0 items-start gap-2"
                      >
                        {commit.sha ? (
                          <CopyableCode
                            value={commit.sha}
                            displayValue={formatShortSha(commit.sha)}
                            tooltipLabel="Copy commit SHA"
                            className="shrink-0"
                          />
                        ) : (
                          <span className="text-secondary shrink-0 font-mono text-[11px]">
                            {index + 1}.
                          </span>
                        )}
                        <span className="text-text min-w-0 break-words">{commit.subject}</span>
                      </div>
                    ))}
                  </div>
                </DetailSection>
              )}
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

                {(failedPatchSubject ?? (shownConflictPaths && shownConflictPaths.length > 0)) && (
                  <div className="bg-code-bg mb-2 flex flex-col gap-1 rounded px-2 py-1.5 text-[11px] leading-[1.4]">
                    {failedPatchSubject && (
                      <div className="flex min-w-0 items-start gap-1.5">
                        <span className="text-secondary shrink-0 font-medium">Failed patch:</span>
                        <span className="text-text min-w-0 break-words">{failedPatchSubject}</span>
                      </div>
                    )}
                    {shownConflictPaths && shownConflictPaths.length > 0 && (
                      <div className="flex min-w-0 items-start gap-1.5">
                        <span className="text-secondary shrink-0 font-medium">Conflicts:</span>
                        <span className="text-text min-w-0 font-mono break-words">
                          {shownConflictPaths.join(", ")}
                          {remainingConflictPaths > 0 && (
                            <span className="text-secondary"> +{remainingConflictPaths} more</span>
                          )}
                        </span>
                      </div>
                    )}
                  </div>
                )}

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
