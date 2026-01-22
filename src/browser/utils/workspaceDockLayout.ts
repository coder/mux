import { isTabType, type TabType } from "@/browser/types/rightSidebar";
import {
  addTabToFocusedTabset,
  collectAllTabs,
  findTabset,
  removeTabEverywhere,
  type DockLayoutNode,
  type DockLayoutState,
} from "@/browser/utils/dockLayout";
import {
  parseRightSidebarLayoutState,
  type RightSidebarLayoutNode,
} from "@/browser/utils/rightSidebarLayout";

export type WorkspacePaneId = `chat:${string}` | TabType;

export function isWorkspacePaneId(value: unknown): value is WorkspacePaneId {
  if (typeof value !== "string") return false;
  if (value.startsWith("chat:")) return true;
  return isTabType(value);
}

export function allocWorkspaceChatPaneId(state: DockLayoutState<WorkspacePaneId>): WorkspacePaneId {
  const used = new Set<number>();

  for (const tab of collectAllTabs(state.root)) {
    if (typeof tab !== "string" || !tab.startsWith("chat:")) {
      continue;
    }

    const suffix = tab.slice("chat:".length);
    if (suffix === "main") {
      continue;
    }

    const parsed = Number.parseInt(suffix, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== suffix) {
      continue;
    }

    used.add(parsed);
  }

  let next = 1;
  while (used.has(next)) {
    next += 1;
  }

  return `chat:${next}` as WorkspacePaneId;
}
export const DEFAULT_CHAT_PANE_ID: WorkspacePaneId = "chat:main";

export function getDefaultWorkspaceDockLayoutState(options: {
  initialToolTab: TabType;
  statsTabEnabled: boolean;
}): DockLayoutState<WorkspacePaneId> {
  const baseTabs: TabType[] = ["costs", "review", "explorer"];
  const withStats: TabType[] = options.statsTabEnabled ? [...baseTabs, "stats"] : baseTabs;

  const shouldIncludeInitialToolTab = options.initialToolTab !== "terminal";
  const toolTabs = shouldIncludeInitialToolTab
    ? withStats.includes(options.initialToolTab)
      ? withStats
      : [...withStats, options.initialToolTab]
    : withStats;

  const toolActiveTab = toolTabs.includes(options.initialToolTab)
    ? options.initialToolTab
    : (toolTabs[0] ?? "costs");

  return {
    version: 1,
    nextId: 3,
    focusedTabsetId: "tabset-1",
    root: {
      type: "split",
      id: "split-1",
      direction: "vertical",
      sizes: [70, 30],
      children: [
        {
          type: "tabset",
          id: "tabset-1",
          tabs: [DEFAULT_CHAT_PANE_ID],
          activeTab: DEFAULT_CHAT_PANE_ID,
        },
        {
          type: "tabset",
          id: "tabset-2",
          tabs: toolTabs,
          activeTab: toolActiveTab,
        },
      ],
    },
  };
}

function convertRightSidebarNodeToWorkspaceDockNode(
  node: RightSidebarLayoutNode,
  options: {
    statsTabEnabled: boolean;
  }
): DockLayoutNode<WorkspacePaneId> {
  if (node.type === "tabset") {
    const tabs = node.tabs
      .filter((t) => t !== "terminal")
      .filter((t) => options.statsTabEnabled || t !== "stats");

    const nextTabs = tabs.length > 0 ? tabs : (["explorer"] satisfies TabType[]);
    const preferredActiveTab = node.activeTab === "terminal" ? nextTabs[0] : node.activeTab;
    const activeTab = nextTabs.includes(preferredActiveTab) ? preferredActiveTab : nextTabs[0];

    return {
      type: "tabset",
      id: `tools-${node.id}`,
      tabs: nextTabs,
      activeTab,
    };
  }

  return {
    type: "split",
    id: `tools-${node.id}`,
    direction: node.direction,
    sizes: node.sizes,
    children: [
      convertRightSidebarNodeToWorkspaceDockNode(node.children[0], options),
      convertRightSidebarNodeToWorkspaceDockNode(node.children[1], options),
    ],
  };
}

export function migrateRightSidebarLayoutToWorkspaceDockLayout(options: {
  rightSidebarLayoutRaw: unknown;
  initialToolTab: TabType;
  statsTabEnabled: boolean;
}): DockLayoutState<WorkspacePaneId> {
  const parsed = parseRightSidebarLayoutState(
    options.rightSidebarLayoutRaw,
    options.initialToolTab
  );

  return {
    version: 1,
    nextId: 2,
    focusedTabsetId: `tools-${parsed.focusedTabsetId}`,
    root: {
      type: "split",
      id: "split-1",
      direction: "vertical",
      sizes: [70, 30],
      children: [
        {
          type: "tabset",
          id: "tabset-1",
          tabs: [DEFAULT_CHAT_PANE_ID],
          activeTab: DEFAULT_CHAT_PANE_ID,
        },
        convertRightSidebarNodeToWorkspaceDockNode(parsed.root, {
          statsTabEnabled: options.statsTabEnabled,
        }),
      ],
    },
  };
}

function injectTabIntoLayout<PaneId extends string>(
  node: DockLayoutNode<PaneId>,
  tab: PaneId,
  shouldInject: (tabset: Extract<DockLayoutNode<PaneId>, { type: "tabset" }>) => boolean
): { node: DockLayoutNode<PaneId>; injected: boolean } {
  if (node.type === "tabset") {
    if (shouldInject(node) && !node.tabs.includes(tab)) {
      return {
        node: {
          ...node,
          tabs: [...node.tabs, tab],
        },
        injected: true,
      };
    }

    return { node, injected: false };
  }

  const left = injectTabIntoLayout(node.children[0], tab, shouldInject);
  if (left.injected) {
    return {
      node: {
        ...node,
        children: [left.node, node.children[1]],
      },
      injected: true,
    };
  }

  const right = injectTabIntoLayout(node.children[1], tab, shouldInject);
  return {
    node: {
      ...node,
      children: [node.children[0], right.node],
    },
    injected: right.injected,
  };
}

function isChatPaneId(value: WorkspacePaneId): boolean {
  return typeof value === "string" && value.startsWith("chat:");
}

export function ensureWorkspaceDockLayoutState(
  state: DockLayoutState<WorkspacePaneId>,
  options: {
    statsTabEnabled: boolean;
    getDefaultState: () => DockLayoutState<WorkspacePaneId>;
  }
): DockLayoutState<WorkspacePaneId> {
  let next = state;

  let tabs = collectAllTabs(next.root);
  const hasChat = tabs.some((t) => isChatPaneId(t));
  if (!hasChat) {
    return options.getDefaultState();
  }

  // Ensure explorer is always present somewhere.
  if (!tabs.includes("explorer")) {
    const injected = injectTabIntoLayout(next.root, "explorer", (ts) =>
      ts.tabs.some((t) => !isChatPaneId(t))
    );

    next = injected.injected
      ? { ...next, root: injected.node }
      : addTabToFocusedTabset(next, "explorer", false);

    tabs = collectAllTabs(next.root);
  }

  // Stats tab: add/remove based on feature flag.
  if (options.statsTabEnabled) {
    if (!tabs.includes("stats")) {
      const injected = injectTabIntoLayout(next.root, "stats", (ts) =>
        ts.tabs.some((t) => !isChatPaneId(t))
      );

      next = injected.injected
        ? { ...next, root: injected.node }
        : addTabToFocusedTabset(next, "stats", false);
      tabs = collectAllTabs(next.root);
    }
  } else if (tabs.includes("stats")) {
    next = removeTabEverywhere(next, "stats", options.getDefaultState);
    tabs = collectAllTabs(next.root);
  }

  // Ensure focused tabset exists.
  if (findTabset(next.root, next.focusedTabsetId) === null) {
    return options.getDefaultState();
  }

  return next;
}
