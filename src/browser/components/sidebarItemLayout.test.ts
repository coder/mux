import { describe, expect, test } from "bun:test";

import {
  getAncestorRailX,
  getSidebarLeadingSlotCenterX,
  getSidebarItemPaddingLeft,
  getSubAgentChildStatusCenterX,
  getSubAgentParentRailX,
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
    expect(getSubAgentParentRailX(2, "task-group-member")).toBe(30);
    expect(getAncestorRailX(2, "task-group-member")).toBe(32);
  });
});
