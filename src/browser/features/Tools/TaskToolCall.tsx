import React, { useRef, useState } from "react";
import { ArrowUpRight, CircleAlert, CircleCheck, Clock3, Info, LoaderCircle } from "lucide-react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  LoadingDots,
  ErrorBox,
  ToolIcon,
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
import type { TaskAttachFileArtifact } from "@/common/types/taskArtifacts";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { isCanonicalExecutionWorkspace } from "@/common/utils/workspaceClassification";
import type {
  TaskToolArgs,
  TaskToolResult,
  TaskToolSuccessResult,
  TaskAwaitToolArgs,
  TaskAwaitToolSuccessResult,
  TaskListToolArgs,
  TaskListToolSuccessResult,
  TaskSendMessageToolArgs,
  TaskSendMessageToolSuccessResult,
  TaskTerminateToolArgs,
  TaskTerminateToolSuccessResult,
  ToolErrorResult,
} from "@/common/types/tools";
import type { TaskReportLinking } from "@/browser/utils/messages/taskReportLinking";
import { formatGitPatchArtifactSummary } from "./taskPatchSummary";
import { sanitizeDisplayableModelIntent } from "./bashCollapsedSummary";
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
import { ModelDisplay } from "../Messages/ModelDisplay";
import { getThinkingOptionLabel, type ThinkingLevel } from "@/common/types/thinking";

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
      case "accepted":
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
      data-component="TaskStatusBadge"
      className={cn(
        // Lowercase status labels sit high within the font box, so preserve the compact total
        // height while shifting one pixel of padding from below the text to above it.
        "inline-flex shrink-0 items-center rounded px-1.5 pt-[3px] pb-px text-[10px] leading-none font-medium whitespace-nowrap",
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

interface ExecutionWorkspaceTarget {
  workspace?: FrontendWorkspaceMetadata;
  hasCanonicalWorkspaceId: boolean;
}

function resolveExecutionWorkspaceTarget(
  workspaceMetadata: ReadonlyMap<string, FrontendWorkspaceMetadata> | undefined,
  taskId: string,
  workspaceId?: string
): ExecutionWorkspaceTarget {
  const canonicalWorkspaceId = trimToNonEmptyString(workspaceId);
  if (canonicalWorkspaceId) {
    return {
      workspace: workspaceMetadata?.get(canonicalWorkspaceId),
      hasCanonicalWorkspaceId: true,
    };
  }

  // Historical task results did not carry workspaceId. executionId is the only safe live
  // back-reference: taskId is opaque and must never be treated as a workspace ID.
  for (const metadata of workspaceMetadata?.values() ?? []) {
    if (metadata.executionId === taskId) {
      return { workspace: metadata, hasCanonicalWorkspaceId: false };
    }
  }

  return { hasCanonicalWorkspaceId: false };
}

function isExecutionWorkspaceOpenable(workspace: FrontendWorkspaceMetadata | undefined): boolean {
  if (!workspace || workspace.isRemoving === true) {
    return false;
  }
  if (!isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)) {
    return true;
  }
  return workspace.transcriptOnly === true && isCanonicalExecutionWorkspace(workspace);
}

function openWorkspaceFromContext(
  workspaceContext: ReturnType<typeof useOptionalWorkspaceContext>,
  workspace: FrontendWorkspaceMetadata | undefined
): boolean {
  if (!workspace || !isExecutionWorkspaceOpenable(workspace) || !workspaceContext) {
    return false;
  }

  workspaceContext.setSelectedWorkspace(toWorkspaceSelection(workspace));
  return true;
}

// Agent badges identify execution kind only. Workspace navigation has one explicit action.
const AgentTypeBadge: React.FC<{ type: string; className?: string }> = ({ type, className }) => (
  <span
    className={cn(
      "inline-block shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      getAgentTypeStyle(type),
      className
    )}
  >
    {type}
  </span>
);

const TaskId: React.FC<{ id: string; className?: string }> = ({ id, className }) => {
  const { copied, copyToClipboard } = useCopyToClipboard();

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
            void copyToClipboard(id);
          }}
        >
          {id}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy task ID"}</TooltipContent>
    </Tooltip>
  );
};

const OpenWorkspaceButton: React.FC<{
  taskId: string;
  workspaceId?: string;
  className?: string;
}> = (props) => {
  const workspaceContext = useOptionalWorkspaceContext();
  const target = resolveExecutionWorkspaceTarget(
    workspaceContext?.workspaceMetadata,
    props.taskId,
    props.workspaceId
  );
  if (!workspaceContext || !isExecutionWorkspaceOpenable(target.workspace)) {
    return null;
  }

  return (
    <button
      type="button"
      aria-label="Open workspace"
      className={cn(
        "text-link inline-flex shrink-0 items-center gap-1 text-[10px] font-medium underline-offset-2 hover:underline",
        props.className
      )}
      onClick={(event) => {
        event.stopPropagation();
        openWorkspaceFromContext(workspaceContext, target.workspace);
      }}
    >
      <ArrowUpRight aria-hidden="true" className="size-3" />
      <span className="[@container(max-width:350px)]:hidden">Open workspace</span>
    </button>
  );
};

function formatExecutionProjectContext(workspace: FrontendWorkspaceMetadata): string {
  const subProjectPath = trimToNonEmptyString(workspace.subProjectPath);
  if (!subProjectPath) {
    return workspace.projectName;
  }

  const projectPrefix = `${workspace.projectPath.replace(/[\\/]+$/, "")}/`;
  const relativeSubProject = subProjectPath.startsWith(projectPrefix)
    ? subProjectPath.slice(projectPrefix.length)
    : subProjectPath.split(/[\\/]/).filter(Boolean).at(-1);
  return relativeSubProject
    ? `${workspace.projectName} / ${relativeSubProject}`
    : workspace.projectName;
}

const ExecutionWorkspaceContext: React.FC<{
  taskId: string;
  workspaceId?: string;
  executionTitle?: string;
}> = (props) => {
  const workspaceContext = useOptionalWorkspaceContext();
  const target = resolveExecutionWorkspaceTarget(
    workspaceContext?.workspaceMetadata,
    props.taskId,
    props.workspaceId
  );
  if (!target.workspace) {
    return null;
  }

  const workspaceTitle = getTaskToolWorkspaceTitle(target.workspace);
  const showWorkspaceTitle =
    workspaceTitle != null &&
    normalizeTaskTitle(workspaceTitle) !== normalizeTaskTitle(props.executionTitle);

  return (
    <div
      data-execution-workspace-context
      className="text-muted mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px]"
    >
      {showWorkspaceTitle && (
        <span className="max-w-full min-w-0 truncate">workspace: {workspaceTitle}</span>
      )}
      <span className="max-w-full min-w-0 truncate">
        {showWorkspaceTitle && <span aria-hidden="true">· </span>}
        {formatExecutionProjectContext(target.workspace)}
      </span>
    </div>
  );
};

interface TaskRowProps {
  taskId: string;
  status: string;
  agentType?: string;
  title?: string;
  depth?: number;
  startedAtMs?: number;
  workspaceId?: string;
  className?: string;
  variant?: "default" | "await";
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

const TaskRow: React.FC<TaskRowProps> = (props) => {
  if (props.variant === "await") {
    return (
      <div
        className={cn(
          "border-border-light/60 bg-surface-primary/40 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md border px-2.5 py-2",
          props.className
        )}
      >
        <div className="min-w-0">
          {props.title ? (
            <div className="text-foreground truncate text-[11px] font-medium">{props.title}</div>
          ) : (
            <TaskId id={props.taskId} className="text-secondary opacity-100" />
          )}
          <ExecutionWorkspaceContext
            taskId={props.taskId}
            workspaceId={props.workspaceId}
            executionTitle={props.title}
          />
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {props.title && <TaskId id={props.taskId} />}
            {props.agentType && <AgentTypeBadge type={props.agentType} />}
            {typeof props.depth === "number" && props.depth > 0 && (
              <span className="text-muted text-[10px]">depth {props.depth}</span>
            )}
            <TaskRowElapsed startedAtMs={props.startedAtMs} status={props.status} />
            <OpenWorkspaceButton taskId={props.taskId} workspaceId={props.workspaceId} />
          </div>
        </div>
        <TaskStatusBadge status={props.status} />
      </div>
    );
  }

  return (
    <div className={cn("bg-code-bg min-w-0 rounded-sm p-2", props.className)}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <TaskId id={props.taskId} />
        <TaskStatusBadge status={props.status} />
        {props.agentType && <AgentTypeBadge type={props.agentType} />}
        {props.title && (
          <span className="text-foreground max-w-[200px] min-w-0 truncate text-[11px]">
            {props.title}
          </span>
        )}
        {typeof props.depth === "number" && props.depth > 0 && (
          <span className="text-muted text-[10px]">depth: {props.depth}</span>
        )}
        <TaskRowElapsed startedAtMs={props.startedAtMs} status={props.status} />
        <OpenWorkspaceButton taskId={props.taskId} workspaceId={props.workspaceId} />
      </div>
      <ExecutionWorkspaceContext
        taskId={props.taskId}
        workspaceId={props.workspaceId}
        executionTitle={props.title}
      />
    </div>
  );
};

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

function isWorkflowRunTaskHandleId(taskId: string): boolean {
  return taskId.startsWith("wfr_");
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
  workspaceId?: string;
  groupKind?: TaskGroupKind;
  label?: string;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  attachFiles?: readonly TaskAttachFileArtifact[];
  error?: string;
}

interface TaskAiSettingsInfo {
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

const TaskAiSettingsDisplay: React.FC<TaskAiSettingsInfo & { className?: string }> = (props) => {
  if (!props.modelString && props.thinkingLevel == null) {
    return null;
  }
  return (
    // min-w-0 at both flex levels + break-words let long custom model IDs wrap inside
    // narrow cards instead of forcing right-edge overflow.
    <span
      className={cn(
        "text-muted inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5 break-words",
        props.className
      )}
      data-task-ai-settings
    >
      {props.modelString && (
        <span className="min-w-0">
          <ModelDisplay modelString={props.modelString} />
        </span>
      )}
      {props.thinkingLevel != null && (
        <span className="rounded bg-[var(--color-bg-tertiary)] px-1 py-0.5 font-mono leading-none">
          thinking: {getThinkingOptionLabel(props.thinkingLevel, props.modelString)}
        </span>
      )}
    </span>
  );
};

interface TaskToolOwnReport {
  reportMarkdown: string;
  title?: string;
  groupKind?: TaskGroupKind;
  label?: string;
  attachFiles?: readonly TaskAttachFileArtifact[];
}

function formatAttachFileArtifactSummary(
  attachFiles: readonly TaskAttachFileArtifact[] | undefined
): string | null {
  if (attachFiles == null || attachFiles.length === 0) {
    return null;
  }

  const first = attachFiles[0];
  const pathSegments = first.path.split(/[\\/]/);
  const label = first.filename ?? pathSegments.at(-1) ?? first.mediaType;
  return attachFiles.length === 1
    ? `Attachment available: ${label}`
    : `${attachFiles.length} attachments available: ${label} +${attachFiles.length - 1}`;
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
  workspaceId: string;
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
  metadata: FrontendWorkspaceMetadata | null | undefined
): string | undefined {
  if (hasNonEmptyText(metadata?.taskLaunchError)) {
    return "error";
  }

  switch (metadata?.taskStatus) {
    case "reported":
      return "completed";
    case "queued":
    case "running":
    case "awaiting_report":
    case "interrupted":
      return metadata.taskStatus;
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

    const taskId = normalizeTaskId(metadata.executionId);
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
      workspaceId: metadata.id,
      index: metadata.bestOf.index,
      status: getTaskToolWorkspaceStatus(metadata),
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
  aiSettingsByTaskId: Map<string, TaskAiSettingsInfo>;
} {
  const taskIds = new Set<string>();
  const statusByTaskId = new Map<string, string>();
  const ownReportsByTaskId = new Map<string, TaskToolOwnReport>();
  const taskGroupsByTaskId = new Map<string, { groupKind?: TaskGroupKind; label?: string }>();
  const workspaceIdByTaskId = new Map<string, string>();
  const aiSettingsByTaskId = new Map<string, TaskAiSettingsInfo>();
  if (!result) {
    return {
      taskIds: [],
      statusByTaskId,
      ownReportsByTaskId,
      taskGroupsByTaskId,
      workspaceIdByTaskId,
      aiSettingsByTaskId,
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

  const rememberAiSettings = (taskId: string, settings: TaskAiSettingsInfo): void => {
    const modelString = trimToNonEmptyString(settings.modelString) ?? undefined;
    if (!modelString && settings.thinkingLevel == null) {
      return;
    }
    const existing = aiSettingsByTaskId.get(taskId);
    aiSettingsByTaskId.set(taskId, {
      modelString: existing?.modelString ?? modelString,
      thinkingLevel: existing?.thinkingLevel ?? settings.thinkingLevel,
    });
  };

  const taskStatuses = "tasks" in result && Array.isArray(result.tasks) ? result.tasks : undefined;
  const singleTaskId = rememberTaskId(result.taskId);
  if (singleTaskId) {
    rememberWorkspace(singleTaskId, result.workspaceId);
    rememberAiSettings(singleTaskId, result);
  }
  if (singleTaskId && result.status === "completed" && typeof result.reportMarkdown === "string") {
    ownReportsByTaskId.set(singleTaskId, {
      reportMarkdown: result.reportMarkdown,
      title: result.title,
      attachFiles: result.artifacts?.attachFiles,
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
        rememberAiSettings(taskId, task);
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
        rememberAiSettings(taskId, report);
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
    aiSettingsByTaskId,
  };
}

function getAggregateTaskStatus(
  displayEntries: readonly TaskToolDisplayEntry[],
  fallbackStatus: TaskToolSuccessResult["status"] | undefined
): string | undefined {
  if (displayEntries.length === 0) {
    return fallbackStatus;
  }
  if (displayEntries.some((entry) => entry.status === "error" || entry.status === "failed")) {
    return "error";
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

const TaskReportMarkdown: React.FC<{ content: string; className?: string }> = (props) => (
  <MarkdownRenderer
    content={props.content}
    className={cn("compact-report-markdown", props.className)}
  />
);

const TaskToolCandidateCard: React.FC<{
  entry: TaskToolDisplayEntry;
  index: number;
  total: number;
  groupKind: TaskGroupKind;
  onOpenLegacyTranscript: (taskId: string) => void;
}> = ({ entry, index, total, groupKind, onOpenLegacyTranscript }) => {
  const workspaceContext = useOptionalWorkspaceContext();
  const target = resolveExecutionWorkspaceTarget(
    workspaceContext?.workspaceMetadata,
    entry.taskId,
    entry.workspaceId
  );
  const canViewLegacyTranscript =
    entry.status === "completed" && !target.hasCanonicalWorkspaceId && !target.workspace;
  const hasReport = hasNonEmptyText(entry.reportMarkdown);
  const attachmentSummary = formatAttachFileArtifactSummary(entry.attachFiles);
  const memberLabel = formatTaskGroupMemberLabel({
    kind: entry.groupKind ?? groupKind,
    index,
    label: entry.label,
  });

  return (
    <div className="bg-code-bg rounded-sm p-2">
      <div className={cn("flex min-w-0 flex-wrap items-center gap-2", hasReport && "mb-2")}>
        {total > 1 && <span className="text-muted text-[10px]">{memberLabel}</span>}
        <TaskId id={entry.taskId} />
        <TaskStatusBadge status={entry.status} />
        {entry.title && (
          <span className="text-foreground max-w-full min-w-0 truncate text-[11px] font-medium">
            {entry.title}
          </span>
        )}
        <TaskAiSettingsDisplay
          modelString={entry.modelString}
          thinkingLevel={entry.thinkingLevel}
          className="text-[10px]"
        />
        <OpenWorkspaceButton taskId={entry.taskId} workspaceId={entry.workspaceId} />
        {canViewLegacyTranscript && (
          <button
            type="button"
            className="text-link text-[10px] font-medium underline-offset-2 hover:underline"
            onClick={() => {
              onOpenLegacyTranscript(entry.taskId);
            }}
          >
            View legacy transcript
          </button>
        )}
      </div>
      <ExecutionWorkspaceContext
        taskId={entry.taskId}
        workspaceId={entry.workspaceId}
        executionTitle={entry.title}
      />

      {entry.error && <div className="text-danger mb-1 text-[10px]">{entry.error}</div>}
      {attachmentSummary && <div className="text-muted mb-1 text-[10px]">{attachmentSummary}</div>}
      {hasReport && entry.reportMarkdown && <TaskReportMarkdown content={entry.reportMarkdown} />}
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
    aiSettingsByTaskId,
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
  for (const entry of recoveredWorkspaceEntries) {
    workspaceIdByTaskId.set(entry.taskId, entry.workspaceId);
  }
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
    const canonicalWorkspaceId = workspaceIdByTaskId.get(taskId);
    const linkedReport = canonicalWorkspaceId
      ? taskReportLinking?.reportByWorkspaceId.get(canonicalWorkspaceId)
      : taskReportLinking?.reportByTaskId.get(taskId);
    const target = resolveExecutionWorkspaceTarget(workspaceMetadata, taskId, canonicalWorkspaceId);
    const metadata = target.workspace;
    const resultTaskGroup = taskGroupsByTaskId.get(taskId);
    const reportMarkdown = hasNonEmptyText(ownReport?.reportMarkdown)
      ? ownReport.reportMarkdown
      : linkedReport?.reportMarkdown;
    const reportTitle = ownReport?.title ?? linkedReport?.title;
    const derivedStatus =
      (ownReport ?? linkedReport)
        ? "completed"
        : (getTaskToolWorkspaceStatus(metadata) ?? statusByTaskId.get(taskId));

    const resultAiSettings = aiSettingsByTaskId.get(taskId);

    return {
      taskId,
      status:
        derivedStatus ?? (status === "executing" ? "running" : (successResult?.status ?? "queued")),
      title: isTaskGroup ? (reportTitle ?? title) : title,
      reportMarkdown,
      workspaceId: canonicalWorkspaceId,
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
      // Prefer live metadata while the workspace exists: a plan child's auto-handoff to
      // exec rewrites its settings after launch, so a spawn snapshot can go stale. After
      // cleanup, a linked task_await report carries report-time settings; the spawn
      // result is the last resort.
      modelString:
        metadata?.taskModelString ?? linkedReport?.modelString ?? resultAiSettings?.modelString,
      thinkingLevel:
        metadata?.taskThinkingLevel ??
        linkedReport?.thinkingLevel ??
        resultAiSettings?.thinkingLevel,
      error: trimToNonEmptyString(metadata?.taskLaunchError) ?? undefined,
      attachFiles: ownReport?.attachFiles,
    };
  });

  const completedTaskGroupCount = displayEntries.filter(
    (entry) => entry.status === "completed"
  ).length;
  const hasAnyReport = displayEntries.some((entry) => hasNonEmptyText(entry.reportMarkdown));
  const aggregateTaskStatus = getAggregateTaskStatus(displayEntries, successResult?.status);

  const interruption =
    successResult?.status !== "completed" ? successResult?.interruption : undefined;
  const interruptionReport =
    interruption?.reason === "progress_report_received" ? interruption.report : undefined;
  const headerLabel =
    interruption?.reason === "progress_report_received"
      ? "Wait paused for subagent update"
      : interruption?.reason === "message_queued"
        ? "Wait paused for queued message"
        : "task";

  const effectiveStatus: ToolStatus =
    aggregateTaskStatus === "completed"
      ? "completed"
      : aggregateTaskStatus === "error"
        ? "failed"
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
    forceExpanded:
      !!errorResult ||
      interruptionReport != null ||
      displayEntries.some((entry) => hasNonEmptyText(entry.error)),
  });

  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);
  const preview = prompt.length > 60 ? prompt.slice(0, 60).trim() + "…" : prompt.split("\n")[0];
  const collapsedPreview =
    interruptionReport?.title ??
    (isTaskGroup ? formatTaskGroupHeader(taskGroupKind, totalTaskGroupCount, preview) : preview);
  const singleEntry = !isTaskGroup ? displayEntries[0] : undefined;
  const singleAttachmentSummary = formatAttachFileArtifactSummary(singleEntry?.attachFiles);
  const singleTarget = singleEntry
    ? resolveExecutionWorkspaceTarget(
        workspaceMetadata,
        singleEntry.taskId,
        singleEntry.workspaceId
      )
    : undefined;
  const canViewSingleLegacyTranscript = Boolean(
    singleEntry?.status === "completed" &&
    singleTarget &&
    !singleTarget.hasCanonicalWorkspaceId &&
    !singleTarget.workspace
  );
  const kindBadge = <AgentTypeBadge type={taskKindLabel} />;
  const createdTaskGroupCount = taskIds.length;
  const shouldShowCreationProgress =
    isTaskGroup &&
    !errorResult &&
    status === "executing" &&
    createdTaskGroupCount < totalTaskGroupCount;

  return (
    <ToolContainer expanded={expanded} data-component="TaskToolCall">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task" />
        <ToolName>{headerLabel}</ToolName>
        {kindBadge}
        {singleEntry && (
          <OpenWorkspaceButton taskId={singleEntry.taskId} workspaceId={singleEntry.workspaceId} />
        )}
        {isTaskGroup && (
          <span className="text-muted text-[10px]">
            {formatTaskGroupSummary(taskGroupKind, totalTaskGroupCount).toLowerCase()}
          </span>
        )}
        {isBackground && interruption == null && (
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
                singleEntry?.taskId && <TaskId id={singleEntry.taskId} />
              )}
              {!isTaskGroup && singleEntry?.status && (
                <TaskStatusBadge status={singleEntry.status} />
              )}
              {!isTaskGroup && singleEntry && (
                <TaskAiSettingsDisplay
                  modelString={singleEntry.modelString}
                  thinkingLevel={singleEntry.thinkingLevel}
                  className="text-[10px]"
                />
              )}
              {!isTaskGroup && canViewSingleLegacyTranscript && singleEntry && (
                <button
                  type="button"
                  className="text-link text-[10px] font-medium underline-offset-2 hover:underline"
                  onClick={() => {
                    setTranscriptTaskId(singleEntry.taskId);
                  }}
                >
                  View legacy transcript
                </button>
              )}
              {!isTaskGroup && singleEntry && (
                <div className="basis-full">
                  <ExecutionWorkspaceContext
                    taskId={singleEntry.taskId}
                    workspaceId={singleEntry.workspaceId}
                    executionTitle={singleEntry.title}
                  />
                </div>
              )}
            </div>

            {interruptionReport && (
              <div className="border-task-mode/20 bg-task-mode/5 mb-2 rounded-md border p-2">
                <div className="text-foreground mb-1 text-[11px] font-medium">
                  {interruptionReport.title}
                </div>
                <TaskReportMarkdown content={interruptionReport.reportMarkdown} />
              </div>
            )}

            <div className="mb-2">
              <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">Prompt</div>
              <div className="text-foreground bg-code-bg max-h-[140px] overflow-y-auto rounded-sm p-2 text-[11px] break-words whitespace-pre-wrap">
                {prompt}
              </div>
            </div>

            {!isTaskGroup && singleEntry?.error && (
              <ErrorBox className="mb-2">{singleEntry.error}</ErrorBox>
            )}

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
                      onOpenLegacyTranscript={setTranscriptTaskId}
                    />
                  ))}
                </div>
              </div>
            ) : (
              (singleEntry?.reportMarkdown != null || singleAttachmentSummary != null) && (
                <div className="task-divider border-t pt-2">
                  {singleAttachmentSummary && (
                    <div className="text-muted mb-1 text-[10px]">{singleAttachmentSummary}</div>
                  )}
                  {singleEntry?.reportMarkdown && (
                    <>
                      <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">
                        Report
                      </div>
                      <TaskReportMarkdown content={singleEntry.reportMarkdown} />
                    </>
                  )}
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

function isInterruptedTaskAwaitResult(
  result: TaskAwaitToolSuccessResult["results"][number]
): boolean {
  return (
    result.status === "interrupted" ||
    (result.status === "error" && result.error.trim().toLowerCase() === "interrupted")
  );
}

interface TaskAwaitToolCallProps {
  args: TaskAwaitToolArgs;
  result?: TaskAwaitToolSuccessResult | ToolErrorResult;
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
  const callError = isToolErrorResult(result) ? result.error : undefined;
  const results = result && "results" in result ? result.results : [];
  const interruption = result && "interruption" in result ? result.interruption : undefined;
  const interruptionReport =
    interruption?.reason === "progress_report_received" ? interruption.report : undefined;

  const suppressReportInAwaitWorkspaceIds = taskReportLinking?.suppressReportInAwaitWorkspaceIds;
  const suppressReportInAwaitTaskIds = taskReportLinking?.suppressReportInAwaitTaskIds;

  const showConfigInfo =
    taskIds != null || timeoutSecs != null || args.filter != null || args.filter_exclude === true;

  // Summary for header
  const completedCount = results.filter((r) => r.status === "completed").length;
  const totalCount = results.length;
  const failedCount = results.filter(
    (r) =>
      !isInterruptedTaskAwaitResult(r) &&
      (r.status === "error" || r.status === "invalid_scope" || r.status === "not_found")
  ).length;
  const interruptedCount = results.filter(isInterruptedTaskAwaitResult).length;

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

      const target = resolveExecutionWorkspaceTarget(workspaceMetadata, taskId);
      const metadata = target.workspace;
      if (!metadata) {
        awaitedRows.push({ taskId, status: "waiting" });
        continue;
      }

      const resolvedAgentType = resolvePersistedAgentId(metadata, "");
      const agentType = resolvedAgentType.length > 0 ? resolvedAgentType : undefined;
      const executionTitle = taskReportLinking?.spawnTitleByTaskId.get(taskId);

      awaitedRows.push({
        taskId,
        status: getTaskToolWorkspaceStatus(metadata) ?? "waiting",
        agentType,
        title: executionTitle,
        depth:
          workspaceId && workspaceMetadata
            ? computeWorkspaceDepthFromRoot(workspaceId, metadata.id, workspaceMetadata)
            : undefined,
        startedAtMs: parseWorkspaceCreatedAtMs(metadata.createdAt),
        workspaceId: metadata.id,
      });
    }
  }

  const pendingCount = totalCount - completedCount - failedCount - interruptedCount;
  const targetCount = totalCount > 0 ? totalCount : taskIds?.length;
  const formatTasks = (count: number) => `${count} ${count === 1 ? "task" : "tasks"}`;

  // "N tasks completed" alone says nothing about what finished; surface each completed
  // task's available kind and spawn intent/title in the collapsed row.
  const completedTaskDetails: string[] = [];
  for (const taskResult of results) {
    if (taskResult.status !== "completed") continue;
    const completedTaskId = taskResult.taskId;
    const resultWorkspaceId = trimToNonEmptyString(taskResult.workspaceId) ?? undefined;
    const target = resolveExecutionWorkspaceTarget(
      workspaceMetadata,
      completedTaskId,
      resultWorkspaceId
    );
    const bashSpawn = taskReportLinking?.bashSpawnByTaskId.get(completedTaskId);
    const canonicalAgentType = resultWorkspaceId
      ? (taskReportLinking?.spawnAgentTypeByWorkspaceId.get(resultWorkspaceId) ??
        (target.workspace ? resolvePersistedAgentId(target.workspace, "") : undefined))
      : undefined;
    const kind = fromBashTaskId(completedTaskId)
      ? "bash"
      : isWorkflowRunTaskHandleId(completedTaskId)
        ? "workflow"
        : taskResult.handleKind === "workspace_turn"
          ? "workspace"
          : (trimToNonEmptyString(canonicalAgentType) ??
            (resultWorkspaceId
              ? undefined
              : taskReportLinking?.spawnAgentTypeByTaskId.get(completedTaskId)));
    // Spawn-side intent first (bash model_intent, task execution title); the report title is
    // only a fallback. Canonical execution cards link by workspaceId, never opaque taskId.
    const description =
      (bashSpawn
        ? sanitizeDisplayableModelIntent(bashSpawn.modelIntent, bashSpawn.script)
        : undefined) ??
      trimToNonEmptyString(
        resultWorkspaceId
          ? taskReportLinking?.spawnTitleByWorkspaceId.get(resultWorkspaceId)
          : taskReportLinking?.spawnTitleByTaskId.get(completedTaskId)
      ) ??
      trimToNonEmptyString(taskResult.title);
    const detail = [kind, description].filter((part): part is string => part != null).join(" · ");
    if (detail.length > 0) completedTaskDetails.push(detail);
  }

  let summaryTitle: string;
  let summaryDetail: string | undefined;
  let summaryTone: "active" | "danger" | "interrupted" | "success" | "waiting";
  if (callError != null || status === "failed") {
    summaryTitle = "Task wait failed";
    summaryDetail = callError;
    summaryTone = "danger";
  } else if (failedCount > 0) {
    summaryTitle = `${formatTasks(failedCount)} failed`;
    summaryDetail = completedCount > 0 ? `${completedCount} completed` : undefined;
    summaryTone = "danger";
  } else if (status === "interrupted" && interruptedCount === 0) {
    summaryTitle = "Task wait interrupted";
    summaryTone = "interrupted";
  } else if (interruptedCount > 0) {
    summaryTitle = `${formatTasks(interruptedCount)} interrupted`;
    summaryDetail = [
      pendingCount > 0 ? `${formatTasks(pendingCount)} still active` : undefined,
      completedCount > 0 ? `${completedCount} completed` : undefined,
    ]
      .filter((detail): detail is string => detail != null)
      .join(" · ");
    summaryDetail = summaryDetail.length > 0 ? summaryDetail : undefined;
    summaryTone = "interrupted";
  } else if (status === "executing") {
    summaryTitle = targetCount
      ? `Waiting for ${formatTasks(targetCount)}`
      : "Waiting for background work";
    summaryTone = "active";
  } else if (interruption?.reason === "progress_report_received") {
    summaryTitle = "Wait paused for subagent update";
    summaryDetail = interruption.report.title;
    summaryTone = "waiting";
  } else if (interruption?.reason === "message_queued") {
    summaryTitle = "Wait paused for queued message";
    summaryDetail = pendingCount > 0 ? `${formatTasks(pendingCount)} still active` : undefined;
    summaryTone = "waiting";
  } else if (pendingCount > 0) {
    summaryTitle = `Still waiting for ${formatTasks(pendingCount)}`;
    summaryDetail = completedCount > 0 ? `${completedCount} completed` : undefined;
    summaryTone = "waiting";
  } else if (completedCount > 0) {
    summaryTitle = `${formatTasks(completedCount)} completed`;
    summaryDetail = completedTaskDetails.length === 1 ? completedTaskDetails[0] : undefined;
    summaryTone = "success";
  } else {
    summaryTitle = "Checked task status";
    summaryTone = "waiting";
  }

  // task_await commonly appears several times during one turn. Give each poll a compact,
  // semantic timeline row instead of repeating the full generic tool chrome, while keeping
  // failures expanded so the actionable details are never hidden.
  const { expanded, toggleExpanded } = useStickyExpand("tools", false, {
    forceExpanded:
      callError != null || status === "failed" || failedCount > 0 || interruptionReport != null,
  });

  const SummaryIcon =
    summaryTone === "active"
      ? LoaderCircle
      : summaryTone === "danger"
        ? CircleAlert
        : summaryTone === "success"
          ? CircleCheck
          : summaryTone === "interrupted"
            ? CircleAlert
            : Clock3;

  return (
    <ToolContainer
      expanded={expanded}
      data-component="TaskAwaitToolCall"
      className={cn("my-1 bg-transparent px-2 py-1.5", expanded && "bg-surface-secondary/40")}
    >
      <ToolHeader
        onClick={toggleExpanded}
        className="group min-h-5 gap-2"
        aria-label={`${summaryTitle}. Show task wait details`}
      >
        <ToolIcon
          toolName="task_await"
          className={cn(
            "[&_svg]:size-3.5",
            summaryTone === "active" && "text-task-mode",
            summaryTone === "danger" && "text-danger",
            summaryTone === "success" && "text-success",
            summaryTone === "interrupted" && "text-interrupted",
            summaryTone === "waiting" && "text-muted"
          )}
        />
        <SummaryIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0",
            summaryTone === "active" && "text-task-mode animate-spin",
            summaryTone === "danger" && "text-danger",
            summaryTone === "success" && "text-success",
            summaryTone === "interrupted" && "text-interrupted",
            summaryTone === "waiting" && "text-muted"
          )}
        />
        <span
          data-component="TaskAwaitSummary"
          className="counter-nums min-w-0 flex-1 truncate text-[11px] leading-5"
        >
          <span
            className={cn(
              summaryTone === "active" ? "text-foreground" : "text-secondary",
              summaryTone === "danger" && "text-danger",
              summaryTone === "interrupted" && "text-interrupted"
            )}
          >
            {summaryTitle}
          </span>
          {summaryDetail && <span className="text-muted"> · {summaryDetail}</span>}
        </span>
        {status === "executing" && (
          <span className="text-muted counter-nums text-[10px] whitespace-nowrap [@container(max-width:350px)]:hidden">
            <ElapsedTimeDisplay startedAt={startedAt} isActive={true} separator="" prefix="" />
          </span>
        )}
        <ExpandIcon expanded={expanded} className="text-muted group-hover:text-secondary shrink-0">
          ▶
        </ExpandIcon>
      </ToolHeader>

      {/* Align collapsed details with the header text; expanded mode already lists per-task rows. */}
      {!expanded && summaryTone === "success" && completedTaskDetails.length > 1 && (
        <div data-component="TaskAwaitCompletedList" className="mt-0.5 pl-[42px]">
          {completedTaskDetails.map((detail, idx) => (
            <div key={idx} className="text-muted truncate text-[10px] leading-4">
              {detail}
            </div>
          ))}
        </div>
      )}

      {expanded && (
        <ToolDetails className="mt-1.5 border-t-0 pt-0">
          <div
            data-component="TaskAwaitDetails"
            className="border-task-mode/20 bg-task-mode/5 overflow-hidden rounded-lg border"
          >
            {showConfigInfo && (
              <div className="border-task-mode/10 bg-surface-secondary/40 text-muted flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-[10px]">
                {taskIds != null && <span>{formatTasks(taskIds.length)}</span>}
                {timeoutSecs != null && <span>· {timeoutSecs}s timeout</span>}
                {args.filter != null && <span className="truncate">· filter {args.filter}</span>}
                {args.filter_exclude === true && <span>· excluding matches</span>}
              </div>
            )}

            {interruptionReport && (
              <div className="border-task-mode/20 bg-surface-primary/60 m-2 rounded-md border p-2.5">
                <div className="text-foreground mb-1 text-[11px] font-medium">
                  {interruptionReport.title}
                </div>
                <TaskReportMarkdown content={interruptionReport.reportMarkdown} />
              </div>
            )}

            {callError && <ErrorBox className="m-2">{callError}</ErrorBox>}

            {/* Results */}
            {results.length > 0 ? (
              <div className="space-y-1.5 p-2">
                {results.map((r, idx) => {
                  const taskId = typeof r.taskId === "string" ? r.taskId : null;

                  const resultWorkspaceId =
                    "workspaceId" in r
                      ? (trimToNonEmptyString(r.workspaceId) ?? undefined)
                      : undefined;
                  const spawnTitle = taskId
                    ? resultWorkspaceId
                      ? taskReportLinking?.spawnTitleByWorkspaceId.get(resultWorkspaceId)
                      : taskReportLinking?.spawnTitleByTaskId.get(taskId)
                    : undefined;
                  const suppressReport = resultWorkspaceId
                    ? suppressReportInAwaitWorkspaceIds?.has(resultWorkspaceId)
                    : taskId
                      ? suppressReportInAwaitTaskIds?.has(taskId)
                      : false;

                  return (
                    <TaskAwaitResult
                      key={taskId ?? idx}
                      result={r}
                      fallbackTitle={trimToNonEmptyString(spawnTitle) ?? undefined}
                      suppressReport={suppressReport}
                    />
                  );
                })}
              </div>
            ) : status === "executing" ? (
              <>
                <div className="space-y-1.5 p-2">
                  {awaitedRows.map((row) => (
                    <TaskRow key={row.taskId} {...row} variant="await" />
                  ))}
                </div>
                <div className="border-task-mode/10 text-muted flex items-center gap-1.5 border-t px-3 py-2 text-[10px]">
                  <LoaderCircle className="text-task-mode size-3 animate-spin" />
                  Listening for task updates
                  <LoadingDots />
                </div>
              </>
            ) : (
              <div className="text-muted px-3 py-2 text-[11px] italic">No tasks specified</div>
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

  const title = trimToNonEmptyString(fallbackTitle) ?? reportTitle ?? undefined;

  const output = "output" in result ? result.output : undefined;
  const note = "note" in result ? result.note : undefined;
  const exitCode = "exitCode" in result ? result.exitCode : undefined;

  const gitPatchArtifact =
    result.status === "completed" ? result.artifacts?.gitFormatPatch : undefined;

  const patchSummary = formatGitPatchArtifactSummary(gitPatchArtifact);
  const attachmentSummary =
    result.status === "completed"
      ? formatAttachFileArtifactSummary(result.artifacts?.attachFiles)
      : null;
  const elapsedMs = "elapsed_ms" in result ? result.elapsed_ms : undefined;

  const workspaceId = "workspaceId" in result ? result.workspaceId : undefined;

  const showReport = !suppressReport;

  return (
    <div className="border-border-light/60 bg-surface-primary/40 rounded-md border px-2.5 py-2">
      <div className="mb-1 grid grid-cols-[minmax(0,1fr)_auto] gap-2">
        <div className="min-w-0">
          {title ? (
            <div className="text-foreground truncate text-[11px] font-medium">{title}</div>
          ) : (
            <TaskId id={result.taskId} className="text-secondary opacity-100" />
          )}
          <ExecutionWorkspaceContext
            taskId={result.taskId}
            workspaceId={workspaceId}
            executionTitle={title}
          />
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            {title && <TaskId id={result.taskId} />}
            <OpenWorkspaceButton taskId={result.taskId} workspaceId={workspaceId} />
            {exitCode !== undefined && (
              <span className="text-muted text-[10px]">exit {exitCode}</span>
            )}
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
                    className="text-muted hover:text-secondary rounded p-0.5 transition-colors"
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
        </div>
        <TaskStatusBadge status={result.status} />
      </div>

      {patchSummary && <div className="text-muted text-[10px]">{patchSummary}</div>}
      {attachmentSummary && <div className="text-muted text-[10px]">{attachmentSummary}</div>}

      {!isCompleted && output && output.length > 0 && (
        <div className="text-foreground bg-code-bg max-h-[140px] overflow-y-auto rounded-sm p-2 text-[11px] break-words whitespace-pre-wrap">
          {output}
        </div>
      )}

      {showReport && reportMarkdown && (
        <TaskReportMarkdown content={reportMarkdown} className="mt-2" />
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
    workspaceId={task.workspaceId}
  />
);

// ═══════════════════════════════════════════════════════════════════════════════
// TASK SEND MESSAGE TOOL CALL
// ═══════════════════════════════════════════════════════════════════════════════

interface TaskSendMessageToolCallProps {
  args: TaskSendMessageToolArgs;
  result?: TaskSendMessageToolSuccessResult;
  status?: ToolStatus;
}

export const TaskSendMessageToolCall: React.FC<TaskSendMessageToolCallProps> = (props) => {
  const { expanded, toggleExpanded } = useToolExpansion(false);
  const status = props.status ?? "pending";
  const summary = props.result?.status ?? "sending";
  const guidanceDelivered =
    props.result?.status === "accepted" || props.result?.status === "queued";
  const headerLabel = guidanceDelivered
    ? "Sent guidance to"
    : props.result != null || status === "failed"
      ? "Could not send guidance to"
      : "Sending guidance to";

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task_send_message" />
        <ToolName>{headerLabel}</ToolName>
        <TaskId id={props.args.task_id} className="min-w-0 truncate" />
        <span className="text-muted text-[10px]">{summary}</span>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="task-surface mt-1 space-y-2 rounded-md p-3">
            <div className="flex items-center gap-2">
              <TaskId id={props.args.task_id} />
              {props.result && <TaskStatusBadge status={props.result.status} />}
            </div>
            <div className="text-foreground bg-code-bg max-h-[140px] overflow-y-auto rounded-sm p-2 text-[11px] break-words whitespace-pre-wrap">
              {props.args.message}
            </div>
            {props.result && "error" in props.result && props.result.error && (
              <div className="text-danger text-[11px]">{props.result.error}</div>
            )}
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

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
