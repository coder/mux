export type SubAgentConnectorLayout = "default" | "task-group-member";

const SIDEBAR_BASE_PADDING_LEFT_PX = 10;
const SIDEBAR_DEPTH_INDENT_PX = 8;
export const SIDEBAR_LEADING_SLOT_SIZE_PX = 16;
const SIDEBAR_LEADING_SLOT_CENTER_OFFSET_PX = SIDEBAR_LEADING_SLOT_SIZE_PX / 2;
const TASK_GROUP_MEMBER_PARENT_RAIL_OFFSET_PX = 4;
const TASK_GROUP_MEMBER_ANCESTOR_RAIL_OFFSET_PX = 6;

export function getSidebarItemPaddingLeft(depth?: number): number {
  const safeDepth = typeof depth === "number" && Number.isFinite(depth) ? Math.max(0, depth) : 0;
  return SIDEBAR_BASE_PADDING_LEFT_PX + Math.min(32, safeDepth) * SIDEBAR_DEPTH_INDENT_PX;
}

export function getSidebarLeadingSlotCenterX(depth: number): number {
  return getSidebarItemPaddingLeft(depth) + SIDEBAR_LEADING_SLOT_CENTER_OFFSET_PX;
}

export function getSubAgentParentRailX(depth: number, layout: SubAgentConnectorLayout): number {
  if (layout === "task-group-member") {
    // Group members keep their shared rail in the task-group column instead of
    // snapping to the nested workspace slot center.
    return getSidebarItemPaddingLeft(depth) + TASK_GROUP_MEMBER_PARENT_RAIL_OFFSET_PX;
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
