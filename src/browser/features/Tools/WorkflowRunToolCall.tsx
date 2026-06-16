import React, { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { APIContext, type APIClient } from "@/browser/contexts/API";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/browser/components/Dialog/Dialog";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import {
  useOptionalCommandRegistry,
  type CommandAction,
} from "@/browser/contexts/CommandRegistryContext";
import type {
  WorkflowDefinitionDescriptor,
  WorkflowRunEvent,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from "@/common/types/workflow";
import type {
  WorkflowResumeToolArgs,
  WorkflowResumeToolResult,
  WorkflowRunToolArgs,
  WorkflowRunToolResult,
  WorkflowRunToolSuccessResult,
} from "@/common/types/tools";
import assert from "@/common/utils/assert";
import { canRetryWorkflowFromCheckpoint } from "@/common/utils/workflowRetryEligibility";

import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  ToolIcon,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
  useAutoCollapsingToolExpansion,
} from "./Shared/toolUtils";
import { HighlightedCode } from "./Shared/HighlightedCode";
import {
  WorkflowDefinitionCard,
  WorkflowJsonBlock,
  WorkflowKindBadge,
  WorkflowSection,
  WORKFLOW_ACTION_BUTTON_CLASS,
  formatWorkflowSavedMessage,
  type WorkflowPromotionTarget,
} from "./WorkflowDefinitionToolCall";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";

interface WorkflowRunToolCallProps {
  args: WorkflowRunToolArgs;
  result?: WorkflowRunToolResult;
  status?: ToolStatus;
  workspaceId?: string;
  startedAt?: number;
  /** Which tool rendered this card; controls the header icon. */
  toolName?: "workflow_run" | "workflow_resume";
  /**
   * Exact run identity known from the tool args (workflow_resume passes its run_id). Enables
   * direct getRun discovery while executing instead of name+args matching against listRuns.
   */
  knownRunId?: string;
}

type WorkflowRunAction = "interrupt" | "resume" | "retryFromCheckpoint";

function shouldKeepWorkflowActionPolling(input: {
  action: WorkflowRunAction;
  run: WorkflowRunRecord;
  baselineSequence: number;
}): boolean {
  if (input.run.status === "interrupted") {
    return true;
  }
  if (input.action !== "retryFromCheckpoint" || input.run.status !== "failed") {
    return false;
  }
  return getLatestWorkflowEventSequence(input.run) <= input.baselineSequence;
}

async function updateWorkflowRunFromAction(input: {
  api: APIClient;
  workspaceId: string;
  runId: string;
  action: WorkflowRunAction;
  setActionError: React.Dispatch<React.SetStateAction<string | null>>;
  setRefreshedRun: React.Dispatch<React.SetStateAction<WorkflowRunRecord | null>>;
  setResumingRunId: React.Dispatch<React.SetStateAction<string | null>>;
  baselineSequence: number;
}) {
  input.setActionError(null);
  let resumeRequestAccepted = false;
  try {
    const nextRun =
      input.action === "interrupt"
        ? await input.api.workflows.interrupt({
            workspaceId: input.workspaceId,
            runId: input.runId,
          })
        : input.action === "resume"
          ? await input.api.workflows.resume({
              workspaceId: input.workspaceId,
              runId: input.runId,
            })
          : await input.api.workflows.retryFromCheckpoint({
              workspaceId: input.workspaceId,
              runId: input.runId,
            });
    if (input.action === "resume" || input.action === "retryFromCheckpoint") {
      resumeRequestAccepted = true;
      input.setResumingRunId(input.runId);
    }
    if ("id" in nextRun) {
      input.setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
      if (
        !shouldKeepWorkflowActionPolling({
          action: input.action,
          run: nextRun,
          baselineSequence: input.baselineSequence,
        })
      ) {
        input.setResumingRunId(null);
      }
      return;
    }
    const refreshed = await input.api.workflows.getRun({
      workspaceId: input.workspaceId,
      runId: input.runId,
    });
    if (refreshed != null) {
      input.setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, refreshed));
      if (
        !shouldKeepWorkflowActionPolling({
          action: input.action,
          run: refreshed,
          baselineSequence: input.baselineSequence,
        })
      ) {
        input.setResumingRunId(null);
      }
    }
  } catch (error) {
    if (
      (input.action === "resume" || input.action === "retryFromCheckpoint") &&
      !resumeRequestAccepted
    ) {
      input.setResumingRunId(null);
    }
    input.setActionError(
      error instanceof Error ? error.message : `Failed to ${input.action} workflow`
    );
    // A failed action usually means this card's snapshot is stale (e.g. Resume on a run an
    // agent already resumed via workflow_resume -> "already active"). Re-sync best-effort so
    // the card converges to the live status instead of keeping dead-end affordances.
    try {
      const refreshed = await input.api.workflows.getRun({
        workspaceId: input.workspaceId,
        runId: input.runId,
      });
      if (refreshed != null) {
        input.setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, refreshed));
      }
    } catch {
      // Keep the action error visible even when the refresh itself fails.
    }
  }
}

function isWorkflowRunSuccessResult(
  value: WorkflowRunToolResult | undefined
): value is WorkflowRunToolSuccessResult {
  return value != null && !isToolErrorResult(value);
}

function getReportMarkdown(value: unknown): string | null {
  if (value != null && typeof value === "object") {
    const reportMarkdown = (value as Record<string, unknown>).reportMarkdown;
    if (typeof reportMarkdown === "string" && reportMarkdown.trim().length > 0) {
      return reportMarkdown;
    }
  }
  return null;
}

function getStructuredOutput(value: unknown): unknown {
  if (value != null && typeof value === "object") {
    return (value as Record<string, unknown>).structuredOutput;
  }
  return undefined;
}

type WorkflowTaskEvent = Extract<WorkflowRunEvent, { type: "task" }>;
type WorkflowActionEvent = Extract<WorkflowRunEvent, { type: "action" }>;
type WorkflowChildEvent = Extract<WorkflowRunEvent, { type: "workflow" }>;
type WorkflowPatchEvent = Extract<WorkflowRunEvent, { type: "patch" }>;

type WorkflowDisplayRow =
  | { kind: "event"; event: WorkflowRunEvent }
  | { kind: "task"; firstEvent: WorkflowTaskEvent; latestEvent: WorkflowTaskEvent }
  | { kind: "action"; firstEvent: WorkflowActionEvent; latestEvent: WorkflowActionEvent }
  | { kind: "workflow"; firstEvent: WorkflowChildEvent; latestEvent: WorkflowChildEvent }
  | { kind: "patch"; firstEvent: WorkflowPatchEvent; latestEvent: WorkflowPatchEvent };

type WorkflowTaskRow = Extract<WorkflowDisplayRow, { kind: "task" }>;
type WorkflowActionRow = Extract<WorkflowDisplayRow, { kind: "action" }>;
type WorkflowChildRow = Extract<WorkflowDisplayRow, { kind: "workflow" }>;
type WorkflowPatchRow = Extract<WorkflowDisplayRow, { kind: "patch" }>;
interface PendingWorkflowActionRows {
  rows: WorkflowActionRow[];
  ambiguous: boolean;
}

function getTaskEventKey(event: WorkflowTaskEvent): string {
  return `task:${event.stepId}:${event.taskId}`;
}

function getWorkflowChildEventKey(event: WorkflowChildEvent): string {
  return `workflow:${event.stepId}:${event.runId}`;
}

function getPatchEventKey(event: WorkflowPatchEvent): string {
  return `patch:${event.stepId}:${event.sourceTaskId}`;
}

function getActionEventKey(event: WorkflowActionEvent): string {
  return JSON.stringify([
    "action",
    event.stepId,
    event.name,
    event.effect,
    event.sourcePath ?? "",
    event.sourceHash ?? "",
  ]);
}

function createWorkflowActionRow(event: WorkflowActionEvent): WorkflowActionRow {
  return {
    kind: "action",
    firstEvent: event,
    latestEvent: event,
  };
}

function getPendingActionRows(
  actionRows: Map<string, PendingWorkflowActionRows>,
  key: string
): PendingWorkflowActionRows {
  const existingRows = actionRows.get(key);
  if (existingRows != null) {
    return existingRows;
  }
  const createdRows: PendingWorkflowActionRows = { rows: [], ambiguous: false };
  actionRows.set(key, createdRows);
  return createdRows;
}

function canCoalesceWorkflowActionTerminal(event: WorkflowActionEvent): boolean {
  return event.status === "completed" || event.status === "failed" || event.status === "reconciled";
}

function getWorkflowDisplayRows(events: readonly WorkflowRunEvent[]): WorkflowDisplayRow[] {
  const rows: WorkflowDisplayRow[] = [];
  const taskRows = new Map<string, WorkflowTaskRow>();
  const actionRows = new Map<string, PendingWorkflowActionRows>();
  const workflowRows = new Map<string, WorkflowChildRow>();
  const patchRows = new Map<string, WorkflowPatchRow>();

  for (const event of events) {
    if (event.type === "status" || event.type === "result") {
      continue;
    }
    if (event.type === "task") {
      const key = getTaskEventKey(event);
      const existingRow = taskRows.get(key);
      if (existingRow != null) {
        existingRow.latestEvent = event;
        continue;
      }

      const row: WorkflowTaskRow = {
        kind: "task",
        firstEvent: event,
        latestEvent: event,
      };
      taskRows.set(key, row);
      rows.push(row);
      continue;
    }

    if (event.type === "workflow") {
      const key = getWorkflowChildEventKey(event);
      const existingRow = workflowRows.get(key);
      if (existingRow != null) {
        existingRow.latestEvent = event;
        continue;
      }

      const row: WorkflowChildRow = {
        kind: "workflow",
        firstEvent: event,
        latestEvent: event,
      };
      workflowRows.set(key, row);
      rows.push(row);
      continue;
    }

    if (event.type === "patch") {
      // A patch step emits started → applied/conflict/failed for the same
      // stepId+sourceTaskId; collapse them into one row (latest status wins),
      // mirroring task-row coalescing.
      const key = getPatchEventKey(event);
      const existingRow = patchRows.get(key);
      if (existingRow != null) {
        existingRow.latestEvent = event;
        continue;
      }

      const row: WorkflowPatchRow = {
        kind: "patch",
        firstEvent: event,
        latestEvent: event,
      };
      patchRows.set(key, row);
      rows.push(row);
      continue;
    }

    if (event.type === "action") {
      const key = getActionEventKey(event);
      if (event.status === "started") {
        const pendingRows = getPendingActionRows(actionRows, key);
        if (pendingRows.rows.length > 0) {
          pendingRows.ambiguous = true;
        }
        const row = createWorkflowActionRow(event);
        pendingRows.rows.push(row);
        rows.push(row);
        continue;
      }

      if (!canCoalesceWorkflowActionTerminal(event)) {
        rows.push(createWorkflowActionRow(event));
        continue;
      }

      const pendingRows = actionRows.get(key);
      if (pendingRows == null) {
        rows.push(createWorkflowActionRow(event));
        continue;
      }

      if (pendingRows.rows.length === 1 && !pendingRows.ambiguous) {
        const row = pendingRows.rows.at(0);
        if (row == null) {
          throw new Error("Expected pending action row to exist");
        }
        row.latestEvent = event;
        actionRows.delete(key);
        continue;
      }

      if (pendingRows.rows.length > 0) {
        // Ambiguous persisted streams cannot be paired without invocation IDs; keep raw rows
        // instead of merging terminal details into the wrong action start row.
        pendingRows.ambiguous = true;
        pendingRows.rows.shift();
        if (pendingRows.rows.length === 0) {
          actionRows.delete(key);
        }
      }
      rows.push(createWorkflowActionRow(event));
      continue;
    }

    rows.push({ kind: "event", event });
  }
  return rows;
}

function getDisplayRowKey(row: WorkflowDisplayRow): string {
  if (row.kind === "task") {
    return getTaskEventKey(row.firstEvent);
  }
  if (row.kind === "action") {
    return `${getActionEventKey(row.firstEvent)}:${row.firstEvent.sequence}`;
  }
  if (row.kind === "workflow") {
    return getWorkflowChildEventKey(row.firstEvent);
  }
  if (row.kind === "patch") {
    return getPatchEventKey(row.firstEvent);
  }
  return getEventKey(row.event);
}
function getEventKey(event: WorkflowRunEvent): string {
  return `${event.sequence}:${event.type}`;
}

function getWorkflowEventLabel(event: WorkflowRunEvent): string {
  switch (event.type) {
    case "phase":
      return event.name;
    case "log":
      return event.message;
    case "task":
      // Prefer the human-readable sub-agent title (matches the spawned
      // workspace title); fall back to stepId for legacy events without one.
      return `${event.title ?? event.stepId} / ${event.taskId} / ${event.status}`;
    case "workflow":
      return `${event.stepId} / ${event.name} / ${event.runId} / ${event.status}`;
    case "patch":
      return `${event.stepId} / ${event.sourceTaskId} / ${event.status}`;
    case "action":
      return `${event.stepId} / ${event.name} / ${event.status}`;
    case "validation": {
      const verdict = event.success ? "passed" : "failed";
      return event.message
        ? `${event.stepId} validation ${verdict}: ${event.message}`
        : `${event.stepId} validation ${verdict}`;
    }
    case "error":
      return event.message;
    case "status":
      return event.status;
    case "result":
      return "Result recorded";
  }
}

function getWorkflowEventDetail(event: WorkflowRunEvent): unknown {
  switch (event.type) {
    case "phase":
      return event.details;
    case "log":
      return event.data;
    case "result":
      return event.result;
    case "workflow":
      return event.details;
    case "patch":
      return event.details;
    case "action":
      return event.details;
    case "task":
    case "validation":
    case "error":
    case "status":
      return undefined;
  }
}

function getEventTone(event: WorkflowRunEvent): "normal" | "success" | "warning" {
  if (event.type === "error") {
    return "warning";
  }
  if (event.type === "validation") {
    return event.success ? "success" : "warning";
  }
  if (event.type === "patch") {
    return event.status === "applied"
      ? "success"
      : event.status === "started"
        ? "normal"
        : "warning";
  }
  if (event.type === "action") {
    if (
      event.status === "completed" ||
      event.status === "cached" ||
      event.status === "reconciled"
    ) {
      return "success";
    }
    return event.status === "failed" ? "warning" : "normal";
  }
  if (event.type === "workflow") {
    return event.status === "completed"
      ? "success"
      : event.status === "failed" || event.status === "interrupted"
        ? "warning"
        : "normal";
  }
  if (event.type === "result") {
    return "success";
  }
  return "normal";
}

function getEventToneClass(event: WorkflowRunEvent): string {
  switch (getEventTone(event)) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "normal":
      return "text-muted";
  }
}

function WorkflowDisclosureSection(props: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={`group mb-2 ${props.className ?? ""}`}>
      <summary className="text-muted hover:text-foreground flex cursor-pointer list-none items-center gap-2 text-[10px] tracking-wide uppercase [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90">▶</span>
        <span>{props.title}</span>
      </summary>
      <div className="mt-1">{props.children}</div>
    </details>
  );
}

function getEventRowClass(event: WorkflowRunEvent): string {
  if (event.type === "phase") {
    return "border-l-2 border-plan-mode/70 bg-plan-mode-alpha";
  }
  return "border-l-2 border-transparent";
}

function getEventTypeClass(event: WorkflowRunEvent): string {
  if (event.type === "phase") {
    return "rounded border border-plan-mode/40 bg-plan-mode-alpha px-1 py-0.5 text-plan-mode-light";
  }
  return getEventToneClass(event);
}

function findTaskStepForEvent(
  event: WorkflowRunEvent,
  steps: readonly WorkflowStepRecord[]
): WorkflowStepRecord | null {
  if (event.type !== "task") {
    return null;
  }

  return steps.find((step) => step.taskId === event.taskId && step.stepId === event.stepId) ?? null;
}

function getTaskReportMarkdown(
  event: WorkflowRunEvent,
  steps: readonly WorkflowStepRecord[]
): string | null {
  const step = findTaskStepForEvent(event, steps);
  const reportMarkdown = step?.result?.reportMarkdown;
  return typeof reportMarkdown === "string" && reportMarkdown.trim().length > 0
    ? reportMarkdown
    : null;
}

function getTaskStructuredOutput(
  event: WorkflowRunEvent,
  steps: readonly WorkflowStepRecord[]
): unknown {
  const step = findTaskStepForEvent(event, steps);
  return step?.result?.structuredOutput;
}

function WorkflowEventTooltip(props: {
  event: WorkflowRunEvent;
  displayIndex: number;
  label: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-muted counter-nums-mono text-[10px]">
        Display #{props.displayIndex} · Raw event #{props.event.sequence}
      </div>
      <div className="text-foreground text-[11px] leading-snug">{props.label}</div>
    </div>
  );
}

function getWorkflowMergedRowDetail(
  row: WorkflowActionRow | WorkflowChildRow | WorkflowPatchRow
): unknown {
  const firstDetail = getWorkflowEventDetail(row.firstEvent);
  const latestDetail = getWorkflowEventDetail(row.latestEvent);
  if (row.firstEvent === row.latestEvent || row.latestEvent.status === "started") {
    return latestDetail;
  }
  if (firstDetail === undefined) {
    return latestDetail;
  }
  if (latestDetail === undefined) {
    return { started: firstDetail };
  }
  return { started: firstDetail, [row.latestEvent.status]: latestDetail };
}

function WorkflowEventRow(props: {
  event: WorkflowRunEvent;
  displayIndex: number;
  steps: readonly WorkflowStepRecord[];
  detailOverride?: unknown;
  tooltipEvent?: WorkflowRunEvent;
}) {
  const event = props.event;
  const tooltipEvent = props.tooltipEvent ?? event;
  const detail =
    props.detailOverride !== undefined ? props.detailOverride : getWorkflowEventDetail(event);
  const taskReportMarkdown = getTaskReportMarkdown(event, props.steps);
  const isExpandable = detail !== undefined || taskReportMarkdown != null;
  const clickableCursorClass = isExpandable ? "cursor-pointer" : "";
  const label = getWorkflowEventLabel(event);
  const row = (
    <div
      className={`grid ${clickableCursorClass} grid-cols-[3rem_4.75rem_minmax(0,1fr)] items-center gap-2 px-2 py-1 text-[10px] ${getEventRowClass(event)}`}
    >
      {/* Keep the tooltip trigger on the sequence cell so expandable row text still advertises clickability. */}
      <TooltipIfPresent
        tooltip={
          <WorkflowEventTooltip
            event={tooltipEvent}
            displayIndex={props.displayIndex}
            label={label}
          />
        }
        side="top"
        align="start"
      >
        <span
          className="text-muted counter-nums-mono w-fit cursor-help"
          aria-label={`Raw event #${tooltipEvent.sequence}`}
        >
          #{props.displayIndex}
        </span>
      </TooltipIfPresent>
      <span
        className={`w-fit ${clickableCursorClass} font-mono uppercase ${getEventTypeClass(event)}`}
      >
        {event.type}
      </span>
      <span className={`text-foreground ${clickableCursorClass} truncate`}>{label}</span>
    </div>
  );

  if (!isExpandable) {
    return <li className="hover:bg-background/50">{row}</li>;
  }

  return (
    <li className="hover:bg-background/50">
      <details className="group">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {row}
        </summary>
        {taskReportMarkdown != null ? (
          <div className="border-border bg-background/40 mx-2 mb-2 rounded border p-2 text-[11px]">
            <MarkdownRenderer content={taskReportMarkdown} />
          </div>
        ) : (
          <WorkflowJsonBlock value={detail} className="mx-2 mb-2 max-h-[140px]" />
        )}
      </details>
    </li>
  );
}

function WorkflowTaskReportDialogContent(props: {
  taskId: string;
  title: string;
  reportMarkdown: string;
}) {
  assert(
    props.reportMarkdown.trim().length > 0,
    "WorkflowTaskReportDialogContent requires non-empty report markdown"
  );

  return (
    <DialogContent className="flex max-h-[80vh] min-h-0 max-w-5xl flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle className="flex flex-col gap-1">
          <span>Task report</span>
          <span className="text-muted flex flex-wrap items-baseline gap-2 text-[11px] font-normal">
            <span>{props.title}</span>
            <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] leading-none">
              {props.taskId}
            </code>
          </span>
        </DialogTitle>
      </DialogHeader>

      <div className="min-h-0 flex-1 overflow-y-auto rounded bg-[var(--color-bg-secondary)] p-3">
        <MarkdownRenderer content={props.reportMarkdown} />
      </div>
    </DialogContent>
  );
}

function shouldShowWorkflowTaskOpenAffordance(
  event: WorkflowRunEvent
): event is Extract<WorkflowRunEvent, { type: "task" }> {
  return event.type === "task" && event.status === "started";
}

// Workflow history can outlive child task workspaces, so only render navigation
// affordances when the live workspace registry still contains the task id.
function useWorkflowTaskWorkspaceAvailable(taskId: string): boolean {
  const workspaceStore = useWorkspaceStoreRaw();
  return useSyncExternalStore(
    workspaceStore.subscribeDerived,
    () => workspaceStore.getWorkspaceMetadata(taskId) != null,
    () => false
  );
}

function WorkflowTaskRow(props: {
  row: Extract<WorkflowDisplayRow, { kind: "task" }>;
  displayIndex: number;
  steps: readonly WorkflowStepRecord[];
  onNavigate: (taskId: string) => void;
  onOpenReport: () => void;
  onInspectStructuredOutput: () => void;
}) {
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [structuredOutputExpanded, setStructuredOutputExpanded] = useState(false);
  const event = props.row.latestEvent;
  const label = getWorkflowEventLabel(event);
  const taskReportMarkdown = getTaskReportMarkdown(event, props.steps);
  const taskStructuredOutput = getTaskStructuredOutput(event, props.steps);
  const taskWorkspaceAvailable = useWorkflowTaskWorkspaceAvailable(event.taskId);
  // Completed task rows inspect structured output inline; keep workspace navigation as a separate action.
  const canExpandStructuredOutput =
    event.status === "completed" && taskStructuredOutput !== undefined;
  const canNavigateViaRow = !canExpandStructuredOutput && taskWorkspaceAvailable;
  const taskRowInteractive = canExpandStructuredOutput || canNavigateViaRow;
  const showWorkspaceAction = canExpandStructuredOutput && taskWorkspaceAvailable;
  const showOpenAffordance =
    taskReportMarkdown == null && canNavigateViaRow && shouldShowWorkflowTaskOpenAffordance(event);
  const toggleStructuredOutput = () => {
    props.onInspectStructuredOutput();
    setStructuredOutputExpanded((isExpanded) => !isExpanded);
  };
  const activateTaskRow = () => {
    if (canExpandStructuredOutput) {
      toggleStructuredOutput();
      return;
    }
    if (taskWorkspaceAvailable) {
      props.onNavigate(event.taskId);
    }
  };
  const handleReportDialogOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      props.onOpenReport();
    }
    setReportDialogOpen(isOpen);
  };
  const onKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (keyboardEvent) => {
    if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
      return;
    }
    keyboardEvent.preventDefault();
    activateTaskRow();
  };
  const taskRowAriaLabel = canExpandStructuredOutput
    ? `${structuredOutputExpanded ? "Collapse" : "Expand"} structured output for workflow task ${event.taskId}`
    : canNavigateViaRow
      ? `Open workflow task ${event.taskId}`
      : undefined;

  const taskRow = (
    <div
      className={`grid items-center gap-2 border-l-2 border-transparent px-2 py-1 text-[10px] ${
        taskRowInteractive ? "cursor-pointer" : ""
      } ${
        showOpenAffordance
          ? "grid-cols-[3rem_4.75rem_minmax(0,1fr)_auto]"
          : "grid-cols-[3rem_4.75rem_minmax(0,1fr)]"
      }`}
      role={taskRowInteractive ? "button" : undefined}
      tabIndex={taskRowInteractive ? 0 : undefined}
      aria-expanded={canExpandStructuredOutput ? structuredOutputExpanded : undefined}
      aria-label={taskRowAriaLabel}
      onClick={taskRowInteractive ? activateTaskRow : undefined}
      onKeyDown={taskRowInteractive ? onKeyDown : undefined}
    >
      <TooltipIfPresent
        tooltip={
          <WorkflowEventTooltip
            event={props.row.firstEvent}
            displayIndex={props.displayIndex}
            label={label}
          />
        }
        side="top"
        align="start"
      >
        <span
          className="text-muted counter-nums-mono w-fit cursor-help"
          aria-label={`Raw event #${props.row.firstEvent.sequence}`}
        >
          #{props.displayIndex}
        </span>
      </TooltipIfPresent>
      <span className={`w-fit font-mono uppercase ${getEventTypeClass(event)}`}>{event.type}</span>
      <span className="text-foreground truncate">{label}</span>
      {/* Keep Open visual-only so the task row remains the single keyboard target. */}
      {showOpenAffordance ? (
        <span
          className={`${WORKFLOW_ACTION_BUTTON_CLASS} pointer-events-none inline-flex items-center px-1.5 py-0.5 text-[10px] whitespace-nowrap`}
          aria-hidden="true"
        >
          Open
        </span>
      ) : null}
    </div>
  );

  const workspaceAction = showWorkspaceAction ? (
    <button
      type="button"
      className={`${WORKFLOW_ACTION_BUTTON_CLASS} inline-flex items-center px-1.5 py-0.5 text-[10px] whitespace-nowrap`}
      aria-label={`Open task workspace for ${event.taskId}`}
      onClick={() => props.onNavigate(event.taskId)}
    >
      Workspace
    </button>
  ) : null;

  return (
    <li className="hover:bg-background/50">
      {taskReportMarkdown != null ? (
        <Dialog open={reportDialogOpen} onOpenChange={handleReportDialogOpenChange}>
          <div
            className={`grid ${
              showWorkspaceAction
                ? "grid-cols-[minmax(0,1fr)_auto_auto]"
                : "grid-cols-[minmax(0,1fr)_auto]"
            } items-center gap-1 pr-2`}
          >
            {taskRow}
            {workspaceAction}
            <DialogTrigger asChild>
              <button
                type="button"
                className={`${WORKFLOW_ACTION_BUTTON_CLASS} inline-flex items-center px-1.5 py-0.5 text-[10px] whitespace-nowrap`}
                aria-label={`Open report for ${event.taskId}`}
              >
                Report
              </button>
            </DialogTrigger>
          </div>
          <WorkflowTaskReportDialogContent
            taskId={event.taskId}
            title={label}
            reportMarkdown={taskReportMarkdown}
          />
        </Dialog>
      ) : showWorkspaceAction ? (
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1 pr-2">
          {taskRow}
          {workspaceAction}
        </div>
      ) : (
        taskRow
      )}
      {canExpandStructuredOutput && structuredOutputExpanded ? (
        <div className="mx-2 mb-2 space-y-1">
          <div className="text-muted text-[10px] tracking-wide uppercase">Structured output</div>
          {/* The inline JSON is height-capped, so name/focus its own scroll region for keyboard users. */}
          <WorkflowJsonBlock
            value={taskStructuredOutput}
            className="max-h-[180px]"
            ariaLabel={`Structured output for workflow task ${event.taskId}`}
          />
        </div>
      ) : null}
    </li>
  );
}

const AUTO_COLLAPSE_WORKFLOW_STATUSES = new Set(["completed"]);

const REFRESHING_WORKFLOW_STATUSES = new Set(["pending", "running", "backgrounded"]);

const FOREGROUND_WORKFLOW_DISCOVERY_SKEW_MS = 1_000;

const DISCOVERABLE_FOREGROUND_WORKFLOW_STATUSES = new Set(["pending", "running", "backgrounded"]);

function getWorkflowRunTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function stringifyWorkflowArgs(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function workflowArgsEqual(left: unknown, right: unknown): boolean {
  const leftJson = stringifyWorkflowArgs(left);
  const rightJson = stringifyWorkflowArgs(right);
  return leftJson != null && rightJson != null && leftJson === rightJson;
}

function isFreshEnoughForToolCall(run: WorkflowRunRecord, startedAt: number | undefined): boolean {
  if (startedAt == null) {
    return true;
  }
  const createdAt = getWorkflowRunTimestamp(run.createdAt);
  if (createdAt == null) {
    return true;
  }
  // Tool-call timestamps are monotonic stream timestamps; run.createdAt is workflow-service wall
  // time. Allow a small skew for same-tick creation without accepting clearly stale runs.
  return createdAt >= startedAt - FOREGROUND_WORKFLOW_DISCOVERY_SKEW_MS;
}

function getLatestWorkflowEventSequence(run: WorkflowRunRecord | null | undefined): number {
  return run?.events.reduce((maxSequence, event) => Math.max(maxSequence, event.sequence), 0) ?? 0;
}

function compareWorkflowRunSnapshots(left: WorkflowRunRecord, right: WorkflowRunRecord): number {
  const leftUpdatedAt = getWorkflowRunTimestamp(left.updatedAt);
  const rightUpdatedAt = getWorkflowRunTimestamp(right.updatedAt);
  if (leftUpdatedAt != null && rightUpdatedAt != null && leftUpdatedAt !== rightUpdatedAt) {
    return leftUpdatedAt - rightUpdatedAt;
  }
  if (leftUpdatedAt != null && rightUpdatedAt == null) {
    return 1;
  }
  if (leftUpdatedAt == null && rightUpdatedAt != null) {
    return -1;
  }
  return getLatestWorkflowEventSequence(left) - getLatestWorkflowEventSequence(right);
}

function getNewestWorkflowRunSnapshot(
  current: WorkflowRunRecord | null,
  next: WorkflowRunRecord
): WorkflowRunRecord {
  if (current == null || current.id !== next.id) {
    return next;
  }
  return compareWorkflowRunSnapshots(current, next) > 0 ? current : next;
}

function findForegroundWorkflowRun(input: {
  runs: readonly WorkflowRunRecord[];
  args: WorkflowRunToolArgs;
  startedAt?: number;
}): WorkflowRunRecord | null {
  assert(input.args.name.length > 0, "findForegroundWorkflowRun requires a workflow name");
  const invocationArgs = input.args.args ?? {};
  const candidates = input.runs.filter(
    (run) =>
      run.definition.name === input.args.name &&
      DISCOVERABLE_FOREGROUND_WORKFLOW_STATUSES.has(run.status) &&
      workflowArgsEqual(run.args ?? {}, invocationArgs) &&
      isFreshEnoughForToolCall(run, input.startedAt)
  );
  if (candidates.length !== 1) {
    return null;
  }
  return candidates[0] ?? null;
}

function selectWorkflowRunSnapshot(input: {
  runId?: string;
  baseRun?: WorkflowRunRecord;
  refreshedRun: WorkflowRunRecord | null;
}): { runId?: string; run?: WorkflowRunRecord } {
  const runId = input.runId ?? input.baseRun?.id ?? input.refreshedRun?.id;
  if (runId == null) {
    return {};
  }
  if (input.refreshedRun?.id !== runId) {
    return input.baseRun == null ? { runId } : { runId, run: input.baseRun };
  }
  if (input.baseRun?.id !== runId) {
    return { runId, run: input.refreshedRun };
  }
  return {
    runId,
    run:
      compareWorkflowRunSnapshots(input.refreshedRun, input.baseRun) >= 0
        ? input.refreshedRun
        : input.baseRun,
  };
}

function getLatestResultEvent(run: WorkflowRunRecord | null | undefined): unknown {
  return run?.events.findLast((event) => event.type === "result")?.result;
}

function shouldRefreshWorkflow(status: string): boolean {
  return REFRESHING_WORKFLOW_STATUSES.has(status);
}

function toToolStatus(status: string): ToolStatus {
  if (status === "running" || status === "executing") {
    return "executing";
  }
  if (
    status === "pending" ||
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "backgrounded"
  ) {
    return status;
  }
  return "pending";
}

export const WorkflowRunToolCall: React.FC<WorkflowRunToolCallProps> = ({
  args,
  result,
  status = "pending",
  workspaceId,
  startedAt,
  toolName = "workflow_run",
  knownRunId,
}) => {
  const apiState = useContext(APIContext);
  const commandRegistry = useOptionalCommandRegistry();
  const registerCommandSource = commandRegistry?.registerSource;
  const errorResult = isToolErrorResult(result) ? result : null;
  const successResult = isWorkflowRunSuccessResult(result) ? result : null;
  const [refreshedRun, setRefreshedRun] = useState<WorkflowRunRecord | null>(null);
  const [resumingRunId, setResumingRunId] = useState<string | null>(null);
  const [workflowActionInFlightRunId, setWorkflowActionInFlightRunId] = useState<string | null>(
    null
  );
  const workflowActionInFlightRunIdRef = useRef<string | null>(null);
  const setWorkflowActionInFlight = (nextRunId: string | null) => {
    workflowActionInFlightRunIdRef.current = nextRunId;
    setWorkflowActionInFlightRunId(nextRunId);
  };
  const baseRun = successResult?.run;
  const selectedRun = selectWorkflowRunSnapshot({
    // knownRunId (workflow_resume) provides exact identity before any result arrives, which
    // also disables the heuristic name+args foreground discovery below.
    runId: successResult?.runId ?? knownRunId,
    baseRun,
    refreshedRun,
  });
  const runId = selectedRun.runId;
  const run = selectedRun.run;
  const displayStatus = run?.status ?? successResult?.status ?? status;
  const displayEventSequence = getLatestWorkflowEventSequence(run);
  const resultValue = successResult?.result ?? getLatestResultEvent(run);
  const reportMarkdown = getReportMarkdown(resultValue);
  const structuredOutput = getStructuredOutput(resultValue);
  const invocationArgs = run?.args ?? args.args ?? {};
  const events = run?.events ?? [];
  const displayRows = getWorkflowDisplayRows(events);
  const headerStatus = toToolStatus(displayStatus);
  const workspaceStore = useWorkspaceStoreRaw();
  const {
    expanded,
    setLocalExpanded,
    toggleExpanded,
    markInteracted: markExpansionInteracted,
  } = useAutoCollapsingToolExpansion(true, {
    // Completed workflow runs can contain large reports and event logs. Collapse them for
    // scanability without persisting that automatic presentation choice as user intent.
    autoCollapsed: AUTO_COLLAPSE_WORKFLOW_STATUSES.has(displayStatus),
    resetKey: runId,
  });

  const toggleWorkflowExpanded = () => {
    toggleExpanded();
  };

  const [actionError, setActionError] = useState<string | null>(null);
  const [promotedDefinition, setPromotedDefinition] = useState<WorkflowDefinitionDescriptor | null>(
    null
  );
  const [savingPromotionTarget, setSavingPromotionTarget] =
    useState<WorkflowPromotionTarget | null>(null);
  const savingPromotionTargetRef = useRef<WorkflowPromotionTarget | null>(null);
  const resumeOrRetryPendingForRun =
    runId != null && (resumingRunId === runId || workflowActionInFlightRunId === runId);
  const displayDefinition = promotedDefinition ?? run?.definition;
  // workflow_resume cards only know the run ID until a snapshot loads; prefer the real
  // workflow name once available.
  const displayName = displayDefinition?.name ?? args.name;
  // A uniquely discovered foreground run is actionable before the blocking tool call returns.
  const discoveredForegroundRunConfirmed =
    status === "executing" &&
    args.run_in_background !== true &&
    workspaceId != null &&
    refreshedRun != null &&
    runId === refreshedRun.id &&
    refreshedRun.workspaceId === workspaceId;
  // knownRunId comes from the tool args themselves, so a fetched snapshot with a matching
  // ID confirms identity regardless of foreground/background mode.
  const discoveredKnownRunConfirmed =
    knownRunId != null &&
    workspaceId != null &&
    refreshedRun?.id === knownRunId &&
    refreshedRun.workspaceId === workspaceId;
  const runIdentityConfirmed =
    successResult?.runId != null ||
    baseRun?.id != null ||
    discoveredForegroundRunConfirmed ||
    discoveredKnownRunConfirmed;
  const canInterrupt =
    runIdentityConfirmed &&
    apiState?.api != null &&
    run?.workspaceId != null &&
    (displayStatus === "running" || displayStatus === "backgrounded");
  const canResume =
    runIdentityConfirmed &&
    apiState?.api != null &&
    run?.workspaceId != null &&
    displayStatus === "interrupted" &&
    !resumeOrRetryPendingForRun;
  const canRetryFromCheckpoint =
    runIdentityConfirmed &&
    apiState?.api != null &&
    run?.workspaceId != null &&
    canRetryWorkflowFromCheckpoint(run) &&
    !resumeOrRetryPendingForRun;
  const canPromote =
    runIdentityConfirmed &&
    run?.workspaceId != null &&
    run.definition.scope === "scratch" &&
    promotedDefinition == null;
  const canSavePromotedWorkflow =
    apiState?.api != null &&
    runId != null &&
    canPromote &&
    savingPromotionTarget == null &&
    savingPromotionTargetRef.current == null;

  const updateRunFromAction = async (action: WorkflowRunAction) => {
    if (apiState?.api == null || run?.workspaceId == null || runId == null) {
      return;
    }
    const isResumeOrRetry = action === "resume" || action === "retryFromCheckpoint";
    if (isResumeOrRetry) {
      if (workflowActionInFlightRunIdRef.current === runId || resumingRunId === runId) {
        return;
      }
      setWorkflowActionInFlight(runId);
    }
    try {
      await updateWorkflowRunFromAction({
        api: apiState.api,
        workspaceId: run.workspaceId,
        runId,
        action,
        setActionError,
        setRefreshedRun,
        setResumingRunId,
        baselineSequence: getLatestWorkflowEventSequence(run),
      });
    } finally {
      if (isResumeOrRetry) {
        setWorkflowActionInFlight(null);
      }
    }
  };

  const updateRunFromActionRef = useRef(updateRunFromAction);
  updateRunFromActionRef.current = updateRunFromAction;

  const saveScratchWorkflow = (location: WorkflowPromotionTarget) => {
    const api = apiState?.api;
    const sourceDefinition = run?.definition;
    if (
      api == null ||
      run?.workspaceId == null ||
      runId == null ||
      sourceDefinition == null ||
      !canPromote ||
      savingPromotionTargetRef.current != null
    ) {
      return;
    }

    assert(sourceDefinition.scope === "scratch", "Only scratch workflow runs can be saved");
    setActionError(null);
    setSavingPromotionTarget(location);
    savingPromotionTargetRef.current = location;
    api.workflows
      .promoteScratch({
        workspaceId: run.workspaceId,
        runId,
        name: sourceDefinition.name,
        description: sourceDefinition.description,
        location,
        overwrite: false,
      })
      .then((descriptor) => {
        assert(
          descriptor.scope === location,
          "promoteScratch returned a descriptor for a different location"
        );
        setPromotedDefinition(descriptor);
      })
      .catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : "Failed to save workflow");
      })
      .finally(() => {
        savingPromotionTargetRef.current = null;
        setSavingPromotionTarget(null);
      });
  };

  useEffect(() => {
    // Checkpoint retries briefly keep showing the old failed snapshot until polling observes a
    // post-retry event sequence, so don't clear that pending marker just because status is failed.
    if (
      resumingRunId === runId &&
      run?.status !== "interrupted" &&
      !(run?.status === "failed" && canRetryWorkflowFromCheckpoint(run))
    ) {
      setResumingRunId(null);
    }
  }, [resumingRunId, run, runId]);

  const saveScratchWorkflowRef = useRef(saveScratchWorkflow);
  saveScratchWorkflowRef.current = saveScratchWorkflow;

  useEffect(() => {
    if (registerCommandSource == null || runId == null || run?.workspaceId == null) {
      return;
    }

    const unregister = registerCommandSource(() => {
      const subtitle = `${displayName} • ${runId}`;
      const actions: CommandAction[] = [];
      if (canInterrupt) {
        actions.push({
          id: `workflow:${runId}:interrupt`,
          title: `Interrupt workflow: ${displayName}`,
          subtitle,
          section: "Workflows",
          keywords: ["workflow", "interrupt", "stop", displayName, runId],
          run: () => updateRunFromActionRef.current("interrupt"),
        });
      }
      if (canResume) {
        actions.push({
          id: `workflow:${runId}:resume`,
          title: `Resume workflow: ${displayName}`,
          subtitle,
          section: "Workflows",
          keywords: ["workflow", "resume", "continue", displayName, runId],
          run: () => updateRunFromActionRef.current("resume"),
        });
      }
      if (canRetryFromCheckpoint) {
        actions.push({
          id: `workflow:${runId}:retry-from-checkpoint`,
          title: `Retry workflow from checkpoint: ${displayName}`,
          subtitle,
          section: "Workflows",
          keywords: ["workflow", "retry", "resume", "checkpoint", displayName, runId],
          run: () => updateRunFromActionRef.current("retryFromCheckpoint"),
        });
      }
      if (canPromote) {
        actions.push(
          {
            id: `workflow:${runId}:save-project`,
            title: `Save workflow to project workflows: ${displayName}`,
            subtitle,
            section: "Workflows",
            keywords: ["workflow", "save", "project", "scratch", displayName, runId],
            run: () => {
              setLocalExpanded(true);
              saveScratchWorkflowRef.current("project");
            },
          },
          {
            id: `workflow:${runId}:save-global`,
            title: `Save workflow to global workflows: ${displayName}`,
            subtitle,
            section: "Workflows",
            keywords: ["workflow", "save", "global", "scratch", displayName, runId],
            run: () => {
              setLocalExpanded(true);
              saveScratchWorkflowRef.current("global");
            },
          }
        );
      }
      return actions;
    });

    return unregister;
  }, [
    apiState?.api,
    displayName,
    canInterrupt,
    canRetryFromCheckpoint,
    canPromote,
    canResume,
    resumeOrRetryPendingForRun,
    registerCommandSource,
    run?.workspaceId,
    runId,
    setLocalExpanded,
  ]);

  useEffect(() => {
    if (
      apiState?.api == null ||
      workspaceId == null ||
      runId != null ||
      status !== "executing" ||
      args.run_in_background === true
    ) {
      return;
    }

    let ignore = false;
    const discover = async () => {
      try {
        const runs = await apiState.api.workflows.listRuns({ workspaceId });
        const foregroundRun = findForegroundWorkflowRun({ runs, args, startedAt });
        if (!ignore && foregroundRun != null) {
          setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, foregroundRun));
        }
      } catch (error) {
        console.error("Failed to discover foreground workflow run:", error);
      }
    };

    void discover();
    const interval = window.setInterval(() => {
      void discover();
    }, 2_000);
    return () => {
      ignore = true;
      window.clearInterval(interval);
    };
  }, [apiState?.api, args, runId, startedAt, status, workspaceId]);

  useEffect(() => {
    // workflow_resume knows the exact run from its args, so fetch the live snapshot by ID
    // while the tool call executes. Keep polling even after a snapshot loads: the first
    // poll can race the backend's `running` append and capture the stale pre-resume
    // status (interrupted/failed), which the regular refresh effect never polls. Hand off
    // only once the snapshot reaches a status the regular refresh effect covers.
    if (
      apiState?.api == null ||
      workspaceId == null ||
      knownRunId == null ||
      (run != null && REFRESHING_WORKFLOW_STATUSES.has(run.status)) ||
      status !== "executing"
    ) {
      return;
    }

    let ignore = false;
    const discover = async () => {
      try {
        const nextRun = await apiState.api.workflows.getRun({ workspaceId, runId: knownRunId });
        if (!ignore && nextRun != null) {
          setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
        }
      } catch (error) {
        console.error("Failed to discover workflow run by id:", error);
      }
    };

    void discover();
    const interval = window.setInterval(() => {
      void discover();
    }, 2_000);
    return () => {
      ignore = true;
      window.clearInterval(interval);
    };
  }, [apiState?.api, knownRunId, run, status, workspaceId]);

  useEffect(() => {
    if (
      apiState?.api == null ||
      runId == null ||
      run?.workspaceId == null ||
      (!shouldRefreshWorkflow(displayStatus) && resumingRunId !== runId)
    ) {
      return;
    }

    let ignore = false;
    const refresh = async () => {
      try {
        const nextRun = await apiState.api.workflows.getRun({
          workspaceId: run.workspaceId,
          runId,
        });
        if (!ignore && nextRun != null) {
          setRefreshedRun((current) => getNewestWorkflowRunSnapshot(current, nextRun));
          if (
            !shouldKeepWorkflowActionPolling({
              action: "retryFromCheckpoint",
              run: nextRun,
              baselineSequence: displayEventSequence,
            })
          ) {
            setResumingRunId(null);
          }
        }
      } catch (error) {
        console.error("Failed to refresh workflow run:", error);
      }
    };

    void refresh();
    const interval = window.setInterval(() => {
      void refresh();
    }, 2_000);
    return () => {
      ignore = true;
      window.clearInterval(interval);
    };
  }, [apiState?.api, displayEventSequence, displayStatus, resumingRunId, run?.workspaceId, runId]);

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleWorkflowExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName={toolName} />
        <WorkflowKindBadge />
        <ToolName>{displayName}</ToolName>
        <StatusIndicator status={headerStatus}>{getStatusDisplay(headerStatus)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="text-muted mb-2 flex flex-wrap items-center gap-2 text-[10px]">
            {runId && <span className="font-mono">{runId}</span>}
            <span>{displayStatus}</span>
            {displayDefinition?.scope && <span>{displayDefinition.scope}</span>}
          </div>

          {displayDefinition && (
            <WorkflowSection title="Definition">
              <WorkflowDefinitionCard descriptor={displayDefinition} compact />
            </WorkflowSection>
          )}

          {/* Large workflow payloads stay collapsed so completed runs remain scannable. */}
          <WorkflowDisclosureSection title="Arguments">
            <WorkflowJsonBlock value={invocationArgs} className="max-h-[180px]" />
          </WorkflowDisclosureSection>

          {run?.definitionSource && (
            <WorkflowDisclosureSection title="Definition source">
              <div className="border-border bg-code-bg max-h-[260px] overflow-auto rounded border p-2">
                <HighlightedCode
                  language="javascript"
                  code={run.definitionSource.trimEnd()}
                  showLineNumbers
                />
              </div>
            </WorkflowDisclosureSection>
          )}

          {(canInterrupt || canResume || canRetryFromCheckpoint || canPromote) && (
            <div className="mb-2 flex flex-wrap gap-2 text-[10px]">
              {canInterrupt && (
                <button
                  type="button"
                  className={WORKFLOW_ACTION_BUTTON_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateRunFromAction("interrupt");
                  }}
                >
                  Interrupt workflow
                </button>
              )}
              {canResume && (
                <button
                  type="button"
                  className={WORKFLOW_ACTION_BUTTON_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateRunFromAction("resume");
                  }}
                >
                  Resume workflow
                </button>
              )}
              {canRetryFromCheckpoint && (
                <button
                  type="button"
                  className={WORKFLOW_ACTION_BUTTON_CLASS}
                  onClick={(event) => {
                    event.stopPropagation();
                    void updateRunFromAction("retryFromCheckpoint");
                  }}
                >
                  Retry from checkpoint
                </button>
              )}
              {canPromote && (
                <>
                  <button
                    type="button"
                    className={WORKFLOW_ACTION_BUTTON_CLASS}
                    disabled={!canSavePromotedWorkflow}
                    onClick={(event) => {
                      event.stopPropagation();
                      saveScratchWorkflow("project");
                    }}
                  >
                    {savingPromotionTarget === "project"
                      ? "Saving workflow..."
                      : "Save to project workflows"}
                  </button>
                  <button
                    type="button"
                    className={WORKFLOW_ACTION_BUTTON_CLASS}
                    disabled={!canSavePromotedWorkflow}
                    onClick={(event) => {
                      event.stopPropagation();
                      saveScratchWorkflow("global");
                    }}
                  >
                    {savingPromotionTarget === "global"
                      ? "Saving workflow..."
                      : "Save to global workflows"}
                  </button>
                </>
              )}
            </div>
          )}

          {(promotedDefinition?.scope === "project" || promotedDefinition?.scope === "global") && (
            <div className="text-success mb-2 text-[10px]">
              {formatWorkflowSavedMessage(promotedDefinition.scope)}
            </div>
          )}

          {actionError && <ErrorBox className="mb-2">{actionError}</ErrorBox>}

          {displayRows.length > 0 && (
            <WorkflowSection title={`Workflow events (${displayRows.length})`}>
              <div className="border-border bg-background/20 max-h-[220px] overflow-y-auto rounded border">
                <ol className="divide-border/60 divide-y">
                  {displayRows.map((row, index) => {
                    if (row.kind === "task") {
                      return (
                        <WorkflowTaskRow
                          key={getDisplayRowKey(row)}
                          row={row}
                          displayIndex={index + 1}
                          steps={run?.steps ?? []}
                          onNavigate={(taskId) => workspaceStore.navigateToWorkspace(taskId)}
                          onOpenReport={() => {
                            markExpansionInteracted();
                          }}
                          onInspectStructuredOutput={() => {
                            markExpansionInteracted();
                          }}
                        />
                      );
                    }
                    if (row.kind === "action" || row.kind === "workflow" || row.kind === "patch") {
                      return (
                        <WorkflowEventRow
                          key={getDisplayRowKey(row)}
                          event={row.latestEvent}
                          tooltipEvent={row.firstEvent}
                          detailOverride={getWorkflowMergedRowDetail(row)}
                          displayIndex={index + 1}
                          steps={run?.steps ?? []}
                        />
                      );
                    }
                    return (
                      <WorkflowEventRow
                        key={getDisplayRowKey(row)}
                        event={row.event}
                        displayIndex={index + 1}
                        steps={run?.steps ?? []}
                      />
                    );
                  })}
                </ol>
              </div>
            </WorkflowSection>
          )}

          {structuredOutput !== undefined && (
            <WorkflowDisclosureSection title="Structured output" className="mt-2">
              <WorkflowJsonBlock value={structuredOutput} className="max-h-[220px]" />
            </WorkflowDisclosureSection>
          )}

          {reportMarkdown && (
            <div className="text-[11px]">
              <MarkdownRenderer content={reportMarkdown} />
            </div>
          )}

          {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

interface WorkflowResumeToolCallProps {
  args: WorkflowResumeToolArgs;
  result?: WorkflowResumeToolResult;
  status?: ToolStatus;
  workspaceId?: string;
  startedAt?: number;
}

/**
 * workflow_resume renders the same run card as workflow_run. The args only carry a run ID
 * (no workflow name/args), so the run ID doubles as the display name until the run record
 * loads, and knownRunId enables exact-by-ID discovery instead of name+args matching.
 */
export const WorkflowResumeToolCall: React.FC<WorkflowResumeToolCallProps> = (props) => {
  return (
    <WorkflowRunToolCall
      args={{
        name: props.args.run_id,
        args: undefined,
        run_in_background: props.args.run_in_background ?? false,
      }}
      result={props.result}
      status={props.status}
      workspaceId={props.workspaceId}
      startedAt={props.startedAt}
      toolName="workflow_resume"
      knownRunId={props.args.run_id}
    />
  );
};
