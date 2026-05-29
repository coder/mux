import { describe, expect, test } from "bun:test";

import {
  getAncestorRailX,
  getSidebarLeadingSlotCenterX,
  getSidebarItemPaddingLeft,
  getSubAgentChildStatusCenterX,
  getSubAgentParentRailX,
  getTaskGroupMemberDepth,
} from "./sidebarItemLayout";

describe("sidebarItemLayout", () => {
  test("keeps leading status indicators on the shared indentation grid", () => {
    expect(getSidebarItemPaddingLeft(0)).toBe(10);
    expect(getSidebarLeadingSlotCenterX(0)).toBe(18);
    expect(getSidebarLeadingSlotCenterX(1)).toBe(26);
    expect(getSubAgentChildStatusCenterX(1)).toBe(getSidebarLeadingSlotCenterX(1));
  });

  test("anchors default sub-agent rails to the parent status indicator center", () => {
    expect(getSubAgentParentRailX(1, "default")).toBe(getSidebarLeadingSlotCenterX(0));
    expect(getSubAgentParentRailX(2, "default")).toBe(getSidebarLeadingSlotCenterX(1));
    expect(getAncestorRailX(0, "default")).toBe(getSidebarLeadingSlotCenterX(0));
    expect(getAncestorRailX(1, "default")).toBe(getSidebarLeadingSlotCenterX(1));
  });

  test("keeps grouped members on their dedicated shared rail", () => {
    const groupDepth = 1;
    const memberDepth = getTaskGroupMemberDepth(groupDepth);

    expect(memberDepth).toBe(2.5);
    // The task-group header has a disclosure chevron before its group icon, so
    // expanded variants/best-of members use a half-step offset that keeps both
    // the connector rail and child status dot under the group icon.
    expect(getSubAgentParentRailX(memberDepth, "task-group-member")).toBe(38);
    expect(getSubAgentChildStatusCenterX(memberDepth)).toBe(38);
    expect(getAncestorRailX(memberDepth, "task-group-member")).toBe(36);
  });
});
