import { isTabType, type TabType } from "@/browser/types/rightSidebar";

export type RightSidebarLayoutNode =
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      sizes: [number, number];
      children: [RightSidebarLayoutNode, RightSidebarLayoutNode];
    }
  | {
      type: "tabset";
      id: string;
      tabs: TabType[];
      activeTab: TabType;
    };

function isLayoutNode(value: unknown): value is RightSidebarLayoutNode {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  if (v.type === "tabset") {
    return (
      typeof v.id === "string" &&
      Array.isArray(v.tabs) &&
      v.tabs.every((t) => isTabType(t)) &&
      isTabType(v.activeTab)
    );
  }

  if (v.type === "split") {
    if (typeof v.id !== "string") return false;
    if (v.direction !== "horizontal" && v.direction !== "vertical") return false;
    if (!Array.isArray(v.sizes) || v.sizes.length !== 2) return false;
    if (typeof v.sizes[0] !== "number" || typeof v.sizes[1] !== "number") return false;
    if (!Array.isArray(v.children) || v.children.length !== 2) return false;
    return isLayoutNode(v.children[0]) && isLayoutNode(v.children[1]);
  }

  return false;
}

export function isRightSidebarLayoutState(value: unknown): value is RightSidebarLayoutState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.nextId !== "number") return false;
  if (typeof v.focusedTabsetId !== "string") return false;
  if (!isLayoutNode(v.root)) return false;
  return findTabset(v.root, v.focusedTabsetId) !== null;
}
export interface RightSidebarLayoutState {
  version: 1;
  nextId: number;
  focusedTabsetId: string;
  root: RightSidebarLayoutNode;
}

export function getDefaultRightSidebarLayoutState(activeTab: TabType): RightSidebarLayoutState {
  // Default tabs exclude terminal - users add terminals via the "+" button
  const baseTabs: TabType[] = ["costs", "review", "explorer"];
  const tabs = baseTabs.includes(activeTab) ? baseTabs : [...baseTabs, activeTab];

  return {
    version: 1,
    nextId: 2,
    focusedTabsetId: "tabset-1",
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs,
      activeTab,
    },
  };
}

/**
 * Recursively inject a tab into the first tabset that doesn't have it.
 * Returns true if injection happened.
 */
function injectTabIntoLayout(node: RightSidebarLayoutNode, tab: TabType): boolean {
  if (node.type === "tabset") {
    if (!node.tabs.includes(tab)) {
      node.tabs.push(tab);
      return true;
    }
    return false;
  }
  // Split node - try first child, then second
  return injectTabIntoLayout(node.children[0], tab) || injectTabIntoLayout(node.children[1], tab);
}

/**
 * Check if a tab exists anywhere in the layout tree.
 */
function layoutContainsTab(node: RightSidebarLayoutNode, tab: TabType): boolean {
  if (node.type === "tabset") {
    return node.tabs.includes(tab);
  }
  return layoutContainsTab(node.children[0], tab) || layoutContainsTab(node.children[1], tab);
}

export function parseRightSidebarLayoutState(
  raw: unknown,
  activeTabFallback: TabType
): RightSidebarLayoutState {
  if (isRightSidebarLayoutState(raw)) {
    // Migrate: inject "explorer" tab if missing from persisted layout
    if (!layoutContainsTab(raw.root, "explorer")) {
      injectTabIntoLayout(raw.root, "explorer");
    }
    return raw;
  }

  return getDefaultRightSidebarLayoutState(activeTabFallback);
}

export function findTabset(
  root: RightSidebarLayoutNode,
  tabsetId: string
): RightSidebarLayoutNode | null {
  if (root.type === "tabset") {
    return root.id === tabsetId ? root : null;
  }
  return findTabset(root.children[0], tabsetId) ?? findTabset(root.children[1], tabsetId);
}

export function findFirstTabsetId(root: RightSidebarLayoutNode): string | null {
  if (root.type === "tabset") return root.id;
  return findFirstTabsetId(root.children[0]) ?? findFirstTabsetId(root.children[1]);
}

function allocId(state: RightSidebarLayoutState, prefix: "tabset" | "split") {
  const id = `${prefix}-${state.nextId}`;
  return { id, nextId: state.nextId + 1 };
}

function removeTabFromNode(
  node: RightSidebarLayoutNode,
  tab: TabType
): RightSidebarLayoutNode | null {
  if (node.type === "tabset") {
    const oldIndex = node.tabs.indexOf(tab);
    const tabs = node.tabs.filter((t) => t !== tab);
    if (tabs.length === 0) return null;

    // When removing the active tab, focus next tab (or previous if no next)
    let activeTab = node.activeTab;
    if (node.activeTab === tab) {
      // Prefer next tab, fall back to previous
      activeTab = tabs[Math.min(oldIndex, tabs.length - 1)];
    }
    return {
      ...node,
      tabs,
      activeTab: tabs.includes(activeTab) ? activeTab : tabs[0],
    };
  }

  const left = removeTabFromNode(node.children[0], tab);
  const right = removeTabFromNode(node.children[1], tab);

  if (!left && !right) {
    return null;
  }

  // If one side goes empty, promote the other side to avoid empty panes.
  if (!left) return right;
  if (!right) return left;

  return {
    ...node,
    children: [left, right],
  };
}

export function removeTabEverywhere(
  state: RightSidebarLayoutState,
  tab: TabType
): RightSidebarLayoutState {
  const nextRoot = removeTabFromNode(state.root, tab);
  if (!nextRoot) {
    return getDefaultRightSidebarLayoutState("costs");
  }

  const focusedExists = findTabset(nextRoot, state.focusedTabsetId) !== null;
  const focusedTabsetId = focusedExists
    ? state.focusedTabsetId
    : (findFirstTabsetId(nextRoot) ?? "tabset-1");

  return {
    ...state,
    root: nextRoot,
    focusedTabsetId,
  };
}
function updateNode(
  node: RightSidebarLayoutNode,
  tabsetId: string,
  updater: (tabset: Extract<RightSidebarLayoutNode, { type: "tabset" }>) => RightSidebarLayoutNode
): RightSidebarLayoutNode {
  if (node.type === "tabset") {
    if (node.id !== tabsetId) return node;
    return updater(node);
  }

  return {
    ...node,
    children: [
      updateNode(node.children[0], tabsetId, updater),
      updateNode(node.children[1], tabsetId, updater),
    ],
  };
}

export function setFocusedTabset(
  state: RightSidebarLayoutState,
  tabsetId: string
): RightSidebarLayoutState {
  if (state.focusedTabsetId === tabsetId) return state;
  return { ...state, focusedTabsetId: tabsetId };
}

export function selectTabInTabset(
  state: RightSidebarLayoutState,
  tabsetId: string,
  tab: TabType
): RightSidebarLayoutState {
  const target = findTabset(state.root, tabsetId);
  if (target?.type !== "tabset") {
    return state;
  }

  if (target.activeTab === tab && target.tabs.includes(tab)) {
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, tabsetId, (ts) => {
      const tabs = ts.tabs.includes(tab) ? ts.tabs : [...ts.tabs, tab];
      return { ...ts, tabs, activeTab: tab };
    }),
  };
}

export function reorderTabInTabset(
  state: RightSidebarLayoutState,
  tabsetId: string,
  fromIndex: number,
  toIndex: number
): RightSidebarLayoutState {
  const tabset = findTabset(state.root, tabsetId);
  if (tabset?.type !== "tabset") {
    return state;
  }

  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= tabset.tabs.length ||
    toIndex >= tabset.tabs.length
  ) {
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, tabsetId, (node) => {
      const nextTabs = [...node.tabs];
      const [moved] = nextTabs.splice(fromIndex, 1);
      if (!moved) {
        return node;
      }

      nextTabs.splice(toIndex, 0, moved);
      return {
        ...node,
        tabs: nextTabs,
      };
    }),
  };
}

export function selectTabInFocusedTabset(
  state: RightSidebarLayoutState,
  tab: TabType
): RightSidebarLayoutState {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type !== "tabset") {
    return state;
  }

  if (focused.activeTab === tab && focused.tabs.includes(tab)) {
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, focused.id, (ts) => {
      const tabs = ts.tabs.includes(tab) ? ts.tabs : [...ts.tabs, tab];
      return { ...ts, tabs, activeTab: tab };
    }),
  };
}

export function splitFocusedTabset(
  state: RightSidebarLayoutState,
  direction: "horizontal" | "vertical"
): RightSidebarLayoutState {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type !== "tabset") {
    return state;
  }

  const splitAlloc = allocId(state, "split");
  const tabsetAlloc = allocId({ ...state, nextId: splitAlloc.nextId }, "tabset");

  const fallbackTab: TabType =
    focused.activeTab === "terminal"
      ? "costs"
      : focused.activeTab === "costs"
        ? "terminal"
        : "terminal";

  let left: Extract<RightSidebarLayoutNode, { type: "tabset" }> = focused;
  let right: Extract<RightSidebarLayoutNode, { type: "tabset" }>;
  const newFocusedId = tabsetAlloc.id;

  if (focused.tabs.length > 1) {
    const moved = focused.activeTab;
    const remaining = focused.tabs.filter((t) => t !== moved);
    const oldActive = remaining[0] ?? "costs";

    left = {
      ...focused,
      tabs: remaining,
      activeTab: oldActive,
    };

    right = {
      type: "tabset",
      id: tabsetAlloc.id,
      tabs: [moved],
      activeTab: moved,
    };
  } else {
    // Avoid empty tabsets: keep the current tabset intact and spawn a useful default neighbor.
    right = {
      type: "tabset",
      id: tabsetAlloc.id,
      tabs: [fallbackTab],
      activeTab: fallbackTab,
    };
  }

  const splitNode: RightSidebarLayoutNode = {
    type: "split",
    id: splitAlloc.id,
    direction,
    sizes: [50, 50],
    children: [left, right],
  };

  // Replace the focused tabset node in-place.
  const replaceFocused = (node: RightSidebarLayoutNode): RightSidebarLayoutNode => {
    if (node.type === "tabset") {
      return node.id === focused.id ? splitNode : node;
    }

    return {
      ...node,
      children: [replaceFocused(node.children[0]), replaceFocused(node.children[1])],
    };
  };

  return {
    ...state,
    nextId: tabsetAlloc.nextId,
    focusedTabsetId: newFocusedId,
    root: replaceFocused(state.root),
  };
}

export function updateSplitSizes(
  state: RightSidebarLayoutState,
  splitId: string,
  sizes: [number, number]
): RightSidebarLayoutState {
  const update = (node: RightSidebarLayoutNode): RightSidebarLayoutNode => {
    if (node.type === "split") {
      if (node.id === splitId) {
        return { ...node, sizes };
      }
      return {
        ...node,
        children: [update(node.children[0]), update(node.children[1])],
      };
    }
    return node;
  };

  return {
    ...state,
    root: update(state.root),
  };
}

export function collectAllTabs(node: RightSidebarLayoutNode): TabType[] {
  if (node.type === "tabset") return [...node.tabs];
  return [...collectAllTabs(node.children[0]), ...collectAllTabs(node.children[1])];
}
export function collectActiveTabs(node: RightSidebarLayoutNode): TabType[] {
  if (node.type === "tabset") return [node.activeTab];
  return [...collectActiveTabs(node.children[0]), ...collectActiveTabs(node.children[1])];
}

/**
 * Collect all tabs from all tabsets with their tabset IDs.
 * Returns tabs in layout order (depth-first, left-to-right/top-to-bottom).
 */
export function collectAllTabsWithTabset(
  node: RightSidebarLayoutNode
): Array<{ tab: TabType; tabsetId: string }> {
  if (node.type === "tabset") {
    return node.tabs.map((tab) => ({ tab, tabsetId: node.id }));
  }
  return [
    ...collectAllTabsWithTabset(node.children[0]),
    ...collectAllTabsWithTabset(node.children[1]),
  ];
}

/**
 * Select a tab by its position in the layout (0-indexed).
 * Returns the updated state, or the original state if index is out of bounds.
 */
export function selectTabByIndex(
  state: RightSidebarLayoutState,
  index: number
): RightSidebarLayoutState {
  const allTabs = collectAllTabsWithTabset(state.root);
  if (index < 0 || index >= allTabs.length) {
    return state;
  }
  const { tab, tabsetId } = allTabs[index];
  return selectTabInTabset(setFocusedTabset(state, tabsetId), tabsetId, tab);
}

export function getFocusedActiveTab(state: RightSidebarLayoutState, fallback: TabType): TabType {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type === "tabset") return focused.activeTab;
  return fallback;
}
export function addToolToFocusedTabset(
  state: RightSidebarLayoutState,
  tab: TabType
): RightSidebarLayoutState {
  return selectTabInFocusedTabset(state, tab);
}

/**
 * Add a tab to the focused tabset without changing the active tab.
 * Used for feature-flagged tabs that should be available but not auto-selected.
 */
export function addTabToFocusedTabset(
  state: RightSidebarLayoutState,
  tab: TabType,
  /** Whether to make the new tab active (default: true) */
  activate = true
): RightSidebarLayoutState {
  const focused = findTabset(state.root, state.focusedTabsetId);
  if (focused?.type !== "tabset") {
    return state;
  }

  // Already has the tab - just activate if requested
  if (focused.tabs.includes(tab)) {
    if (activate && focused.activeTab !== tab) {
      return {
        ...state,
        root: updateNode(state.root, focused.id, (ts) => ({
          ...ts,
          activeTab: tab,
        })),
      };
    }
    return state;
  }

  return {
    ...state,
    root: updateNode(state.root, focused.id, (ts) => ({
      ...ts,
      tabs: [...ts.tabs, tab],
      activeTab: activate ? tab : ts.activeTab,
    })),
  };
}

/**
 * Move a tab from one tabset to another.
 * Handles edge cases:
 * - If source tabset becomes empty, it gets removed (along with its parent split if needed)
 * - If target tabset already has the tab, just activates it
 *
 * @returns Updated layout state, or original state if move is invalid
 */
export function moveTabToTabset(
  state: RightSidebarLayoutState,
  tab: TabType,
  sourceTabsetId: string,
  targetTabsetId: string
): RightSidebarLayoutState {
  // No-op if moving to same tabset
  if (sourceTabsetId === targetTabsetId) {
    return selectTabInTabset(state, targetTabsetId, tab);
  }

  const source = findTabset(state.root, sourceTabsetId);
  const target = findTabset(state.root, targetTabsetId);

  if (source?.type !== "tabset" || target?.type !== "tabset") {
    return state;
  }

  // Check if tab exists in source
  if (!source.tabs.includes(tab)) {
    return state;
  }

  // Update the tree: remove from source, add to target
  const updateNode = (node: RightSidebarLayoutNode): RightSidebarLayoutNode | null => {
    if (node.type === "tabset") {
      if (node.id === sourceTabsetId) {
        // Remove tab from source
        const newTabs = node.tabs.filter((t) => t !== tab);
        if (newTabs.length === 0) {
          // Tabset is now empty, signal for removal
          return null;
        }
        const newActiveTab = node.activeTab === tab ? newTabs[0] : node.activeTab;
        return { ...node, tabs: newTabs, activeTab: newActiveTab };
      }
      if (node.id === targetTabsetId) {
        // Add tab to target (avoid duplicates)
        const newTabs = target.tabs.includes(tab) ? target.tabs : [...target.tabs, tab];
        return { ...node, tabs: newTabs, activeTab: tab };
      }
      return node;
    }

    // Split node: recursively update children
    const left = updateNode(node.children[0]);
    const right = updateNode(node.children[1]);

    // Handle case where one child was removed (became null)
    if (left === null && right === null) {
      // Both children empty (shouldn't happen with valid moves)
      return null;
    }
    if (left === null) {
      // Left child removed, promote right
      return right;
    }
    if (right === null) {
      // Right child removed, promote left
      return left;
    }

    return {
      ...node,
      children: [left, right],
    };
  };

  const newRoot = updateNode(state.root);
  if (newRoot === null) {
    // Entire tree collapsed (shouldn't happen)
    return state;
  }

  // Ensure focusedTabsetId is still valid
  let newFocusedId: string = targetTabsetId;
  if (findTabset(newRoot, newFocusedId) === null) {
    newFocusedId = findFirstTabsetId(newRoot) ?? targetTabsetId;
  }

  return {
    ...state,
    focusedTabsetId: newFocusedId,
    root: newRoot,
  };
}

export type TabDockEdge = "left" | "right" | "top" | "bottom";

function getFallbackTabForEmptyTabset(movedTab: TabType): TabType {
  return movedTab === "terminal" ? "costs" : movedTab === "costs" ? "terminal" : "terminal";
}

/**
 * Create a new split adjacent to a target tabset and dock a dragged tab into it.
 *
 * This is the "edge drop" behavior for drag+dock:
 * - drop Left/Right => vertical split
 * - drop Top/Bottom => horizontal split
 *
 * Also handles:
 * - dragging a tab out of its own tabset (source === target)
 * - removing empty source tabsets (collapsing parent splits)
 * - avoiding empty tabsets when a user drags out the last remaining tab
 */
export function dockTabToEdge(
  state: RightSidebarLayoutState,
  tab: TabType,
  sourceTabsetId: string,
  targetTabsetId: string,
  edge: TabDockEdge
): RightSidebarLayoutState {
  const source = findTabset(state.root, sourceTabsetId);
  const target = findTabset(state.root, targetTabsetId);

  if (source?.type !== "tabset" || target?.type !== "tabset") {
    return state;
  }

  if (!source.tabs.includes(tab)) {
    return state;
  }

  const splitDirection: "horizontal" | "vertical" =
    edge === "top" || edge === "bottom" ? "horizontal" : "vertical";
  const insertBefore = edge === "top" || edge === "left";

  const splitAlloc = allocId(state, "split");
  const tabsetAlloc = allocId({ ...state, nextId: splitAlloc.nextId }, "tabset");

  const newTabset: Extract<RightSidebarLayoutNode, { type: "tabset" }> = {
    type: "tabset",
    id: tabsetAlloc.id,
    tabs: [tab],
    activeTab: tab,
  };

  const updateNode = (node: RightSidebarLayoutNode): RightSidebarLayoutNode | null => {
    if (node.type === "tabset") {
      if (node.id === targetTabsetId) {
        let updatedTarget = node;

        // When dragging out of this tabset, remove the tab before splitting.
        if (sourceTabsetId === targetTabsetId) {
          const remaining = node.tabs.filter((t) => t !== tab);
          const fallbackTab = getFallbackTabForEmptyTabset(tab);
          const nextTabs = remaining.length > 0 ? remaining : [fallbackTab];
          const nextActiveTab =
            node.activeTab === tab || !nextTabs.includes(node.activeTab)
              ? nextTabs[0]
              : node.activeTab;
          updatedTarget = { ...node, tabs: nextTabs, activeTab: nextActiveTab };
        }

        const children: [RightSidebarLayoutNode, RightSidebarLayoutNode] = insertBefore
          ? [newTabset, updatedTarget]
          : [updatedTarget, newTabset];

        return {
          type: "split",
          id: splitAlloc.id,
          direction: splitDirection,
          sizes: [50, 50],
          children,
        };
      }

      if (node.id === sourceTabsetId) {
        // Remove from source (unless source === target, handled above).
        if (sourceTabsetId === targetTabsetId) {
          return node;
        }

        const remaining = node.tabs.filter((t) => t !== tab);
        if (remaining.length === 0) {
          return null;
        }

        const nextActiveTab = node.activeTab === tab ? remaining[0] : node.activeTab;
        return { ...node, tabs: remaining, activeTab: nextActiveTab };
      }

      return node;
    }

    const left = updateNode(node.children[0]);
    const right = updateNode(node.children[1]);

    if (left === null && right === null) {
      return null;
    }
    if (left === null) {
      return right;
    }
    if (right === null) {
      return left;
    }

    return {
      ...node,
      children: [left, right],
    };
  };

  const newRoot = updateNode(state.root);
  if (newRoot === null) {
    return state;
  }

  const newFocusedId = tabsetAlloc.id;

  return {
    ...state,
    nextId: tabsetAlloc.nextId,
    focusedTabsetId: findTabset(newRoot, newFocusedId) ? newFocusedId : state.focusedTabsetId,
    root: newRoot,
  };
}

/**
 * Close (remove) a split, keeping one of its children.
 * Called when user wants to close a pane.
 *
 * @param keepChildIndex Which child to keep (0 = first/left/top, 1 = second/right/bottom)
 */
export function closeSplit(
  state: RightSidebarLayoutState,
  splitId: string,
  keepChildIndex: 0 | 1
): RightSidebarLayoutState {
  const replaceNode = (node: RightSidebarLayoutNode): RightSidebarLayoutNode => {
    if (node.type === "tabset") {
      return node;
    }

    if (node.id === splitId) {
      // Replace this split with the kept child
      return node.children[keepChildIndex];
    }

    return {
      ...node,
      children: [replaceNode(node.children[0]), replaceNode(node.children[1])],
    };
  };

  const newRoot = replaceNode(state.root);

  // Ensure focusedTabsetId is still valid
  let newFocusedId: string = state.focusedTabsetId;
  if (findTabset(newRoot, newFocusedId) === null) {
    newFocusedId = findFirstTabsetId(newRoot) ?? state.focusedTabsetId;
  }

  return {
    ...state,
    focusedTabsetId: newFocusedId,
    root: newRoot,
  };
}
