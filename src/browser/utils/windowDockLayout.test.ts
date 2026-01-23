import { expect, test } from "bun:test";
import type { DockLayoutState } from "@/browser/utils/dockLayout";
import {
  ensureWindowDockLayoutState,
  getDefaultWindowDockLayoutState,
  type WindowPaneId,
} from "@/browser/utils/windowDockLayout";

test("ensureWindowDockLayoutState removes invalid workspace panes", () => {
  const s: DockLayoutState<WindowPaneId> = {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-2",
    root: {
      type: "split",
      id: "split-1",
      direction: "vertical",
      sizes: [22, 78],
      children: [
        { type: "tabset", id: "tabset-1", tabs: ["nav"], activeTab: "nav" },
        {
          type: "tabset",
          id: "tabset-2",
          tabs: ["workspace:missing"],
          activeTab: "workspace:missing",
        },
      ],
    },
  };

  const defaultState = getDefaultWindowDockLayoutState("welcome");
  const ensured = ensureWindowDockLayoutState(s, {
    isWorkspaceIdValid: () => false,
    getDefaultState: () => defaultState,
  });

  expect(ensured).toEqual(defaultState);
});

test("ensureWindowDockLayoutState resets when nav is missing", () => {
  const s: DockLayoutState<WindowPaneId> = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["welcome"], activeTab: "welcome" },
  };

  const defaultState = getDefaultWindowDockLayoutState("welcome");
  const ensured = ensureWindowDockLayoutState(s, {
    isWorkspaceIdValid: () => true,
    getDefaultState: () => defaultState,
  });

  expect(ensured).toEqual(defaultState);
});

test("ensureWindowDockLayoutState resets when only nav remains", () => {
  const s: DockLayoutState<WindowPaneId> = {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: { type: "tabset", id: "tabset-1", tabs: ["nav"], activeTab: "nav" },
  };

  const defaultState = getDefaultWindowDockLayoutState("welcome");
  const ensured = ensureWindowDockLayoutState(s, {
    isWorkspaceIdValid: () => true,
    getDefaultState: () => defaultState,
  });

  expect(ensured).toEqual(defaultState);
});
