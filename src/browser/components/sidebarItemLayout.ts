export type SubAgentConnectorLayout = "default" | "task-group-member";

const SIDEBAR_BASE_PADDING_LEFT_PX = 10;
const SIDEBAR_DEPTH_INDENT_PX = 8;
export const SIDEBAR_LEADING_SLOT_SIZE_PX = 16;
const SIDEBAR_LEADING_SLOT_CENTER_OFFSET_PX = SIDEBAR_LEADING_SLOT_SIZE_PX / 2;
const TASK_GROUP_MEMBER_DEPTH_OFFSET = 1.5;
const TASK_GROUP_MEMBER_ANCESTOR_RAIL_OFFSET_PX = 6;

export function getSidebarItemPaddingLeft(depth?: number): number {
  const safeDepth = typeof depth === "number" && Number.isFinite(depth) ? Math.max(0, depth) : 0;
  return SIDEBAR_BASE_PADDING_LEFT_PX + Math.min(32, safeDepth) * SIDEBAR_DEPTH_INDENT_PX;
}

export function getTaskGroupMemberDepth(taskGroupDepth: number): number {
  // Expanded variants/best-of members sit under a task-group header that has a
  // disclosure chevron before its group icon. One-and-a-half grid steps puts
  // member status dots under that group icon while keeping member labels aligned
  // with the task-group title.
  return taskGroupDepth + TASK_GROUP_MEMBER_DEPTH_OFFSET;
}

export function getSidebarLeadingSlotCenterX(depth: number): number {
  return getSidebarItemPaddingLeft(depth) + SIDEBAR_LEADING_SLOT_CENTER_OFFSET_PX;
}

export function getSubAgentParentRailX(depth: number, layout: SubAgentConnectorLayout): number {
  if (layout === "task-group-member") {
    // Group members keep their shared rail in the task-group column instead of
    // snapping to the nested workspace slot center. Their half-step depth
    // offset already places this column under the task-group icon, so the
    // rail x reduces to the leading-slot center at the member's own depth.
    return getSidebarLeadingSlotCenterX(depth);
  }

  // Regular sub-agents branch from the parent row's leading status slot center,
  // so the connector keeps pointing at the same x-coordinate as indentation changes.
  return getSidebarLeadingSlotCenterX(Math.max(0, depth - 1));
}

export function getSubAgentChildStatusCenterX(depth: number): number {
  return getSidebarLeadingSlotCenterX(depth);
}

export function getAncestorRailX(depth: number, layout: SubAgentConnectorLayout): number {
  if (layout === "task-group-member") {
    return getSidebarItemPaddingLeft(depth) + TASK_GROUP_MEMBER_ANCESTOR_RAIL_OFFSET_PX;
  }

  return getSidebarLeadingSlotCenterX(depth);
}
