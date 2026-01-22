import { expect, test } from "bun:test";
import type { DockLayoutState } from "./dockLayout";
import {
  allocWorkspaceChatPaneId,
  getDefaultWorkspaceDockLayoutState,
  type WorkspacePaneId,
} from "./workspaceDockLayout";

function getDefaultState(): DockLayoutState<WorkspacePaneId> {
  return getDefaultWorkspaceDockLayoutState({
    initialToolTab: "costs",
    statsTabEnabled: false,
  });
}

test("allocWorkspaceChatPaneId returns chat:1 when only chat:main exists", () => {
  const s = getDefaultState();
  expect(allocWorkspaceChatPaneId(s)).toBe("chat:1");
});

test("allocWorkspaceChatPaneId returns next numeric chat id", () => {
  const s0 = getDefaultState();
  const s1: DockLayoutState<WorkspacePaneId> = {
    ...s0,
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["chat:main", "chat:1"],
      activeTab: "chat:main",
    },
  };

  expect(allocWorkspaceChatPaneId(s1)).toBe("chat:2");
});

test("allocWorkspaceChatPaneId finds first gap", () => {
  const s0 = getDefaultState();
  const s1: DockLayoutState<WorkspacePaneId> = {
    ...s0,
    root: {
      type: "tabset",
      id: "tabset-1",
      tabs: ["chat:main", "chat:1", "chat:3"],
      activeTab: "chat:main",
    },
  };

  expect(allocWorkspaceChatPaneId(s1)).toBe("chat:2");
});
