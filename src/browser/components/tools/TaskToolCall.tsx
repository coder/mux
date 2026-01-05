import React from "react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  LoadingDots,
} from "./shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import {
  useOptionalWorkspaceContext,
  toWorkspaceSelection,
} from "@/browser/contexts/WorkspaceContext";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import type {
  TaskToolArgs,
  TaskToolSuccessResult,
  TaskAwaitToolArgs,
  TaskAwaitToolSuccessResult,
  TaskListToolArgs,
  TaskListToolSuccessResult,
  TaskTerminateToolArgs,
  TaskTerminateToolSuccessResult,
} from "@/common/types/tools";

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
      case "awaiting_report":
        return "bg-pending/20 text-pending";
      case "queued":
        return "bg-muted/20 text-muted";
      case "terminated":
        return "bg-interrupted/20 text-interrupted";
      case "not_found":
      case "invalid_scope":
      case "error":
        return "bg-danger/20 text-danger";
      default:
        return "bg-muted/20 text-muted";
    }
  };

  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        getStatusStyle(),
        className
      )}
    >
      {status}
    </span>
  );
};

// Agent type badge
const AgentTypeBadge: React.FC<{
  type: string;
  className?: string;
}> = ({ type, className }) => {
  const getTypeStyle = () => {
    switch (type) {
      case "explore":
        return "border-plan-mode/50 text-plan-mode";
      case "exec":
        return "border-exec-mode/50 text-exec-mode";
      default:
        return "border-muted/50 text-muted";
    }
  };

  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        getTypeStyle(),
        className
      )}
    >
      {type}
    </span>
  );
};

// Task ID display with open/copy affordance.
// - If the task workspace exists locally, clicking opens it.
// - Otherwise, clicking copies the ID (so the user can search / share it).
const TaskId: React.FC<{ id: string; className?: string }> = ({ id, className }) => {
  const workspaceContext = useOptionalWorkspaceContext();
  const { copied, copyToClipboard } = useCopyToClipboard();

  const workspace = workspaceContext?.workspaceMetadata.get(id);

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
            if (workspace && workspaceContext) {
              workspaceContext.setSelectedWorkspace(toWorkspaceSelection(workspace));
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

// ═══════════════════════════════════════════════════════════════════════════════
// TASK TOOL CALL (spawn sub-agent)
// ═══════════════════════════════════════════════════════════════════════════════

interface TaskToolCallProps {
  args: TaskToolArgs;
  result?: TaskToolSuccessResult;
  status?: ToolStatus;
}

export const TaskToolCall: React.FC<TaskToolCallProps> = ({ args, result, status = "pending" }) => {
  // Default expand for completed tasks with reports
  const hasReport = result?.status === "completed" && !!result.reportMarkdown;
  const { expanded, toggleExpanded } = useToolExpansion(hasReport);

  const isBackground = args.run_in_background;

  const title = args.title ?? "Task";
  const prompt = args.prompt ?? "";
  const agentType = args.agentId ?? args.subagent_type ?? "unknown";
  const kindBadge = <AgentTypeBadge type={agentType} />;

  // Derive task state from result
  const taskId = result?.taskId;
  const taskStatus = result?.status;
  const reportMarkdown = result?.status === "completed" ? result.reportMarkdown : undefined;
  const reportTitle = result?.status === "completed" ? result.title : undefined;

  // Show preview (first line or truncated)
  const preview = prompt.length > 60 ? prompt.slice(0, 60).trim() + "…" : prompt.split("\n")[0];

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task" />
        <ToolName>task</ToolName>
        {kindBadge}
        {isBackground && (
          <span className="text-backgrounded text-[10px] font-medium">background</span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {/* Task info surface */}
          <div className="task-surface mt-1 rounded-md p-3">
            <div className="task-divider mb-2 flex flex-wrap items-center gap-2 border-b pb-2">
              <span className="text-task-mode text-[12px] font-semibold">
                {reportTitle ?? title}
              </span>
              {taskId && <TaskId id={taskId} />}
              {taskStatus && <TaskStatusBadge status={taskStatus} />}
            </div>

            {/* Prompt / script */}
            <div className="mb-2">
              <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">Prompt</div>
              <div className="text-foreground bg-code-bg max-h-[140px] overflow-y-auto rounded-sm p-2 text-[11px] break-words whitespace-pre-wrap">
                {prompt}
              </div>
            </div>

            {/* Report section */}
            {reportMarkdown && (
              <div className="task-divider border-t pt-2">
                <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">Report</div>
                <div className="text-[11px]">
                  <MarkdownRenderer content={reportMarkdown} />
                </div>
              </div>
            )}

            {/* Pending state */}
            {status === "executing" && !reportMarkdown && (
              <div className="text-muted text-[11px] italic">
                Task {isBackground ? "running in background" : "executing"}
                <LoadingDots />
              </div>
            )}
          </div>
        </ToolDetails>
      )}

      {/* Collapsed preview */}
      {!expanded && <div className="text-muted mt-1 truncate text-[10px]">{preview}</div>}
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
}

export const TaskAwaitToolCall: React.FC<TaskAwaitToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const hasResults = result?.results && result.results.length > 0;
  const { expanded, toggleExpanded } = useToolExpansion(hasResults);

  const taskIds = args.task_ids;
  const timeoutSecs = args.timeout_secs;
  const results = result?.results ?? [];

  const showConfigInfo =
    taskIds !== undefined ||
    timeoutSecs !== undefined ||
    args.filter !== undefined ||
    args.filter_exclude === true;

  // Summary for header
  const completedCount = results.filter((r) => r.status === "completed").length;
  const totalCount = results.length;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task_await" />
        <ToolName>task_await</ToolName>
        {totalCount > 0 && (
          <span className="text-muted text-[10px]">
            {completedCount}/{totalCount} completed
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="task-surface mt-1 rounded-md p-3">
            {/* Config info */}
            {showConfigInfo && (
              <div className="task-divider text-muted mb-2 flex flex-wrap gap-2 border-b pb-2 text-[10px]">
                {taskIds !== undefined && <span>Waiting for: {taskIds.length} task(s)</span>}
                {timeoutSecs !== undefined && <span>Timeout: {timeoutSecs}s</span>}
                {args.filter !== undefined && <span>Filter: {args.filter}</span>}
                {args.filter_exclude === true && <span>Exclude: true</span>}
              </div>
            )}

            {/* Results */}
            {results.length > 0 ? (
              <div className="space-y-3">
                {results.map((r, idx) => (
                  <TaskAwaitResult key={r.taskId ?? idx} result={r} />
                ))}
              </div>
            ) : status === "executing" ? (
              <div className="text-muted text-[11px] italic">
                Waiting for tasks to complete
                <LoadingDots />
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
}> = ({ result }) => {
  const isCompleted = result.status === "completed";
  const reportMarkdown = isCompleted ? result.reportMarkdown : undefined;
  const title = isCompleted ? result.title : undefined;

  const output = "output" in result ? result.output : undefined;
  const note = "note" in result ? result.note : undefined;
  const exitCode = "exitCode" in result ? result.exitCode : undefined;
  const elapsedMs = "elapsed_ms" in result ? result.elapsed_ms : undefined;

  return (
    <div className="bg-code-bg rounded-sm p-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <TaskId id={result.taskId} />
        <TaskStatusBadge status={result.status} />
        {title && <span className="text-foreground text-[11px] font-medium">{title}</span>}
        {exitCode !== undefined && <span className="text-muted text-[10px]">exit {exitCode}</span>}
        {elapsedMs !== undefined && <span className="text-muted text-[10px]">{elapsedMs}ms</span>}
      </div>

      {!isCompleted && output && output.length > 0 && (
        <div className="text-foreground bg-code-bg max-h-[140px] overflow-y-auto rounded-sm p-2 text-[11px] break-words whitespace-pre-wrap">
          {output}
        </div>
      )}

      {reportMarkdown && (
        <div className="mt-2 text-[11px]">
          <MarkdownRenderer content={reportMarkdown} />
        </div>
      )}

      {note && <div className="text-muted mt-1 text-[10px]">{note}</div>}

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
  const hasTasks = tasks.length > 0;
  const { expanded, toggleExpanded } = useToolExpansion(hasTasks);

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
  <div className="bg-code-bg flex flex-wrap items-center gap-2 rounded-sm p-2">
    <TaskId id={task.taskId} />
    <TaskStatusBadge status={task.status} />
    {task.agentType && <AgentTypeBadge type={task.agentType} />}
    {task.title && (
      <span className="text-foreground max-w-[200px] truncate text-[11px]">{task.title}</span>
    )}
    {task.depth > 0 && <span className="text-muted text-[10px]">depth: {task.depth}</span>}
  </div>
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

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <TaskIcon toolName="task_terminate" />
        <ToolName>task_terminate</ToolName>
        <span className="text-interrupted text-[10px]">
          {terminatedCount > 0 ? `${terminatedCount} terminated` : `${taskIds.length} to terminate`}
        </span>
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
