import { expect, test } from "bun:test";
import {
  addToolToFocusedTabset,
  closeSplit,
  dockTabToEdge,
  getDefaultRightSidebarLayoutState,
  moveTabToTabset,
  reorderTabInTabset,
  selectTabInFocusedTabset,
  splitFocusedTabset,
  type RightSidebarLayoutState,
} from "./rightSidebarLayout";

test("selectTabInFocusedTabset adds missing tool and makes it active", () => {
  let s = getDefaultRightSidebarLayoutState("costs");
  // Start with a layout that only has costs.
  s = {
    ...s,
    root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
  };

  s = selectTabInFocusedTabset(s, "terminal");
  expect(s.root.type).toBe("tabset");
  if (s.root.type !== "tabset") throw new Error("expected tabset");
  expect(s.root.tabs).toEqual(["costs", "terminal"]);
  expect(s.root.activeTab).toBe("terminal");
});

test("splitFocusedTabset moves active tab when possible (no empty tabsets)", () => {
  const s0 = getDefaultRightSidebarLayoutState("terminal");
  const s1 = splitFocusedTabset(s0, "horizontal");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");
  expect(s1.root.children[0].type).toBe("tabset");
  expect(s1.root.children[1].type).toBe("tabset");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs.length).toBeGreaterThan(0);
  expect(right.tabs.length).toBeGreaterThan(0);
});

test("splitFocusedTabset avoids empty by spawning a neighbor tool for 1-tab tabsets", () => {
  let s = getDefaultRightSidebarLayoutState("costs");
  s = {
    ...s,
    root: { type: "tabset", id: "tabset-1", tabs: ["review"], activeTab: "review" },
  };

  const s1 = splitFocusedTabset(s, "vertical");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs).toEqual(["review"]);
  expect(right.tabs.length).toBe(1);
  expect(right.tabs[0]).not.toBe("review");
});

test("addToolToFocusedTabset is an alias of selectTabInFocusedTabset", () => {
  const s0 = getDefaultRightSidebarLayoutState("costs");
  const s1 = addToolToFocusedTabset(s0, "review");
  expect(JSON.stringify(s1)).toContain("review");
});

test("moveTabToTabset moves tab between tabsets", () => {
  // Create a split layout with two tabsets
  const s0 = getDefaultRightSidebarLayoutState("costs");
  const s1 = splitFocusedTabset(s0, "horizontal");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  // Move costs from left to right
  const s2 = moveTabToTabset(s1, "costs", left.id, right.id);
  expect(s2.root.type).toBe("split");
  if (s2.root.type !== "split") throw new Error("expected split");

  const newLeft = s2.root.children[0];
  const newRight = s2.root.children[1];
  if (newLeft.type !== "tabset" || newRight.type !== "tabset") throw new Error("expected tabsets");

  expect(newRight.tabs).toContain("costs");
  expect(newRight.activeTab).toBe("costs");
});

test("moveTabToTabset removes empty source tabset", () => {
  // Create a split where one tabset has only one tab
  let s: RightSidebarLayoutState = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
        { type: "tabset", id: "tabset-2", tabs: ["review", "terminal"], activeTab: "review" },
      ],
    },
  };

  // Move the only tab from tabset-1 to tabset-2
  s = moveTabToTabset(s, "costs", "tabset-1", "tabset-2");

  // The split should be replaced by the remaining tabset
  expect(s.root.type).toBe("tabset");
  if (s.root.type !== "tabset") throw new Error("expected tabset");
  expect(s.root.tabs).toContain("costs");
  expect(s.root.tabs).toContain("review");
  expect(s.root.tabs).toContain("terminal");
});

test("reorderTabInTabset reorders tabs within a tabset", () => {
  // Default layout has ["costs", "review", "explorer"]; reorder costs from 0 to 1
  const s0 = getDefaultRightSidebarLayoutState("costs");
  const s1 = reorderTabInTabset(s0, "tabset-1", 0, 1);

  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");

  expect(s1.root.tabs).toEqual(["review", "costs", "explorer"]);
  expect(s1.root.activeTab).toBe("costs");
});

test("dockTabToEdge splits a tabset and moves the dragged tab into the new pane", () => {
  // Default layout has ["costs", "review", "explorer"]; drag review into a bottom split
  const s0 = getDefaultRightSidebarLayoutState("costs");

  const s1 = dockTabToEdge(s0, "review", "tabset-1", "tabset-1", "bottom");

  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  expect(s1.root.direction).toBe("horizontal");

  const top = s1.root.children[0];
  const bottom = s1.root.children[1];
  if (top.type !== "tabset" || bottom.type !== "tabset") throw new Error("expected tabsets");

  expect(bottom.tabs).toEqual(["review"]);
  expect(bottom.activeTab).toBe("review");
  expect(top.tabs).not.toContain("review");
});

test("dockTabToEdge avoids empty tabsets when dragging out the last tab", () => {
  const s0: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
  };

  const s1 = dockTabToEdge(s0, "costs", "tabset-1", "tabset-1", "right");
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  expect(s1.root.direction).toBe("vertical");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  // The dragged tab goes into the new right pane.
  expect(right.tabs).toEqual(["costs"]);

  // The original pane gets a fallback tool instead of going empty.
  expect(left.tabs.length).toBe(1);
  expect(left.tabs[0]).not.toBe("costs");
});

test("dockTabToEdge removes an empty source tabset when docking into another tabset", () => {
  const s0: RightSidebarLayoutState = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
        { type: "tabset", id: "tabset-2", tabs: ["review"], activeTab: "review" },
      ],
    },
  };

  // Dock the costs tab to the left edge of tabset-2.
  const s1 = dockTabToEdge(s0, "costs", "tabset-1", "tabset-2", "left");

  // The original source tabset should be removed and the root should now be the new split.
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs).toEqual(["costs"]);
  expect(right.tabs).toEqual(["review"]);
});

test("closeSplit keeps the specified child", () => {
  const s: RightSidebarLayoutState = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
        { type: "tabset", id: "tabset-2", tabs: ["review"], activeTab: "review" },
      ],
    },
  };

  // Close split, keeping the first child (left)
  const s1 = closeSplit(s, "split-1", 0);
  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");
  expect(s1.root.id).toBe("tabset-1");
  expect(s1.root.tabs).toEqual(["costs"]);

  // Close split, keeping the second child (right)
  const s2 = closeSplit(s, "split-1", 1);
  expect(s2.root.type).toBe("tabset");
  if (s2.root.type !== "tabset") throw new Error("expected tabset");
  expect(s2.root.id).toBe("tabset-2");
  expect(s2.root.tabs).toEqual(["review"]);
});
