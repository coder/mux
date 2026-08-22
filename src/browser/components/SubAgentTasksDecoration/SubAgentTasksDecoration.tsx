import { Bot, CheckCircle2, CircleSlash2, CircleX, Clock3, LoaderCircle } from "lucide-react";

import { useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { useRouter } from "@/browser/contexts/RouterContext";
import { ChatInputDecoration } from "@/browser/components/ChatPane/ChatInputDecoration";
import { getSubAgentTasksExpandedKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { isActionableTaskExecutionStatus } from "@/browser/utils/ui/workspaceFiltering";
import { cn } from "@/common/lib/utils";

interface DescendantSubAgent {
  workspace: FrontendWorkspaceMetadata;
  depth: number;
}

const ACTIVE_SUBAGENT_STATUSES = new Set<FrontendWorkspaceMetadata["taskStatus"]>([
  "queued",
  "starting",
  "running",
  "awaiting_report",
]);

export function isSubAgentActive(workspace: FrontendWorkspaceMetadata): boolean {
  return (
    isActionableTaskExecutionStatus(workspace.taskExecutionStatus) ||
    ACTIVE_SUBAGENT_STATUSES.has(workspace.taskStatus)
  );
}

/**
 * Return user-owned descendant tasks in stable workspace order. Workflow-owned tasks are transient
 * implementation details of their run, so the parent does not need to manage them individually.
 */
export function collectDescendantSubAgents(
  workspaces: Iterable<FrontendWorkspaceMetadata>,
  parentWorkspaceId: string
): DescendantSubAgent[] {
  const childrenByParentId = new Map<string, FrontendWorkspaceMetadata[]>();
  for (const workspace of workspaces) {
    if (
      workspace.parentWorkspaceId == null ||
      workspace.workflowTask != null ||
      isWorkspaceArchived(workspace.archivedAt, workspace.unarchivedAt)
    ) {
      continue;
    }
    const children = childrenByParentId.get(workspace.parentWorkspaceId) ?? [];
    children.push(workspace);
    childrenByParentId.set(workspace.parentWorkspaceId, children);
  }

  const descendants: DescendantSubAgent[] = [];
  const visited = new Set<string>([parentWorkspaceId]);
  const stack = (childrenByParentId.get(parentWorkspaceId) ?? [])
    .map((workspace) => ({ workspace, depth: 1 }))
    .reverse();

  while (stack.length > 0) {
    const next = stack.pop();
    if (next == null || visited.has(next.workspace.id)) {
      continue;
    }
    visited.add(next.workspace.id);
    descendants.push(next);

    const children = childrenByParentId.get(next.workspace.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ workspace: children[index], depth: next.depth + 1 });
    }
  }

  return descendants;
}

interface SubAgentStatusPresentation {
  label: string;
  icon: typeof Clock3;
  iconClassName: string;
}

/**
 * Presentations are keyed by outcome rather than by status because the two status sources below
 * (taskExecutionStatus for a reawakened run, taskStatus for the retained base report) map several
 * distinct statuses onto the same outcome. Keeping one table avoids the duplicated object literals
 * the two switches used to carry, where a label or class could silently drift between them.
 */
const SUB_AGENT_STATUS_PRESENTATIONS = {
  queued: { label: "Queued", icon: Clock3, iconClassName: "text-muted" },
  starting: { label: "Starting", icon: LoaderCircle, iconClassName: "text-warning animate-spin" },
  running: { label: "Running", icon: LoaderCircle, iconClassName: "text-success animate-spin" },
  finishing: { label: "Finishing", icon: LoaderCircle, iconClassName: "text-warning animate-spin" },
  completed: { label: "Completed", icon: CheckCircle2, iconClassName: "text-success" },
  interrupted: { label: "Interrupted", icon: CircleSlash2, iconClassName: "text-muted" },
  failed: { label: "Failed", icon: CircleX, iconClassName: "text-danger" },
  inactive: { label: "Inactive", icon: CheckCircle2, iconClassName: "text-muted" },
} satisfies Record<string, SubAgentStatusPresentation>;

export function getSubAgentStatusPresentation(
  workspace: FrontendWorkspaceMetadata
): SubAgentStatusPresentation {
  // No execution status (never-reawakened sub-agent) falls through to taskStatus.
  if (workspace.taskExecutionStatus !== undefined) {
    switch (workspace.taskExecutionStatus) {
      case "queued":
        return SUB_AGENT_STATUS_PRESENTATIONS.queued;
      case "starting":
      case "running":
        return SUB_AGENT_STATUS_PRESENTATIONS.running;
      case "completed":
        return SUB_AGENT_STATUS_PRESENTATIONS.completed;
      case "interrupted":
        return SUB_AGENT_STATUS_PRESENTATIONS.interrupted;
      case "error":
        return SUB_AGENT_STATUS_PRESENTATIONS.failed;
    }
  }
  switch (workspace.taskStatus) {
    case "queued":
      return SUB_AGENT_STATUS_PRESENTATIONS.queued;
    case "starting":
      return SUB_AGENT_STATUS_PRESENTATIONS.starting;
    case "running":
      return SUB_AGENT_STATUS_PRESENTATIONS.running;
    case "awaiting_report":
      return SUB_AGENT_STATUS_PRESENTATIONS.finishing;
    case "reported":
      return SUB_AGENT_STATUS_PRESENTATIONS.completed;
    case "interrupted":
      return SUB_AGENT_STATUS_PRESENTATIONS.interrupted;
    default:
      return SUB_AGENT_STATUS_PRESENTATIONS.inactive;
  }
}

export function SubAgentTasksDecoration(props: { workspaceId: string }) {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const { navigateToWorkspace } = useRouter();
  const [expanded, setExpanded] = usePersistedState(
    getSubAgentTasksExpandedKey(props.workspaceId),
    false
  );
  const subAgents = collectDescendantSubAgents(workspaceMetadata.values(), props.workspaceId);

  if (subAgents.length === 0) {
    return null;
  }

  const activeCount = subAgents.filter(({ workspace }) => isSubAgentActive(workspace)).length;

  return (
    <ChatInputDecoration
      expanded={expanded}
      onToggle={() => setExpanded(!expanded)}
      dataComponent="SubAgentTasksDecoration"
      contentClassName="max-h-52 space-y-1 overflow-y-auto py-2"
      summary={
        <>
          <Bot className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
          <span className="text-muted group-hover:text-secondary transition-colors">
            <span className="font-medium">{subAgents.length}</span> sub-agent
            {subAgents.length === 1 ? "" : "s"}
            {activeCount > 0 ? ` · ${activeCount} active` : " · inactive"}
          </span>
        </>
      }
      renderExpanded={() =>
        subAgents.map(({ workspace, depth }) => {
          const status = getSubAgentStatusPresentation(workspace);
          const StatusIcon = status.icon;
          return (
            <button
              key={workspace.id}
              type="button"
              onClick={() => navigateToWorkspace(workspace.id)}
              className="hover:bg-hover flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left transition-colors"
              style={{ paddingLeft: `${Math.min(depth - 1, 4) * 12 + 8}px` }}
            >
              <StatusIcon className={cn("size-3.5 shrink-0", status.iconClassName)} />
              <span className="text-foreground min-w-0 flex-1 truncate text-xs">
                {workspace.title ?? workspace.name}
              </span>
              <span className="text-muted shrink-0 text-[10px]">{status.label}</span>
            </button>
          );
        })
      }
    />
  );
}
