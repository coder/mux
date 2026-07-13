import React, { useRef, useState } from "react";
import { Info } from "lucide-react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  LoadingDots,
  ErrorBox,
} from "./Shared/ToolPrimitives";
import {
  useToolExpansion,
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
} from "./Shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";
import { useOptionalMessageListContext } from "../Messages/MessageListContext";
import { useStickyExpand } from "../Messages/useStickyExpand";
import { SubagentTranscriptDialog } from "./SubagentTranscriptDialog";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/browser/components/Tooltip/Tooltip";
import {
  useOptionalWorkspaceContext,
  toWorkspaceSelection,
} from "@/browser/contexts/WorkspaceContext";
import { useTaskToolLiveTaskIds } from "@/browser/stores/WorkspaceStore";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { useBackgroundProcesses } from "@/browser/stores/BackgroundBashStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { WORKSPACE_TURN_TASK_TAGS } from "@/constants/workspaceTags";
import type {
  TaskToolArgs,
  TaskToolResult,
  TaskToolSuccessResult,
  TaskAwaitToolArgs,
  TaskAwaitToolSuccessResult,
  TaskListToolArgs,
  TaskListToolSuccessResult,
  TaskTerminateToolArgs,
  TaskTerminateToolSuccessResult,
} from "@/common/types/tools";
import type { TaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import { formatGitPatchArtifactSummary } from "./taskPatchSummary";
import {
  formatTaskGroupCreationLabel,
  formatTaskGroupHeader,
  formatTaskGroupItemsLabel,
  formatTaskGroupMemberLabel,
  formatTaskGroupSummary,
  getTaskGroupCount,
  getTaskGroupKindFromArgs,
  getTaskGroupKindFromMetadata,
  getTaskGroupLabelAtIndex,
  normalizeTaskGroupLabel,
  type TaskGroupKind,
} from "@/common/utils/tools/taskGroups";
import { resolvePersistedAgentId } from "@/common/utils/agentIds";
import { formatDuration } from "@/common/utils/formatDuration";
import { ElapsedTimeDisplay } from "./Shared/ElapsedTimeDisplay";

/**
 * Clean SVG icon for task tools - represents spawning/branching work
 */
const TaskIcon: React.FC<{ className?: string; toolName: string }> = ({ className, toolName }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn("h-3.5 w-3.5 text-task-mode", className)}
      >
        {/* Main vertical line */}
        <path d="M4 2v5" />
        {/* Branch to right */}
        <path d="M4 7c0 2 2 3 4 3h4" />
        {/* Arrow head */}
        <path d="M10 8l2 2-2 2" />
        {/* Dot at origin */}
        <circle cx="4" cy="2" r="1.5" fill="currentColor" stroke="none" />
      </svg>
    </TooltipTrigger>
    <TooltipContent>{toolName}</TooltipContent>
  </Tooltip>
);

// Status badge component for task statuses
const TaskStatusBadge: React.FC<{
  status: string;
  className?: string;
}> = ({ status, className }) => {
  const getStatusStyle = () => {
    switch (status) {
      case "completed":
      case "reported":
        return "bg-success/20 text-success";
      case "running":
      case "backgrounded":
        return "bg-pending/20 text-pending";
      case "awaiting_report":
        return "bg-warning/20 text-warning";
      case "queued":
        return "bg-muted/20 text-muted";
      case "terminated":
      case "interrupted":
        // Workflow runs surface "interrupted" (resumable) through task_terminate results and
        // task_list rows; style it like "terminated" rather than the muted default.
        return "bg-interrupted/20 text-interrupted";
      case "not_found":
      case "invalid_scope":
      case "error":
      case "failed":
        // Workflow-run terminal failure status (task_list rows).
        return "bg-danger/20 text-danger";
      default:
        return "bg-muted/20 text-muted";
    }
  };

  const label = status === "awaiting_report" ? "awaiting report" : status;

  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        getStatusStyle(),
        className
      )}
    >
      {label}
    </span>
  );
};

function getAgentTypeStyle(type: string): string {
  switch (type) {
    case "explore":
      return "border-plan-mode/50 text-plan-mode";
    case "exec":
      return "border-exec-mode/50 text-exec-mode";
    case "workspace":
      return "border-task-mode/50 text-task-mode";
    default:
      return "border-muted/50 text-muted";
  }
}

function findWorkspaceForTaskTarget(
  workspaceMetadata: ReadonlyMap<string, FrontendWorkspaceMetadata> | undefined,
  taskId: string,
  openWorkspaceId?: string
): FrontendWorkspaceMetadata | undefined {
  const explicitWorkspaceId = trimToNonEmptyString(openWorkspaceId);
  if (explicitWorkspaceId) {
    const explicitWorkspace = workspaceMetadata?.get(explicitWorkspaceId);
    if (explicitWorkspace) {
      return explicitWorkspace;
    }
  }

  const directWorkspace = workspaceMetadata?.get(taskId);
  if (directWorkspace) {
    return directWorkspace;
  }

  // Workspace-turn task IDs (`wst_...`) are handles, not workspace IDs. Newly-created
  // workspace tasks tag the actual workspace with the handle so stale tool results remain clickable
  // after the result's explicit workspaceId falls out of view.
  for (const metadata of workspaceMetadata?.values() ?? []) {
    if (metadata.tags?.[WORKSPACE_TURN_TASK_TAGS.handle] === taskId) {
      return metadata;
    }
  }

  return undefined;
}

function openWorkspaceFromContext(
  workspaceContext: ReturnType<typeof useOptionalWorkspaceContext>,
  workspace: FrontendWorkspaceMetadata | undefined
): boolean {
  if (!workspace || !workspaceContext) {
    return false;
  }

  workspaceContext.setSelectedWorkspace(toWorkspaceSelection(workspace));
  return true;
}

// Agent type badge
const AgentTypeBadge: React.FC<{
  type: string;
  className?: string;
  taskId?: string;
  openWorkspaceId?: string;
}> = ({ type, className, taskId, openWorkspaceId }) => {
  const workspaceContext = useOptionalWorkspaceContext();
  const targetTaskId = trimToNonEmptyString(taskId);
  const workspace = targetTaskId
    ? findWorkspaceForTaskTarget(workspaceContext?.workspaceMetadata, targetTaskId, openWorkspaceId)
    : undefined;
  const classNames = cn(
    "inline-block shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
    getAgentTypeStyle(type),
    className
  );

  const openWorkspaceLabel = type === "workspace" ? "Open workspace" : `Open ${type} workspace`;

  if (!workspace) {
    return <span className={classNames}>{type}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={openWorkspaceLabel}
          className={cn(classNames, "hover:underline underline-offset-2")}
          onClick={(event) => {
            event.stopPropagation();
            openWorkspaceFromContext(workspaceContext, workspace);
          }}
        >
          {type}
        </button>
      </TooltipTrigger>
      <TooltipContent>Open workspace</TooltipContent>
    </Tooltip>
  );
};

// Task ID display with open/copy affordance.
// - If the task workspace exists locally, clicking opens it.
// - Otherwise, clicking copies the ID (so the user can search / share it).
const TaskId: React.FC<{ id: string; openWorkspaceId?: string; className?: string }> = ({
  id,
  openWorkspaceId,
  className,
}) => {
  const workspaceContext = useOptionalWorkspaceContext();
  const { copied, copyToClipboard } = useCopyToClipboard();

  const workspace = findWorkspaceForTaskTarget(
    workspaceContext?.workspaceMetadata,
    id,
    openWorkspaceId
  );

  const canOpenWorkspace = Boolean(workspace && workspaceContext);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "font-mono text-[10px] text-muted opacity-70 hover:opacity-100 hover:underline underline-offset-2",
            className
          )}
          onClick={() => {
            if (openWorkspaceFromContext(workspaceContext, workspace)) {
              return;
            }

            void copyToClipboard(id);
          }}
        >
          {id}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {canOpenWorkspace ? "Open workspace" : copied ? "Copied" : "Copy task ID"}
      </TooltipContent>
    </Tooltip>
  );
};

interface TaskRowProps {
  taskId: string;
  status: string;
  agentType?: string;
  title?: string;
  depth?: number;
  startedAtMs?: number;
  openWorkspaceId?: string;
  className?: string;
}

function isTaskRowElapsedActive(status: string): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "backgrounded" ||
    status === "awaiting_report"
  );
}

const TaskRowElapsed: React.FC<{ startedAtMs: number | undefined; status: string }> = (props) => {
  if (props.startedAtMs == null) {
    return null;
  }

  if (isTaskRowElapsedActive(props.status)) {
    return (
      <span className="text-muted counter-nums text-[10px]">
        <ElapsedTimeDisplay
          startedAt={props.startedAtMs}
          isActive={true}
          separator=""
          prefix="elapsed "
        />
      </span>
    );
  }

  return null;
};

const TaskRow: React.FC<TaskRowProps> = (props) => (
  <div
    className={cn("bg-code-bg flex flex-wrap items-center gap-2 rounded-sm p-2", props.className)}
  >
    <TaskId id={props.taskId} openWorkspaceId={props.openWorkspaceId} />
    <TaskStatusBadge status={props.status} />
    {props.agentType && (
      <AgentTypeBadge
        type={props.agentType}
        taskId={props.taskId}
        openWorkspaceId={props.openWorkspaceId}
      />
    )}
    {props.title && (
      <span className="text-foreground max-w-[200px] truncate text-[11px]">{props.title}</span>
    )}
    {typeof props.depth === "number" && props.depth > 0 && (
      <span className="text-muted text-[10px]">depth: {props.depth}</span>
    )}
    <TaskRowElapsed startedAtMs={props.startedAtMs} status={props.status} />
  </div>
);

const MAX_TASK_DEPTH_TRAVERSAL = 50;

function computeWorkspaceDepthFromRoot(
  rootWorkspaceId: string,
  leafWorkspaceId: string,
  workspaceMetadata: ReadonlyMap<string, FrontendWorkspaceMetadata>
): number | undefined {
  // Not a descendant task (or no nesting to measure).
  if (rootWorkspaceId === leafWorkspaceId) {
    return 0;
  }

  const visited = new Set<string>();
  let depth = 0;
  let currentId: string | undefined = leafWorkspaceId;

  // DEFENSIVE: Guard against cycles or corrupted metadata.
  while (depth < MAX_TASK_DEPTH_TRAVERSAL) {
    if (!currentId) {
      return undefined;
    }

    if (visited.has(currentId)) {
      return undefined;
    }

    visited.add(currentId);

    const metadata = workspaceMetadata.get(currentId);
    const parentId = metadata?.parentWorkspaceId;

    if (typeof parentId !== "string" || parentId.trim().length === 0) {
      return undefined;
    }

    depth += 1;

    if (parentId === rootWorkspaceId) {
      return depth;
    }

    currentId = parentId;
  }

  return undefined;
}

function toTaskStatusFromBackgroundProcessStatus(
  status: "running" | "exited" | "killed" | "failed"
): string {
  switch (status) {
    case "running":
      return "running";
    case "exited":
      return "completed";
    case "killed":
      return "terminated";
    case "failed":
      return "error";
    default:
      return String(status);
  }
}

function isWorkspaceTurnTaskHandleId(taskId: string): boolean {
  return /^wst_[a-z0-9][a-z0-9_-]*$/.test(taskId);
}

function fromBashTaskId(taskId: string): string | null {
  const prefix = "bash:";
  if (!taskId.startsWith(prefix)) {
    return null;
  }

  const processId = taskId.slice(prefix.length).trim();
  return processId.length > 0 ? processId : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASK TOOL CALL (spawn sub-agent)
// ═══════════════════════════════════════════════════════════════════════════════

interface TaskToolCallProps {
  args: TaskToolArgs;
  result?: TaskToolResult;
  status?: ToolStatus;
  taskReportLinking?: TaskReportLinking;
  workspaceId?: string;
  toolCallId?: string;
  startedAt?: number;
  /** When the model emitted the call; freshness fallback when startedAt is unknown. */
  toolCallTimestamp?: number;
}

interface TaskToolDisplayEntry {
  taskId: string;
  status: string;
  title?: string;
  reportMarkdown?: string;
  openWorkspaceId?: string;
  groupKind?: TaskGroupKind;
  label?: string;
}

interface TaskToolOwnReport {
  reportMarkdown: string;
  title?: string;
  groupKind?: TaskGroupKind;
  label?: string;
}

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function trimToNonEmptyString(value: unknown): string | null {
  return hasNonEmptyText(value) ? value.trim() : null;
}

function normalizeTaskId(value: unknown): string | null {
  return trimToNonEmptyString(value);
}

interface TaskToolWorkspaceEntry {
  taskId: string;
  index?: number;
  status?: string;
  title?: string;
  createdAtMs?: number;
  groupKind?: TaskGroupKind;
  label?: string;
}

function normalizeTaskAgent(value: string | undefined): string | null {
  const normalized = trimToNonEmptyString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeTaskTitle(value: string | undefined): string | null {
  return trimToNonEmptyString(value);
}

function parseWorkspaceCreatedAtMs(createdAt: string | undefined): number | undefined {
  const normalizedCreatedAt = trimToNonEmptyString(createdAt);
  if (!normalizedCreatedAt) {
    return undefined;
  }
  const timestamp = Date.parse(normalizedCreatedAt);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function getTaskToolWorkspaceStatus(
  taskStatus: FrontendWorkspaceMetadata["taskStatus"]
): string | undefined {
  switch (taskStatus) {
    case "reported":
      return "completed";
    case "queued":
    case "running":
    case "awaiting_report":
    case "interrupted":
      return taskStatus;
    default:
      return undefined;
  }
}

function getTaskToolWorkspaceTitle(
  metadata: FrontendWorkspaceMetadata | null | undefined
): string | undefined {
  return normalizeTaskTitle(metadata?.title) ?? normalizeTaskTitle(metadata?.name) ?? undefined;
}

function mergeTaskIdsInDisplayOrder(taskIdLists: ReadonlyArray<readonly string[]>): string[] {
  const taskIds: string[] = [];
  const seen = new Set<string>();

  for (const taskIdList of taskIdLists) {
    for (const taskId of taskIdList) {
      const normalizedTaskId = normalizeTaskId(taskId);
      if (!normalizedTaskId || seen.has(normalizedTaskId)) {
        continue;
      }
      seen.add(normalizedTaskId);
      taskIds.push(normalizedTaskId);
    }
  }

  return taskIds;
}

// task-created events are intentionally ephemeral UI hints. If the parent workspace
// is opened after those events were missed, recover the current grouped child tasks
// from child workspace metadata when the matching group is unambiguous.
function recoverTaskGroupTaskIdsFromWorkspaceMetadata(params: {
  workspaceId: string | undefined;
  requestedAgentType: string;
  requestedTitle: string | undefined;
  requestedCandidateCount: number;
  requestedGroupKind: TaskGroupKind;
  knownTaskIds: readonly string[];
  toolStartedAt: number | undefined;
  workspaceMetadata: ReadonlyMap<string, FrontendWorkspaceMetadata> | undefined;
}): TaskToolWorkspaceEntry[] {
  if (!params.workspaceId || params.requestedCandidateCount <= 1 || !params.workspaceMetadata) {
    return [];
  }

  const requestedAgentType = normalizeTaskAgent(params.requestedAgentType);
  const requestedTitle = normalizeTaskTitle(params.requestedTitle);
  const groupedCandidates = new Map<string, TaskToolWorkspaceEntry[]>();

  for (const metadata of params.workspaceMetadata.values()) {
    if (metadata.parentWorkspaceId !== params.workspaceId) {
      continue;
    }
    if (metadata.bestOf?.total !== params.requestedCandidateCount) {
      continue;
    }
    if (getTaskGroupKindFromMetadata(metadata.bestOf) !== params.requestedGroupKind) {
      continue;
    }
    if (requestedAgentType) {
      const metadataAgentType = normalizeTaskAgent(resolvePersistedAgentId(metadata, ""));
      if (metadataAgentType && metadataAgentType !== requestedAgentType) {
        continue;
      }
    }

    const taskId = normalizeTaskId(metadata.id);
    const metadataTitle = getTaskToolWorkspaceTitle(metadata);
    if (!taskId) {
      continue;
    }
    if (requestedTitle && normalizeTaskTitle(metadataTitle) !== requestedTitle) {
      continue;
    }

    const candidates = groupedCandidates.get(metadata.bestOf.groupId) ?? [];
    candidates.push({
      taskId,
      index: metadata.bestOf.index,
      status: getTaskToolWorkspaceStatus(metadata.taskStatus),
      title: metadataTitle,
      createdAtMs: parseWorkspaceCreatedAtMs(metadata.createdAt),
      groupKind: getTaskGroupKindFromMetadata(metadata.bestOf),
      label: normalizeTaskGroupLabel(metadata.bestOf.label),
    });
    groupedCandidates.set(metadata.bestOf.groupId, candidates);
  }

  const groups = Array.from(groupedCandidates.values()).filter(
    (group) => group.length <= params.requestedCandidateCount
  );
  if (groups.length === 0) {
    return [];
  }

  const knownTaskIds = new Set(
    params.knownTaskIds
      .map((taskId) => normalizeTaskId(taskId))
      .filter((taskId): taskId is string => taskId != null)
  );

  let selectedGroup: TaskToolWorkspaceEntry[] | undefined;
  if (knownTaskIds.size > 0) {
    const matchingGroups = groups
      .map((group) => ({
        group,
        matchCount: group.filter((candidate) => knownTaskIds.has(candidate.taskId)).length,
      }))
      .filter((group) => group.matchCount > 0)
      .sort((left, right) => right.matchCount - left.matchCount);

    if (
      matchingGroups.length === 1 ||
      matchingGroups[0]?.matchCount !== matchingGroups[1]?.matchCount
    ) {
      selectedGroup = matchingGroups[0]?.group;
    }
  }

  const toolStartedAt = params.toolStartedAt;
  if (!selectedGroup && knownTaskIds.size === 0 && groups.length === 1 && toolStartedAt != null) {
    const createdAfterToolStart = groups[0]?.every((candidate) => {
      return candidate.createdAtMs != null && candidate.createdAtMs >= toolStartedAt;
    });
    if (createdAfterToolStart) {
      selectedGroup = groups[0];
    }
  }
  if (!selectedGroup) {
    return [];
  }

  return [...selectedGroup].sort(
    (left, right) =>
      (left.index ?? Number.MAX_SAFE_INTEGER) - (right.index ?? Number.MAX_SAFE_INTEGER)
  );
}

function collectTaskToolResultDisplayData(result: TaskToolSuccessResult | null): {
  taskIds: string[];
  statusByTaskId: Map<string, string>;
  ownReportsByTaskId: Map<string, TaskToolOwnReport>;
  taskGroupsByTaskId: Map<string, { groupKind?: TaskGroupKind; label?: string }>;
  workspaceIdByTaskId: Map<string, string>;
} {
  const taskIds = new Set<string>();
  const statusByTaskId = new Map<string, string>();
  const ownReportsByTaskId = new Map<string, TaskToolOwnReport>();
  const taskGroupsByTaskId = new Map<string, { groupKind?: TaskGroupKind; label?: string }>();
  const workspaceIdByTaskId = new Map<string, string>();
  if (!result) {
    return {
      taskIds: [],
      statusByTaskId,
      ownReportsByTaskId,
      taskGroupsByTaskId,
      workspaceIdByTaskId,
    };
  }

  const rememberTaskId = (taskId: unknown): string | null => {
    const normalizedTaskId = normalizeTaskId(taskId);
    if (normalizedTaskId) {
      taskIds.add(normalizedTaskId);
    }
    return normalizedTaskId;
  };

  const rememberTaskGroup = (
    taskId: string,
    details: { groupKind?: TaskGroupKind; label?: string | null }
  ): void => {
    const label = normalizeTaskGroupLabel(details.label);
    if (!details.groupKind && !label) {
      return;
    }
    taskGroupsByTaskId.set(taskId, {
      groupKind: details.groupKind,
      ...(label ? { label } : {}),
    });
  };

  const rememberWorkspace = (taskId: string, workspaceId: unknown): void => {
    const normalizedWorkspaceId = trimToNonEmptyString(workspaceId);
    if (normalizedWorkspaceId) {
      workspaceIdByTaskId.set(taskId, normalizedWorkspaceId);
    }
  };

  const taskStatuses = "tasks" in result && Array.isArray(result.tasks) ? result.tasks : undefined;
  const singleTaskId = rememberTaskId(result.taskId);
  if (singleTaskId) {
    rememberWorkspace(singleTaskId, result.workspaceId);
  }
  if (singleTaskId && result.status === "completed" && typeof result.reportMarkdown === "string") {
    ownReportsByTaskId.set(singleTaskId, {
      reportMarkdown: result.reportMarkdown,
      title: result.title,
    });
  }

  if (Array.isArray(result.taskIds)) {
    for (const taskId of result.taskIds) {
      rememberTaskId(taskId);
    }
  }

  if (taskStatuses) {
    for (const task of taskStatuses) {
      const taskId = rememberTaskId(task.taskId);
      if (taskId) {
        statusByTaskId.set(taskId, task.status);
        rememberWorkspace(taskId, task.workspaceId);
        rememberTaskGroup(taskId, { groupKind: task.groupKind, label: task.label });
      }
    }
  }

  if ("reports" in result && Array.isArray(result.reports)) {
    for (const report of result.reports) {
      const taskId = rememberTaskId(report.taskId);
      if (taskId) {
        ownReportsByTaskId.set(taskId, {
          reportMarkdown: report.reportMarkdown,
          title: report.title,
          groupKind: report.groupKind,
          label: normalizeTaskGroupLabel(report.label),
        });
        rememberWorkspace(taskId, report.workspaceId);
        rememberTaskGroup(taskId, { groupKind: report.groupKind, label: report.label });
      }
    }
  }

  if (!taskStatuses) {
    const fallbackStatus = result.status;
    for (const taskId of taskIds) {
      statusByTaskId.set(taskId, fallbackStatus);
    }
  }

  return {
    taskIds: Array.from(taskIds),
    statusByTaskId,
    ownReportsByTaskId,
    taskGroupsByTaskId,
    workspaceIdByTaskId,
  };
}

function getAggregateTaskStatus(
  displayEntries: readonly TaskToolDisplayEntry[],
  fallbackStatus: TaskToolSuccessResult["status"] | undefined
): string | undefined {
  if (displayEntries.length === 0) {
    return fallbackStatus;
  }
  if (displayEntries.every((entry) => entry.status === "completed")) {
    return "completed";
  }
  if (
    displayEntries.some((entry) => entry.status === "running" || entry.status === "awaiting_report")
  ) {
    return "running";
  }
  if (displayEntries.some((entry) => entry.status === "queued")) {
    return "queued";
  }
  if (displayEntries.some((entry) => entry.status === "interrupted")) {
    return "interrupted";
  }
  return fallbackStatus;
}

const TaskToolCandidateCard: React.FC<{
  entry: TaskToolDisplayEntry;
  index: number;
  total: number;
  groupKind: TaskGroupKind;
  onOpenTranscript: (taskId: string) => void;
}> = ({ entry, index, total, groupKind, onOpenTranscript }) => {
  const canViewTranscript = entry.status === "completed";
  const hasReport = hasNonEmptyText(entry.reportMarkdown);
  const memberLabel = formatTaskGroupMemberLabel({
    kind: entry.groupKind ?? groupKind,
    index,
    label: entry.label,
  });

  return (
    <div className="bg-code-bg rounded-sm p-2">
      <div className={cn("flex flex-wrap items-center gap-2", hasReport && "mb-2")}>
        {total > 1 && <span className="text-muted text-[10px]">{memberLabel}</span>}
        <TaskId id={entry.taskId} openWorkspaceId={entry.openWorkspaceId} />
        <TaskStatusBadge status={entry.status} />
        {entry.title && (
          <span className="text-foreground text-[11px] font-medium">{entry.title}</span>
        )}
        {canViewTranscript && (
          <button
            type="button"
            className="text-link text-[10px] font-medium underline-offset-2 hover:underline"
            onClick={() => {
              onOpenTranscript(entry.taskId);
            }}
          >
            View transcript
          </button>
        )}
      </div>

      {hasReport && entry.reportMarkdown && (
        <div className="text-[11px]">
          <MarkdownRenderer content={entry.reportMarkdown} />
        </div>
      )}
    </div>
  );
};

export const TaskToolCall: React.FC<TaskToolCallProps> = ({
  workspaceId,
  args,
  result,
  status = "pending",
  taskReportLinking,
  toolCallId,
  startedAt,
  toolCallTimestamp,
}) => {
  const errorResult = isToolErrorResult(result) ? result : null;
  const successResult: TaskToolSuccessResult | null =
    result && typeof result === "object" && "status" in result ? result : null;

  const liveTaskIds = useTaskToolLiveTaskIds(workspaceId, toolCallId) ?? [];
  const workspaceContext = useOptionalWorkspaceContext();
  const workspaceMetadata = workspaceContext?.workspaceMetadata;
  const {
    taskIds: resultTaskIds,
    statusByTaskId,
    ownReportsByTaskId,
    taskGroupsByTaskId,
    workspaceIdByTaskId,
  } = collectTaskToolResultDisplayData(successResult);

  const requestedTaskGroupCount = getTaskGroupCount(args);
  const taskGroupKind = getTaskGroupKindFromArgs(args);
  const title = args.title ?? "Task";
  const prompt = args.prompt ?? "";
  const taskKindLabel =
    args.kind === "workspace" ? "workspace" : (args.agentId ?? args.subagent_type ?? "unknown");
  const recoveredTaskIdsRef = useRef<string[]>([]);
  // Keep the current grouped-task binding stable once a task call has matched concrete child IDs.
  // This prevents a recovered group from disappearing when the last running child flips to
  // reported before the parent task tool call itself produces a result.
  const recoveredWorkspaceEntries = recoverTaskGroupTaskIdsFromWorkspaceMetadata({
    workspaceId,
    requestedAgentType: taskKindLabel,
    requestedTitle: title,
    requestedCandidateCount: requestedTaskGroupCount,
    requestedGroupKind: taskGroupKind,
    knownTaskIds: [...resultTaskIds, ...liveTaskIds, ...recoveredTaskIdsRef.current],
    // Prefer the true execution start; fall back to the model-emission timestamp for
    // parts without execution-start tracking (history replay). Both are valid lower
    // bounds on when this call could have created child workspaces.
    toolStartedAt: startedAt ?? toolCallTimestamp,
    workspaceMetadata,
  });
  if (recoveredWorkspaceEntries.length > 0) {
    recoveredTaskIdsRef.current = recoveredWorkspaceEntries.map((entry) => entry.taskId);
  }
  const taskIds = mergeTaskIdsInDisplayOrder([
    resultTaskIds,
    recoveredWorkspaceEntries.map((entry) => entry.taskId),
    liveTaskIds,
  ]);

  const totalTaskGroupCount = Math.max(
    successResult && (resultTaskIds.length > 0 || ownReportsByTaskId.size > 0)
      ? 0
      : requestedTaskGroupCount,
    taskIds.length,
    ownReportsByTaskId.size
  );
  const isTaskGroup = totalTaskGroupCount > 1;

  const isBackground = args.run_in_background;

  const displayEntries: TaskToolDisplayEntry[] = taskIds.map((taskId, index) => {
    const ownReport = ownReportsByTaskId.get(taskId);
    const linkedReport = taskReportLinking?.reportByTaskId.get(taskId);
    const openWorkspaceId = workspaceIdByTaskId.get(taskId);
    const metadata = findWorkspaceForTaskTarget(workspaceMetadata, taskId, openWorkspaceId);
    const resultTaskGroup = taskGroupsByTaskId.get(taskId);
    const reportMarkdown = hasNonEmptyText(ownReport?.reportMarkdown)
      ? ownReport.reportMarkdown
      : linkedReport?.reportMarkdown;
    const reportTitle = ownReport?.title ?? linkedReport?.title;
    const derivedStatus =
      (ownReport ?? linkedReport)
        ? "completed"
        : (getTaskToolWorkspaceStatus(metadata?.taskStatus) ?? statusByTaskId.get(taskId));

    return {
      taskId,
      status:
        derivedStatus ?? (status === "executing" ? "running" : (successResult?.status ?? "queued")),
      title: reportTitle ?? getTaskToolWorkspaceTitle(metadata) ?? title,
      reportMarkdown,
      openWorkspaceId,
      groupKind:
        ownReport?.groupKind ??
        resultTaskGroup?.groupKind ??
        (metadata?.bestOf ? getTaskGroupKindFromMetadata(metadata.bestOf) : undefined) ??
        taskGroupKind,
      label:
        ownReport?.label ??
        resultTaskGroup?.label ??
        normalizeTaskGroupLabel(metadata?.bestOf?.label) ??
        getTaskGroupLabelAtIndex(args, index),
    };
  });

  const completedTaskGroupCount = displayEntries.filter(
    (entry) => entry.status === "completed"
  ).length;
  const hasAnyReport = displayEntries.some((entry) => hasNonEmptyText(entry.reportMarkdown));
  const aggregateTaskStatus = getAggregateTaskStatus(displayEntries, successResult?.status);

  const effectiveStatus: ToolStatus =
    aggregateTaskStatus === "completed"
      ? "completed"
      : aggregateTaskStatus === "interrupted"
        ? "interrupted"
        : status === "completed" &&
            (aggregateTaskStatus === "queued" || aggregateTaskStatus === "running")
          ? "backgrounded"
          : status;

  // Base state follows the sticky tools preference. Errors can arrive after mount, so
  // pass them as a live forceExpanded signal (latched) to open the row when one lands
  // instead of seeding once and hiding the failure behind the header.
  const { expanded, toggleExpanded } = useStickyExpand("tools", false, {
    forceExpanded: !!errorResult,
  });

  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);
  const preview = prompt.length > 60 ? prompt.slice(0, 60).trim() + "…" : prompt.split("\n")[0];
  const collapsedPreview = isTaskGroup
    ? formatTaskGroupHeader(taskGroupKind, totalTaskGroupCount, preview)
    : preview;
  const singleEntry = !isTaskGroup ? displayEntries[0] : undefined;
  const kindBadge = (
    <AgentTypeBadge
      type={taskKindLabel}
      taskId={singleEntry?.taskId}
      openWorkspaceId={singleEntry?.openWorkspaceId}
    />
  );
  const createdTaskGroupCount = taskIds.length;
  const shouldShowCreationProgress =
    isTaskGroup &&
    !errorResult &&
    status === "executing" &&
    createdTaskGroupCount < totalTaskGroupCount;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task" />
        <ToolName>task</ToolName>
        {kindBadge}
        {isTaskGroup && (
          <span className="text-muted text-[10px]">
            {formatTaskGroupSummary(taskGroupKind, totalTaskGroupCount).toLowerCase()}
          </span>
        )}
        {isBackground && (
          <span className="text-backgrounded text-[10px] font-medium">background</span>
        )}
        <StatusIndicator status={effectiveStatus}>
          {getStatusDisplay(effectiveStatus)}
        </StatusIndicator>
      </ToolHeader>

      {transcriptTaskId && (
        <SubagentTranscriptDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setTranscriptTaskId(null);
            }
          }}
          workspaceId={workspaceId}
          taskId={transcriptTaskId}
        />
      )}

      {expanded && (
        <ToolDetails>
          <div className="task-surface mt-1 rounded-md p-3">
            <div className="task-divider mb-2 flex flex-wrap items-center gap-2 border-b pb-2">
              <span className="text-task-mode text-[12px] font-semibold">
                {isTaskGroup
                  ? formatTaskGroupHeader(taskGroupKind, totalTaskGroupCount, title)
                  : (singleEntry?.title ?? title)}
              </span>
              {isTaskGroup ? (
                <span className="text-muted text-[10px]">
                  {completedTaskGroupCount}/{totalTaskGroupCount} completed
                </span>
              ) : (
                singleEntry?.taskId && (
                  <TaskId id={singleEntry.taskId} openWorkspaceId={singleEntry.openWorkspaceId} />
                )
              )}
              {!isTaskGroup && singleEntry?.status && (
                <TaskStatusBadge status={singleEntry.status} />
              )}
              {!isTaskGroup && singleEntry?.status === "completed" && (
                <button
                  type="button"
                  className="text-link text-[10px] font-medium underline-offset-2 hover:underline"
                  onClick={() => {
                    setTranscriptTaskId(singleEntry.taskId);
                  }}
                >
                  View transcript
                </button>
              )}
            </div>

            <div className="mb-2">
              <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">Prompt</div>
              <div className="text-foreground bg-code-bg max-h-[140px] overflow-y-auto rounded-sm p-2 text-[11px] break-words whitespace-pre-wrap">
                {prompt}
              </div>
            </div>

            {isTaskGroup ? (
              <div className="task-divider border-t pt-2">
                <div className="text-muted mb-2 text-[10px] tracking-wide uppercase">
                  {formatTaskGroupItemsLabel(taskGroupKind)}
                </div>
                <div className="space-y-2">
                  {displayEntries.map((entry, index) => (
                    <TaskToolCandidateCard
                      key={entry.taskId}
                      entry={entry}
                      index={index}
                      total={totalTaskGroupCount}
                      groupKind={taskGroupKind}
                      onOpenTranscript={setTranscriptTaskId}
                    />
                  ))}
                </div>
              </div>
            ) : (
              singleEntry?.reportMarkdown && (
                <div className="task-divider border-t pt-2">
                  <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">Report</div>
                  <div className="text-[11px]">
                    <MarkdownRenderer content={singleEntry.reportMarkdown} />
                  </div>
                </div>
              )
            )}

            {shouldShowCreationProgress && (
              <div className="text-muted mt-2 text-[11px] italic">
                {formatTaskGroupCreationLabel(taskGroupKind)} ({createdTaskGroupCount}/
                {totalTaskGroupCount})
                <LoadingDots />
              </div>
            )}

            {effectiveStatus === "executing" && !hasAnyReport && !shouldShowCreationProgress && (
              <div className="text-muted mt-2 text-[11px] italic">
                Task {isBackground ? "running in background" : "executing"}
                <LoadingDots />
              </div>
            )}

            {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
          </div>
        </ToolDetails>
      )}

      {!expanded && <div className="text-muted mt-1 truncate text-[10px]">{collapsedPreview}</div>}
    </ToolContainer>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK AWAIT TOOL CALL
// ═══════════════════════════════════════════════════════════════════════════════

interface TaskAwaitToolCallProps {
  args: TaskAwaitToolArgs;
  result?: TaskAwaitToolSuccessResult;
  status?: ToolStatus;
  startedAt?: number;
  taskReportLinking?: TaskReportLinking;
}

export const TaskAwaitToolCall: React.FC<TaskAwaitToolCallProps> = ({
  args,
  result,
  status = "pending",
  startedAt,
  taskReportLinking,
}) => {
  const taskIds = args.task_ids;
  const timeoutSecs = args.timeout_secs;
  const results = result?.results ?? [];

  const suppressReportInAwaitTaskIds = taskReportLinking?.suppressReportInAwaitTaskIds;

  const showConfigInfo =
    taskIds != null || timeoutSecs != null || args.filter != null || args.filter_exclude === true;

  // Summary for header
  const completedCount = results.filter((r) => r.status === "completed").length;
  const totalCount = results.length;
  const failedCount = results.filter(
    (r) => r.status === "error" || r.status === "invalid_scope" || r.status === "not_found"
  ).length;

  const workspaceContext = useOptionalWorkspaceContext();
  const workspaceMetadata = workspaceContext?.workspaceMetadata;
  const messageListContext = useOptionalMessageListContext();
  const workspaceId = messageListContext?.workspaceId;
  const backgroundProcesses = useBackgroundProcesses(workspaceId);

  const awaitedRows: TaskRowProps[] = [];
  if (status === "executing" && results.length === 0 && Array.isArray(taskIds)) {
    for (const taskId of taskIds) {
      const processId = fromBashTaskId(taskId);
      if (processId) {
        const proc = backgroundProcesses.find((entry) => entry.id === processId);
        awaitedRows.push({
          taskId,
          status: proc ? toTaskStatusFromBackgroundProcessStatus(proc.status) : "waiting",
          title: proc?.displayName ?? proc?.id,
          depth: 1,
          startedAtMs: proc?.startTime,
        });
        continue;
      }

      const metadata = findWorkspaceForTaskTarget(workspaceMetadata, taskId);
      const isWorkspaceTurn = isWorkspaceTurnTaskHandleId(taskId);
      if (!metadata) {
        awaitedRows.push({
          taskId,
          status: "waiting",
          agentType: isWorkspaceTurn ? "workspace" : undefined,
        });
        continue;
      }

      const resolvedAgentType = isWorkspaceTurn
        ? "workspace"
        : resolvePersistedAgentId(metadata, "");
      const agentType = resolvedAgentType.length > 0 ? resolvedAgentType : undefined;
      const title = metadata.title?.trim().length ? metadata.title : metadata.name;

      awaitedRows.push({
        taskId,
        status: metadata.taskStatus ?? "waiting",
        agentType: agentType && agentType.length > 0 ? agentType : undefined,
        title,
        depth:
          workspaceId && workspaceMetadata
            ? computeWorkspaceDepthFromRoot(workspaceId, metadata.id, workspaceMetadata)
            : undefined,
        startedAtMs: parseWorkspaceCreatedAtMs(metadata.createdAt),
        openWorkspaceId: metadata.id,
      });
    }
  }

  // Keep task_await collapsed by default (following the sticky tools preference), but
  // auto-expand when failures are present so they aren't hidden behind a "completed"
  // badge. failedCount is usually 0 at mount and only rises once awaited results land,
  // so pass it as a live forceExpanded signal (latched) rather than a one-time seed.
  const { expanded, toggleExpanded } = useStickyExpand("tools", false, {
    forceExpanded: failedCount > 0,
  });

  const effectiveStatus: ToolStatus = status === "completed" && failedCount > 0 ? "failed" : status;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task_await" />
        <ToolName>task_await</ToolName>
        {status === "executing" && (
          <span className="text-pending counter-nums ml-2 text-[10px] whitespace-nowrap [@container(max-width:500px)]:hidden">
            <ElapsedTimeDisplay
              startedAt={startedAt}
              isActive={true}
              separator=""
              prefix="elapsed "
            />
          </span>
        )}
        {totalCount > 0 && (
          <span className="text-muted text-[10px]">
            {completedCount}/{totalCount} completed
          </span>
        )}
        {failedCount > 0 && <span className="text-danger text-[10px]">{failedCount} failed</span>}
        <StatusIndicator status={effectiveStatus}>
          {getStatusDisplay(effectiveStatus)}
        </StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="task-surface mt-1 rounded-md p-3">
            {/* Config info */}
            {showConfigInfo && (
              <div className="task-divider text-muted mb-2 flex flex-wrap gap-2 border-b pb-2 text-[10px]">
                {taskIds != null && <span>Waiting for: {taskIds.length} task(s)</span>}
                {timeoutSecs != null && <span>Timeout: {timeoutSecs}s</span>}
                {args.filter != null && <span>Filter: {args.filter}</span>}
                {args.filter_exclude === true && <span>Exclude: true</span>}
              </div>
            )}

            {/* Results */}
            {results.length > 0 ? (
              <div className="space-y-3">
                {results.map((r, idx) => {
                  const taskId = typeof r.taskId === "string" ? r.taskId : null;

                  const spawnTitle = taskId
                    ? taskReportLinking?.spawnTitleByTaskId.get(taskId)
                    : undefined;
                  const resultWorkspaceId = "workspaceId" in r ? r.workspaceId : undefined;
                  const workspaceTitle = taskId
                    ? getTaskToolWorkspaceTitle(
                        findWorkspaceForTaskTarget(workspaceMetadata, taskId, resultWorkspaceId)
                      )
                    : undefined;
                  const fallbackTitle = trimToNonEmptyString(spawnTitle) ?? workspaceTitle;

                  return (
                    <TaskAwaitResult
                      key={taskId ?? idx}
                      result={r}
                      fallbackTitle={fallbackTitle}
                      suppressReport={taskId ? suppressReportInAwaitTaskIds?.has(taskId) : false}
                    />
                  );
                })}
              </div>
            ) : status === "executing" ? (
              <div className="space-y-2">
                {awaitedRows.map((row) => (
                  <TaskRow key={row.taskId} {...row} />
                ))}
                <div className="text-muted text-[11px] italic">
                  Waiting for tasks to complete
                  <LoadingDots />
                </div>
              </div>
            ) : (
              <div className="text-muted text-[11px] italic">No tasks specified</div>
            )}
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

// Individual task_await result display
const TaskAwaitResult: React.FC<{
  result: TaskAwaitToolSuccessResult["results"][number];
  fallbackTitle?: string;
  suppressReport?: boolean;
}> = ({ result, fallbackTitle, suppressReport }) => {
  const isCompleted = result.status === "completed";
  const reportMarkdown = isCompleted ? result.reportMarkdown : undefined;

  const rawReportTitle = isCompleted ? result.title : undefined;
  const reportTitle = trimToNonEmptyString(rawReportTitle) ?? undefined;

  const title = reportTitle ?? trimToNonEmptyString(fallbackTitle) ?? undefined;

  const output = "output" in result ? result.output : undefined;
  const note = "note" in result ? result.note : undefined;
  const exitCode = "exitCode" in result ? result.exitCode : undefined;

  const gitPatchArtifact =
    result.status === "completed" ? result.artifacts?.gitFormatPatch : undefined;

  const patchSummary = formatGitPatchArtifactSummary(gitPatchArtifact);
  const elapsedMs = "elapsed_ms" in result ? result.elapsed_ms : undefined;

  const openWorkspaceId = "workspaceId" in result ? result.workspaceId : undefined;

  const showDetails = !suppressReport;

  return (
    <div className="bg-code-bg rounded-sm p-2">
      <div className={cn("flex flex-wrap items-center gap-2", showDetails && "mb-1")}>
        <TaskId id={result.taskId} openWorkspaceId={openWorkspaceId} />
        <TaskStatusBadge status={result.status} />
        {title && <span className="text-foreground text-[11px] font-medium">{title}</span>}
        {exitCode !== undefined && <span className="text-muted text-[10px]">exit {exitCode}</span>}
        {elapsedMs !== undefined && (
          <span className="text-muted counter-nums text-[10px]">
            took {formatDuration(elapsedMs)}
          </span>
        )}
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
      </div>

      {showDetails && patchSummary && <div className="text-muted text-[10px]">{patchSummary}</div>}

      {showDetails && !isCompleted && output && output.length > 0 && (
        <div className="text-foreground bg-code-bg max-h-[140px] overflow-y-auto rounded-sm p-2 text-[11px] break-words whitespace-pre-wrap">
          {output}
        </div>
      )}

      {showDetails && reportMarkdown && (
        <div className="mt-2 text-[11px]">
          <MarkdownRenderer content={reportMarkdown} />
        </div>
      )}

      {"error" in result && result.error && (
        <div className="text-danger mt-1 text-[11px]">{result.error}</div>
      )}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════════════════════
// TASK LIST TOOL CALL
// ═══════════════════════════════════════════════════════════════════════════════

interface TaskListToolCallProps {
  args: TaskListToolArgs;
  result?: TaskListToolSuccessResult;
  status?: ToolStatus;
}

export const TaskListToolCall: React.FC<TaskListToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const tasks = result?.tasks ?? [];
  const { expanded, toggleExpanded } = useToolExpansion(false);

  const statusFilter = args.statuses;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task_list" />
        <ToolName>task_list</ToolName>
        <span className="text-muted text-[10px]">{tasks.length} task(s)</span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="task-surface mt-1 rounded-md p-3">
            {statusFilter && statusFilter.length > 0 && (
              <div className="task-divider text-muted mb-2 border-b pb-2 text-[10px]">
                Filter: {statusFilter.join(", ")}
              </div>
            )}

            {tasks.length > 0 ? (
              <div className="space-y-2">
                {tasks.map((task) => (
                  <TaskListItem key={task.taskId} task={task} />
                ))}
              </div>
            ) : status === "executing" ? (
              <div className="text-muted text-[11px] italic">
                Fetching tasks
                <LoadingDots />
              </div>
            ) : (
              <div className="text-muted text-[11px] italic">No tasks found</div>
            )}
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

// Individual task in list display
const TaskListItem: React.FC<{
  task: TaskListToolSuccessResult["tasks"][number];
}> = ({ task }) => (
  <TaskRow
    taskId={task.taskId}
    status={task.status}
    agentType={task.handleKind === "workspace_turn" ? "workspace" : task.agentType}
    title={task.title}
    depth={task.depth}
    openWorkspaceId={task.workspaceId}
  />
);

// ═══════════════════════════════════════════════════════════════════════════════
// TASK TERMINATE TOOL CALL
// ═══════════════════════════════════════════════════════════════════════════════

interface TaskTerminateToolCallProps {
  args: TaskTerminateToolArgs;
  result?: TaskTerminateToolSuccessResult;
  status?: ToolStatus;
}

export const TaskTerminateToolCall: React.FC<TaskTerminateToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useToolExpansion(false);

  const taskIds = args.task_ids;
  const results = result?.results ?? [];

  const terminatedCount = results.filter((r) => r.status === "terminated").length;
  // Workflow runs report "interrupted" (resumable) instead of "terminated"; both are
  // successful outcomes of this tool and must be reflected in the header summary.
  const interruptedCount = results.filter((r) => r.status === "interrupted").length;
  const summaryParts = [
    ...(terminatedCount > 0 ? [`${terminatedCount} terminated`] : []),
    ...(interruptedCount > 0 ? [`${interruptedCount} interrupted`] : []),
  ];
  const summary =
    summaryParts.length > 0 ? summaryParts.join(", ") : `${taskIds.length} to terminate`;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task_terminate" />
        <ToolName>task_terminate</ToolName>
        <span className="text-interrupted text-[10px]">{summary}</span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="task-surface mt-1 rounded-md p-3">
            {results.length > 0 ? (
              <div className="space-y-2">
                {results.map((r, idx) => (
                  <div key={r.taskId ?? idx} className="bg-code-bg rounded-sm p-2">
                    <div className="flex items-center gap-2">
                      <TaskId id={r.taskId} />
                      <TaskStatusBadge status={r.status} />
                    </div>
                    {"terminatedTaskIds" in r && r.terminatedTaskIds.length > 1 && (
                      <div className="text-muted mt-1 text-[10px]">
                        Also terminated:{" "}
                        {r.terminatedTaskIds.filter((id) => id !== r.taskId).join(", ")}
                      </div>
                    )}
                    {"note" in r && r.note && (
                      <div className="text-muted mt-1 text-[11px]">{r.note}</div>
                    )}
                    {"error" in r && r.error && (
                      <div className="text-danger mt-1 text-[11px]">{r.error}</div>
                    )}
                  </div>
                ))}
              </div>
            ) : status === "executing" ? (
              <div className="text-muted text-[11px] italic">
                Terminating tasks
                <LoadingDots />
              </div>
            ) : (
              <div className="text-muted text-[10px]">Tasks to terminate: {taskIds.join(", ")}</div>
            )}
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
