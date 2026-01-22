import {
  collectAllTabs,
  removeTabEverywhere,
  type DockLayoutNode,
  type DockLayoutState,
} from "@/browser/utils/dockLayout";

export type WindowPaneId = "nav" | "welcome" | `workspace:${string}` | `project:${string}`;

export function isWindowPaneId(value: unknown): value is WindowPaneId {
  if (typeof value !== "string") return false;
  return (
    value === "nav" ||
    value === "welcome" ||
    value.startsWith("workspace:") ||
    value.startsWith("project:")
  );
}

export function getDefaultWindowDockLayoutState(
  mainPane: Exclude<WindowPaneId, "nav">
): DockLayoutState<WindowPaneId> {
  return {
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
        { type: "tabset", id: "tabset-2", tabs: [mainPane], activeTab: mainPane },
      ],
    },
  };
}

export function ensureWindowDockLayoutState(
  state: DockLayoutState<WindowPaneId>,
  options: {
    isWorkspaceIdValid: (workspaceId: string) => boolean;
    getDefaultState: () => DockLayoutState<WindowPaneId>;
  }
): DockLayoutState<WindowPaneId> {
  let next = state;

  for (const tab of collectAllTabs(next.root)) {
    if (typeof tab === "string" && tab.startsWith("workspace:")) {
      const workspaceId = tab.slice("workspace:".length);
      if (!options.isWorkspaceIdValid(workspaceId)) {
        next = removeTabEverywhere(next, tab, options.getDefaultState);
      }
    }
  }

  const allTabs = collectAllTabs(next.root);
  if (!allTabs.includes("nav")) {
    return options.getDefaultState();
  }

  const hasNonNav = allTabs.some((t) => t !== "nav");
  if (!hasNonNav) {
    return options.getDefaultState();
  }

  return next;
}

export function findFirstNonNavTabsetId(root: DockLayoutNode<WindowPaneId>): string | null {
  if (root.type === "tabset") {
    return root.tabs.some((t) => t !== "nav") ? root.id : null;
  }

  return findFirstNonNavTabsetId(root.children[0]) ?? findFirstNonNavTabsetId(root.children[1]);
}

function subtreeHasPane(root: DockLayoutNode<WindowPaneId>, paneId: WindowPaneId): boolean {
  if (root.type === "tabset") {
    return root.tabs.includes(paneId);
  }
  return subtreeHasPane(root.children[0], paneId) || subtreeHasPane(root.children[1], paneId);
}

export function findSplitSeparatingNav(
  root: DockLayoutNode<WindowPaneId>
): { splitId: string; navChildIndex: 0 | 1 } | null {
  if (root.type !== "split") {
    return null;
  }

  const leftHasNav = subtreeHasPane(root.children[0], "nav");
  const rightHasNav = subtreeHasPane(root.children[1], "nav");

  if (leftHasNav !== rightHasNav) {
    return { splitId: root.id, navChildIndex: leftHasNav ? 0 : 1 };
  }

  return findSplitSeparatingNav(root.children[0]) ?? findSplitSeparatingNav(root.children[1]);
}
