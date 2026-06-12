import { getTaskGroupMemberDepth } from "@/browser/components/sidebarItemLayout";
import {
  isRunningOrStartingTaskStatus,
  isWorkspaceDelegatedActivityActive,
  type AgentRowRenderMeta,
} from "@/browser/utils/ui/workspaceFiltering";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import {
  formatTaskGroupHeader,
  formatTaskGroupItemsLabel,
  getTaskGroupKindFromMetadata,
  type TaskGroupKind,
} from "@/common/utils/tools/taskGroups";

/**
 * Sidebar-local group kind: task-tool groups (bestOf/variants) plus workflow
 * runs. Workflow semantics intentionally stay out of the tool-level
 * TaskGroupKind in src/common/utils/tools/taskGroups.ts - that utility
 * describes task-tool metadata, while workflow grouping is UI-only.
 */
export type SidebarGroupKind = TaskGroupKind | "workflow";

export function formatSidebarTaskGroupHeader(
  kind: SidebarGroupKind,
  totalCount: number,
  title: string
): string {
  if (kind === "workflow") {
    return `Workflow · ${title}`;
  }
  return formatTaskGroupHeader(kind, totalCount, title);
}

export function formatSidebarTaskGroupItemsLabel(kind: SidebarGroupKind): string {
  if (kind === "workflow") {
    return "Tasks";
  }
  return formatTaskGroupItemsLabel(kind);
}

/** Compact fallback header label for workflow runs spawned before workflowName existed. */
export function shortenWorkflowRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 12)}…` : runId;
}

export interface SidebarTaskGroupModel {
  /**
   * Persisted-expansion key, namespaced per D7: task:<parent>:<groupId> or
   * workflow:<parent>:<runId>. Also used as the synthetic row-node id, so it
   * must never collide with workspace ids.
   */
  storageKey: string;
  /** Raw group identity (bestOf groupId or workflow runId), used in testids. */
  id: string;
  kind: SidebarGroupKind;
  parentWorkspaceId: string;
  /** Workspace id of the first visible member; the header renders at that row's position. */
  anchorId: string;
  /**
   * Members rendered under the header when expanded, in display order. For
   * active workflow groups this includes completed siblings that completed-
   * sub-agent filtering would otherwise hide (D9).
   */
  displayMembers: FrontendWorkspaceMetadata[];
  /** All known members (visible or not) for aggregate counts. */
  allMembers: FrontendWorkspaceMetadata[];
  title: string;
  totalCount: number;
  completedCount: number;
  runningCount: number;
  queuedCount: number;
  interruptedCount: number;
  /** True while any member is queued or actively working: drives default expansion (D6). */
  hasActiveMember: boolean;
}

export interface SidebarTaskGroupsResult {
  groupsByStorageKey: Map<string, SidebarTaskGroupModel>;
  /** Maps every member workspace id to its group key so non-anchor rows are suppressed. */
  memberGroupStorageKeyByWorkspaceId: Map<string, string>;
}

interface GroupDescriptor {
  id: string;
  kind: SidebarGroupKind;
  parentWorkspaceId: string;
  storageKey: string;
}

function getGroupDescriptor(
  workspace: FrontendWorkspaceMetadata,
  hasChildren: (workspaceId: string) => boolean
): GroupDescriptor | null {
  const parentWorkspaceId = workspace.parentWorkspaceId;
  if (!parentWorkspaceId) {
    return null;
  }
  // Leaf-only rule (D4): a member that spawned its own sub-agents falls out of
  // the group and renders as a normal subtree.
  if (hasChildren(workspace.id)) {
    return null;
  }

  const bestOfGroupId = workspace.bestOf?.groupId;
  if (bestOfGroupId) {
    if ((workspace.bestOf?.total ?? 1) < 2) {
      return null;
    }
    return {
      id: bestOfGroupId,
      kind: getTaskGroupKindFromMetadata(workspace.bestOf),
      parentWorkspaceId,
      storageKey: `task:${parentWorkspaceId}:${bestOfGroupId}`,
    };
  }

  // bestOf grouping wins when both are present (D3).
  const workflowRunId = workspace.workflowTask?.runId;
  if (workflowRunId) {
    return {
      id: workflowRunId,
      kind: "workflow",
      parentWorkspaceId,
      storageKey: `workflow:${parentWorkspaceId}:${workflowRunId}`,
    };
  }

  return null;
}

function sortBestOfMembers(members: FrontendWorkspaceMetadata[]): FrontendWorkspaceMetadata[] {
  return [...members].sort(
    (left, right) =>
      (left.bestOf?.index ?? Number.MAX_SAFE_INTEGER) -
        (right.bestOf?.index ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id)
  );
}

function sortWorkflowMembers(members: FrontendWorkspaceMetadata[]): FrontendWorkspaceMetadata[] {
  // Spawn order: workflow steps run over time, so creation time is the
  // natural reading order for a run's tasks.
  return [...members].sort(
    (left, right) =>
      (left.createdAt ?? "").localeCompare(right.createdAt ?? "") || left.id.localeCompare(right.id)
  );
}

/**
 * Compute coalesced sidebar task groups for one ordered list of visible rows.
 *
 * Variant/best-of groups keep the legacy constraints (min 2 members, visible
 * members contiguous). Workflow run groups form from the first member and
 * gather non-contiguous members because steps spawn over time and interleave
 * with other rows (D5/D6).
 */
export function computeSidebarTaskGroups(params: {
  /** Ordered rows the sidebar would render (visibility rules already applied). */
  rows: FrontendWorkspaceMetadata[];
  /** Unfiltered section rows used for totals and the leaf-only rule. */
  allRows: FrontendWorkspaceMetadata[];
  selectedWorkspaceId?: string;
  isWorkspaceLiveActive?: (workspaceId: string) => boolean;
}): SidebarTaskGroupsResult {
  const childrenByParentId = new Map<string, FrontendWorkspaceMetadata[]>();
  for (const workspace of params.allRows) {
    const parentId = workspace.parentWorkspaceId;
    if (!parentId) {
      continue;
    }
    const children = childrenByParentId.get(parentId) ?? [];
    children.push(workspace);
    childrenByParentId.set(parentId, children);
  }
  const hasChildren = (workspaceId: string) => childrenByParentId.has(workspaceId);

  const descriptorsByStorageKey = new Map<string, GroupDescriptor>();
  const allMembersByStorageKey = new Map<string, FrontendWorkspaceMetadata[]>();
  for (const workspace of params.allRows) {
    const descriptor = getGroupDescriptor(workspace, hasChildren);
    if (!descriptor) {
      continue;
    }
    descriptorsByStorageKey.set(descriptor.storageKey, descriptor);
    const members = allMembersByStorageKey.get(descriptor.storageKey) ?? [];
    members.push(workspace);
    allMembersByStorageKey.set(descriptor.storageKey, members);
  }

  const visibleMembersByStorageKey = new Map<string, FrontendWorkspaceMetadata[]>();
  const indexByRowId = new Map(
    params.rows.map((workspace, index) => [workspace.id, index] as const)
  );
  for (const workspace of params.rows) {
    const descriptor = getGroupDescriptor(workspace, hasChildren);
    if (!descriptor) {
      continue;
    }
    const members = visibleMembersByStorageKey.get(descriptor.storageKey) ?? [];
    members.push(workspace);
    visibleMembersByStorageKey.set(descriptor.storageKey, members);
  }

  const groupsByStorageKey = new Map<string, SidebarTaskGroupModel>();
  const memberGroupStorageKeyByWorkspaceId = new Map<string, string>();

  for (const [storageKey, visibleMembers] of visibleMembersByStorageKey) {
    const descriptor = descriptorsByStorageKey.get(storageKey);
    if (!descriptor || visibleMembers.length === 0) {
      continue;
    }
    const allMembers = allMembersByStorageKey.get(storageKey) ?? visibleMembers;

    if (descriptor.kind !== "workflow") {
      if (visibleMembers.length < 2 || allMembers.length < 2) {
        continue;
      }
      // Visible variant/best-of members must stay contiguous (spawned
      // atomically and sorted adjacent); bail out when other rows interleave.
      const indices = visibleMembers
        .map((workspace) => indexByRowId.get(workspace.id))
        .filter((index): index is number => index != null);
      if (indices.length !== visibleMembers.length) {
        continue;
      }
      const firstIndex = Math.min(...indices);
      const lastIndex = Math.max(...indices);
      if (lastIndex - firstIndex + 1 !== visibleMembers.length) {
        continue;
      }
    }

    let completedCount = 0;
    let runningCount = 0;
    let queuedCount = 0;
    let interruptedCount = 0;
    for (const member of allMembers) {
      if (hasCompletedAgentReport(member)) {
        completedCount += 1;
        continue;
      }
      if (
        isWorkspaceDelegatedActivityActive(member, {
          isWorkspaceLiveActive: params.isWorkspaceLiveActive,
        })
      ) {
        runningCount += 1;
        continue;
      }
      if (member.taskStatus === "queued") {
        queuedCount += 1;
        continue;
      }
      if (member.taskStatus === "interrupted") {
        interruptedCount += 1;
      }
    }
    const hasActiveMember = runningCount > 0 || queuedCount > 0;

    let displayMembers: FrontendWorkspaceMetadata[];
    let title: string;
    let totalCount: number;
    if (descriptor.kind === "workflow") {
      if (hasActiveMember) {
        // D9: active runs show their full task list, including completed
        // siblings that completed-sub-agent filtering would otherwise hide.
        displayMembers = sortWorkflowMembers(allMembers);
      } else {
        const selected =
          params.selectedWorkspaceId != null
            ? allMembers.find((member) => member.id === params.selectedWorkspaceId)
            : undefined;
        const visibleIds = new Set(visibleMembers.map((member) => member.id));
        displayMembers = sortWorkflowMembers(
          selected != null && !visibleIds.has(selected.id)
            ? [...visibleMembers, selected]
            : visibleMembers
        );
      }
      const workflowName = allMembers.find((member) => member.workflowTask?.workflowName != null)
        ?.workflowTask?.workflowName;
      title = workflowName ?? shortenWorkflowRunId(descriptor.id);
      // No up-front total for workflow runs; count live members only.
      totalCount = allMembers.length;
    } else {
      displayMembers = sortBestOfMembers(visibleMembers);
      const sortedAllMembers = sortBestOfMembers(allMembers);
      title = sortedAllMembers[0]?.title ?? sortedAllMembers[0]?.name ?? "Task group";
      totalCount = Math.max(
        sortedAllMembers[0]?.bestOf?.total ?? allMembers.length,
        allMembers.length
      );
    }

    const anchorId = visibleMembers[0]?.id;
    if (anchorId == null) {
      continue;
    }

    groupsByStorageKey.set(storageKey, {
      storageKey,
      id: descriptor.id,
      kind: descriptor.kind,
      parentWorkspaceId: descriptor.parentWorkspaceId,
      anchorId,
      displayMembers,
      allMembers,
      title,
      totalCount,
      completedCount,
      runningCount,
      queuedCount,
      interruptedCount,
      hasActiveMember,
    });
    for (const member of allMembers) {
      memberGroupStorageKeyByWorkspaceId.set(member.id, storageKey);
    }
  }

  return { groupsByStorageKey, memberGroupStorageKeyByWorkspaceId };
}

/**
 * Connector metadata for the member rows rendered under an expanded group
 * header. Members form their own sibling run hanging off the header row, and
 * inherit the header's continuing ancestor trunks so rails stay unbroken.
 */
export function computeTaskGroupMemberRowMeta(params: {
  group: SidebarTaskGroupModel;
  headerMeta: AgentRowRenderMeta;
  headerDepth: number;
}): Map<string, AgentRowRenderMeta> {
  const members = params.group.displayMembers;
  const memberDepth = getTaskGroupMemberDepth(params.headerDepth);

  let lastRunningMemberIndex = -1;
  for (let index = members.length - 1; index >= 0; index -= 1) {
    if (isRunningOrStartingTaskStatus(members[index]?.taskStatus)) {
      lastRunningMemberIndex = index;
      break;
    }
  }

  const ancestorTrunks: Array<{ depth: number; active: boolean }> = [
    ...params.headerMeta.ancestorTrunks,
  ];
  if (params.headerMeta.connectorPosition === "middle") {
    // The header has visible lower siblings, so its shared trunk must pass
    // through the member rows to reach them.
    ancestorTrunks.push({
      depth: params.headerDepth,
      active: params.headerMeta.sharedTrunkActiveBelowRow,
    });
  }
  ancestorTrunks.sort((left, right) => left.depth - right.depth);

  const metaByWorkspaceId = new Map<string, AgentRowRenderMeta>();
  for (const [index, member] of members.entries()) {
    let connectorPosition: AgentRowRenderMeta["connectorPosition"] = "single";
    if (members.length > 1) {
      connectorPosition = index === members.length - 1 ? "last" : "middle";
    }
    metaByWorkspaceId.set(member.id, {
      depth: memberDepth,
      rowKind: "subagent",
      connectorPosition,
      connectorStartsAtParent: index === 0,
      sharedTrunkActiveThroughRow: lastRunningMemberIndex >= 0 && index <= lastRunningMemberIndex,
      sharedTrunkActiveBelowRow: lastRunningMemberIndex >= 0 && index < lastRunningMemberIndex,
      ancestorTrunks,
      // Leaf-only rule: grouped members never have visible children.
      hasHiddenCompletedChildren: false,
      visibleCompletedChildrenCount: 0,
    });
  }
  return metaByWorkspaceId;
}
