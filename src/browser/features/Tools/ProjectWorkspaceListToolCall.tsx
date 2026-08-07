import { ChevronRight } from "lucide-react";

import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { formatRelativeTime } from "@/browser/utils/ui/dateTime";
import { cn } from "@/common/lib/utils";
import type {
  ProjectWorkspaceListToolArgs,
  ProjectWorkspaceListToolResult,
} from "@/common/types/tools";
import { ProjectWorkspaceListToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import {
  ErrorBox,
  ExpandIcon,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  unwrapResult,
  useToolExpansion,
  type ToolStatus,
} from "./Shared/toolUtils";

type ProjectWorkspaceSummary = ProjectWorkspaceListToolResult["workspaces"][number];
type WorkspaceTurnStatus = NonNullable<ProjectWorkspaceSummary["workspaceTurn"]>["status"];

type ProjectWorkspaceListView =
  | { kind: "none" }
  | { kind: "error"; error: string }
  | { kind: "workspaces"; result: ProjectWorkspaceListToolResult };

const TURN_STATUS_CLASSES: Record<WorkspaceTurnStatus, string> = {
  queued: "bg-white/5 text-muted",
  starting: "bg-pending/10 text-pending",
  running: "bg-pending/10 text-pending",
  completed: "bg-success/10 text-success",
  interrupted: "bg-interrupted/10 text-interrupted",
  error: "bg-danger/10 text-danger",
};

function formatTurnStatus(status: WorkspaceTurnStatus): string {
  return status === "starting" ? "Starting" : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function formatRuntime(workspace: ProjectWorkspaceSummary): string | undefined {
  const runtimeConfig = workspace.runtimeConfig;
  if (runtimeConfig == null) return undefined;
  if (runtimeConfig.type === "local" && "srcBaseDir" in runtimeConfig) return "worktree";
  return runtimeConfig.type;
}

function formatExecAiSettings(workspace: ProjectWorkspaceSummary): string | undefined {
  const settings = workspace.execAiSettings;
  if (settings == null) return undefined;
  return [settings.model, settings.thinkingLevel, settings.reasoningMode]
    .filter((value): value is string => value != null)
    .join(" · ");
}

export function toProjectWorkspaceListView(result: unknown): ProjectWorkspaceListView {
  const unwrapped = unwrapResult(result);
  if (isToolErrorResult(unwrapped)) {
    return { kind: "error", error: unwrapped.error };
  }
  if (unwrapped != null && typeof unwrapped === "object" && "error" in unwrapped) {
    const error = (unwrapped as { error?: unknown }).error;
    if (typeof error === "string") {
      return { kind: "error", error };
    }
  }

  const parsed = ProjectWorkspaceListToolResultSchema.safeParse(unwrapped);
  return parsed.success ? { kind: "workspaces", result: parsed.data } : { kind: "none" };
}

function WorkspaceBadge(props: { children: string; className: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
        props.className
      )}
    >
      {props.children}
    </span>
  );
}

function ProjectWorkspaceRow(props: { workspace: ProjectWorkspaceSummary }) {
  const workspaceStore = useWorkspaceStoreRaw();
  const displayName = props.workspace.title ?? props.workspace.name;
  const canOpen = !props.workspace.archived;
  const runtime = formatRuntime(props.workspace);
  const execAiSettings = formatExecAiSettings(props.workspace);
  const content = (
    <>
      <div className="min-w-0">
        <div className="text-muted truncate text-[10px] font-medium">
          {props.workspace.projectDisplayName}
        </div>
        <div className="text-foreground truncate text-[11px] font-medium">{displayName}</div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="counter-nums-mono text-muted truncate text-[10px]">
            {props.workspace.workspaceId}
          </span>
          {runtime && <span className="text-muted text-[10px]">{runtime}</span>}
          {props.workspace.workspaceTurn && (
            <span className="counter-nums-mono text-muted truncate text-[10px]">
              {props.workspace.workspaceTurn.taskId}
            </span>
          )}
        </div>
        {execAiSettings && (
          <div className="text-muted mt-1 truncate text-[10px]">Exec: {execAiSettings}</div>
        )}
        {props.workspace.workspaceTurn?.prompt && (
          <div className="text-secondary mt-1 line-clamp-2 text-[10px]">
            {props.workspace.workspaceTurn.prompt}
          </div>
        )}
        {props.workspace.updatedAt && (
          <div className="counter-nums text-muted mt-1 truncate text-[10px]">
            Updated {formatRelativeTime(new Date(props.workspace.updatedAt).getTime())}
          </div>
        )}
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-start gap-1.5 @sm:justify-end">
        {props.workspace.archived && (
          <WorkspaceBadge className="bg-warning-overlay text-warning">Archived</WorkspaceBadge>
        )}
        {props.workspace.transcriptOnly && (
          <WorkspaceBadge className="text-secondary bg-white/5">Transcript only</WorkspaceBadge>
        )}
        {props.workspace.workspaceTurn && (
          <WorkspaceBadge className={TURN_STATUS_CLASSES[props.workspace.workspaceTurn.status]}>
            {formatTurnStatus(props.workspace.workspaceTurn.status)}
          </WorkspaceBadge>
        )}
        {canOpen && <ChevronRight aria-hidden="true" className="text-muted h-3.5 w-3.5" />}
      </div>
    </>
  );

  const className =
    "flex w-full flex-col items-stretch gap-2 px-2.5 py-2 text-left @sm:grid @sm:grid-cols-[minmax(0,1fr)_auto] @sm:items-center @sm:gap-3";

  return canOpen ? (
    <button
      type="button"
      aria-label={`Open workspace ${displayName} in ${props.workspace.projectDisplayName}`}
      className={cn(className, "cursor-pointer hover:bg-white/5")}
      onClick={() => workspaceStore.navigateToWorkspace(props.workspace.workspaceId)}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}

interface ProjectWorkspaceListToolCallProps {
  args: ProjectWorkspaceListToolArgs;
  result?: unknown;
  status?: ToolStatus;
  defaultExpanded?: boolean;
}

/** Bulk Project Chat workspace inventory with direct drill-down into active workspace transcripts. */
export function ProjectWorkspaceListToolCall(props: ProjectWorkspaceListToolCallProps) {
  const status = props.status ?? "pending";
  const { expanded, toggleExpanded } = useToolExpansion(props.defaultExpanded ?? false);
  const view = toProjectWorkspaceListView(props.result);
  const workspaces = view.kind === "workspaces" ? view.result.workspaces : [];
  const archivedCount = workspaces.filter((workspace) => workspace.archived).length;
  const activeCount = workspaces.length - archivedCount;
  const verb =
    status === "executing"
      ? "Listing project workspaces"
      : view.kind === "workspaces"
        ? "Project workspaces"
        : "List project workspaces";

  return (
    <ToolContainer expanded={expanded} className="@container">
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="project_workspace_list" />
        <ToolName className="whitespace-nowrap">{verb}</ToolName>
        {view.kind === "workspaces" && (
          <span className="text-muted whitespace-nowrap">
            {workspaces.length} {workspaces.length === 1 ? "workspace" : "workspaces"}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {view.kind === "error" && <ErrorBox>{view.error}</ErrorBox>}
          {status === "executing" && view.kind !== "error" && (
            <div className="text-muted px-1 py-1 text-[11px] italic">
              Reading project workspace state
              <LoadingDots />
            </div>
          )}
          {view.kind === "workspaces" && workspaces.length === 0 && status !== "executing" && (
            <div className="text-muted px-1 py-1 text-[11px] italic">No project workspaces yet</div>
          )}
          {workspaces.length > 0 && (
            <div className="bg-code-bg mt-1 overflow-hidden rounded-md">
              <div className="text-muted border-b border-white/10 px-2.5 py-1.5 text-[10px]">
                {activeCount} active · {archivedCount} archived
              </div>
              <div className="divide-y divide-white/10">
                {workspaces.map((workspace) => (
                  <ProjectWorkspaceRow key={workspace.workspaceId} workspace={workspace} />
                ))}
              </div>
            </div>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
