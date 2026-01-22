import { expect, test } from "bun:test";
import {
  addTabToFocusedTabset,
  closeSplit,
  dockTabToEdge,
  moveTabToTabset,
  reorderTabInTabset,
  selectTabInFocusedTabset,
  splitFocusedTabset,
  type DockLayoutState,
} from "./dockLayout";

type PaneId = "a" | "b" | "c";

function getFallback(moved: PaneId): PaneId {
  return moved === "a" ? "b" : "a";
}

function getDefaultState(active: PaneId = "a"): DockLayoutState<PaneId> {
  const tabs: PaneId[] = ["a", "b"];
  if (!tabs.includes(active)) {
    tabs.push(active);
  }
  return {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs, activeTab: active },
  };
}

test("selectTabInFocusedTabset adds missing tab and makes it active", () => {
  let s = getDefaultState("a");
  // Start with a layout that only has a.
  s = {
    ...s,
    root: { type: "tabset", id: "tabset-1", tabs: ["a"], activeTab: "a" },
  };

  s = selectTabInFocusedTabset(s, "b");
  expect(s.root.type).toBe("tabset");
  if (s.root.type !== "tabset") throw new Error("expected tabset");
  expect(s.root.tabs).toEqual(["a", "b"]);
  expect(s.root.activeTab).toBe("b");
});

test("splitFocusedTabset moves active tab when possible (no empty tabsets)", () => {
  const s0 = getDefaultState("b");
  const s1 = splitFocusedTabset(s0, "horizontal", getFallback);
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

test("splitFocusedTabset avoids empty by spawning a neighbor tab for 1-tab tabsets", () => {
  let s = getDefaultState("a");
  s = {
    ...s,
    root: { type: "tabset", id: "tabset-1", tabs: ["a"], activeTab: "a" },
  };

  const s1 = splitFocusedTabset(s, "vertical", getFallback);
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs).toEqual(["a"]);
  expect(right.tabs.length).toBe(1);
  expect(right.tabs[0]).not.toBe("a");
});

test("addTabToFocusedTabset can add without activating", () => {
  const s0 = getDefaultState("a");
  const s1 = addTabToFocusedTabset(s0, "c", false);
  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");
  expect(s1.root.tabs).toContain("c");
  expect(s1.root.activeTab).toBe("a");
});

test("moveTabToTabset moves tab between tabsets", () => {
  const s0 = getDefaultState("a");
  const s1 = splitFocusedTabset(s0, "horizontal", getFallback);
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  const s2 = moveTabToTabset(s1, "a", left.id, right.id);
  expect(s2.root.type).toBe("split");
  if (s2.root.type !== "split") throw new Error("expected split");

  const newLeft = s2.root.children[0];
  const newRight = s2.root.children[1];
  if (newLeft.type !== "tabset" || newRight.type !== "tabset") throw new Error("expected tabsets");

  expect(newRight.tabs).toContain("a");
  expect(newRight.activeTab).toBe("a");
});

test("moveTabToTabset removes empty source tabset", () => {
  let s: DockLayoutState<PaneId> = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["a"], activeTab: "a" },
        { type: "tabset", id: "tabset-2", tabs: ["b"], activeTab: "b" },
      ],
    },
  };

  s = moveTabToTabset(s, "a", "tabset-1", "tabset-2");

  expect(s.root.type).toBe("tabset");
  if (s.root.type !== "tabset") throw new Error("expected tabset");
  expect(s.root.tabs).toContain("a");
  expect(s.root.tabs).toContain("b");
});

test("reorderTabInTabset reorders tabs within a tabset", () => {
  const s0 = getDefaultState("a");
  const s1 = reorderTabInTabset(s0, "tabset-1", 0, 1);

  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");

  expect(s1.root.tabs).toEqual(["b", "a"]);
  expect(s1.root.activeTab).toBe("a");
});

test("dockTabToEdge splits a tabset and moves the dragged tab into the new pane", () => {
  const s0 = getDefaultState("a");

  const s1 = dockTabToEdge(s0, "b", "tabset-1", "tabset-1", "bottom", getFallback);

  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  expect(s1.root.direction).toBe("horizontal");

  const top = s1.root.children[0];
  const bottom = s1.root.children[1];
  if (top.type !== "tabset" || bottom.type !== "tabset") throw new Error("expected tabsets");

  expect(bottom.tabs).toEqual(["b"]);
  expect(bottom.activeTab).toBe("b");
  expect(top.tabs).not.toContain("b");
});

test("dockTabToEdge avoids empty tabsets when dragging out the last tab", () => {
  const s0: DockLayoutState<PaneId> = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["a"], activeTab: "a" },
  };

  const s1 = dockTabToEdge(s0, "a", "tabset-1", "tabset-1", "right", getFallback);
  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  expect(s1.root.direction).toBe("vertical");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(right.tabs).toEqual(["a"]);
  expect(left.tabs.length).toBe(1);
  expect(left.tabs[0]).not.toBe("a");
});

test("dockTabToEdge removes an empty source tabset when docking into another tabset", () => {
  const s0: DockLayoutState<PaneId> = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["a"], activeTab: "a" },
        { type: "tabset", id: "tabset-2", tabs: ["b"], activeTab: "b" },
      ],
    },
  };

  const s1 = dockTabToEdge(s0, "a", "tabset-1", "tabset-2", "left", getFallback);

  expect(s1.root.type).toBe("split");
  if (s1.root.type !== "split") throw new Error("expected split");

  const left = s1.root.children[0];
  const right = s1.root.children[1];
  if (left.type !== "tabset" || right.type !== "tabset") throw new Error("expected tabsets");

  expect(left.tabs).toEqual(["a"]);
  expect(right.tabs).toEqual(["b"]);
});

test("closeSplit keeps the specified child", () => {
  const s: DockLayoutState<PaneId> = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      sizes: [50, 50],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["a"], activeTab: "a" },
        { type: "tabset", id: "tabset-2", tabs: ["b"], activeTab: "b" },
      ],
    },
  };

  const s1 = closeSplit(s, "split-1", 0);
  expect(s1.root.type).toBe("tabset");
  if (s1.root.type !== "tabset") throw new Error("expected tabset");
  expect(s1.root.id).toBe("tabset-1");
  expect(s1.root.tabs).toEqual(["a"]);

  const s2 = closeSplit(s, "split-1", 1);
  expect(s2.root.type).toBe("tabset");
  if (s2.root.type !== "tabset") throw new Error("expected tabset");
  expect(s2.root.id).toBe("tabset-2");
  expect(s2.root.tabs).toEqual(["b"]);
});
