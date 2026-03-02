import { expect, test } from "bun:test";
import {
  addTabToFocusedTabset,
  addToolToFocusedTabset,
  closeSplit,
  dockTabToEdge,
  getDefaultRightSidebarLayoutState,
  isRightSidebarLayoutState,
  moveTabToTabset,
  removeTabEverywhere,
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

test("addTabToFocusedTabset can add a tab without stealing focus", () => {
  const s0: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs", "review"], activeTab: "costs" },
  };

  const s1 = addTabToFocusedTabset(s0, "output", false);

  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");
  expect(s1.root.tabs).toEqual(["costs", "review", "output"]);
  expect(s1.root.activeTab).toBe("costs");
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

// --- Parent-tab tracking tests ---

test("removeTabEverywhere activates parent tab when parentTab entry exists", () => {
  const s: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "review", "file:src/foo.ts"],
      activeTab: "file:src/foo.ts",
    },
    parentTab: { "file:src/foo.ts": "review" },
  };

  const result = removeTabEverywhere(s, "file:src/foo.ts");
  if (result.root.type !== "tabset") throw new Error("expected tabset");
  // Should activate "review" (the parent) instead of positional adjacency
  expect(result.root.activeTab).toBe("review");
  expect(result.root.tabs).toEqual(["costs", "review"]);
  // parentTab entry should be cleaned up
  expect(result.parentTab).toBeUndefined();
});

test("removeTabEverywhere falls back to positional adjacency when parent is not in same tabset", () => {
  const s: RightSidebarLayoutState = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "vertical",
      sizes: [50, 50],
      children: [
        {
          type: "tabset",
          id: "tabset-1",
          tabs: ["costs", "file:src/foo.ts"],
          activeTab: "file:src/foo.ts",
        },
        { type: "tabset", id: "tabset-2", tabs: ["review"], activeTab: "review" },
      ],
    },
    // Parent "review" is in tabset-2, but the file tab is in tabset-1
    parentTab: { "file:src/foo.ts": "review" },
  };

  const result = removeTabEverywhere(s, "file:src/foo.ts");
  // Split remains because tabset-1 still has "costs"
  expect(result.root.type).toBe("split");
  if (result.root.type !== "split") throw new Error("expected split");
  const left = result.root.children[0];
  if (left.type !== "tabset") throw new Error("expected tabset");
  // Since "review" is not in tabset-1, fallback to positional adjacency → "costs"
  expect(left.activeTab).toBe("costs");
  expect(left.tabs).toEqual(["costs"]);
});

test("removeTabEverywhere cleans up parentTab entry for the removed tab", () => {
  const s: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "review", "file:src/a.ts", "file:src/b.ts"],
      activeTab: "file:src/a.ts",
    },
    parentTab: {
      "file:src/a.ts": "review",
      "file:src/b.ts": "costs",
    },
  };

  const result = removeTabEverywhere(s, "file:src/a.ts");
  // Only the entry for b.ts should remain
  expect(result.parentTab).toEqual({ "file:src/b.ts": "costs" });
});

test("removeTabEverywhere cleans up parentTab entries pointing to a removed parent tab", () => {
  const s: RightSidebarLayoutState = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "review", "file:src/a.ts", "file:src/b.ts"],
      activeTab: "costs",
    },
    parentTab: {
      "file:src/a.ts": "file:src/b.ts",
      "file:src/b.ts": "review",
    },
  };

  // Remove file:src/b.ts — the entry for file:src/a.ts should also be cleaned
  // because its parent (file:src/b.ts) was the tab that was removed.
  const result = removeTabEverywhere(s, "file:src/b.ts");
  expect(result.parentTab).toBeUndefined();
});

test("persisted layouts without parentTab field still validate correctly (backward compat)", () => {
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
  };
  expect(isRightSidebarLayoutState(raw)).toBe(true);
});

test("persisted layouts with valid parentTab field validate correctly", () => {
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["costs", "file:src/foo.ts"],
      activeTab: "costs",
    },
    parentTab: { "file:src/foo.ts": "costs" },
  };
  expect(isRightSidebarLayoutState(raw)).toBe(true);
});

test("persisted layouts with invalid parentTab field are rejected", () => {
  const raw = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["costs"], activeTab: "costs" },
    parentTab: { "file:src/foo.ts": 42 }, // value is not a string
  };
  expect(isRightSidebarLayoutState(raw)).toBe(false);
});
