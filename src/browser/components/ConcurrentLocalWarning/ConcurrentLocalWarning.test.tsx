import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import type { WorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type { WorkspaceSidebarState, WorkspaceStore } from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { WORKSPACE_STREAMING_STATUS_TRANSITION_MS } from "@/constants/streaming";
import { useConcurrentLocalStreamingWorkspaceName } from "./ConcurrentLocalWarning";

const subscribers = new Set<() => void>();
let canInterrupt = true;

const fakeStore = {
  subscribeKey: (_workspaceId: string, listener: () => void) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  getWorkspaceSidebarState: () => {
    const state: WorkspaceSidebarState = {
      canInterrupt,
      isStarting: false,
      awaitingUserQuestion: false,
      lastAbortReason: null,
      currentModel: null,
      pendingStreamModel: null,
      recencyTimestamp: null,
      loadedSkills: [],
      skillLoadErrors: [],
      agentStatus: undefined,
      activeWorkflowRunCount: 0,
      activeBashMonitorCount: 0,
      terminalActiveCount: 0,
      terminalSessionCount: 0,
    };
    return state;
  },
} as unknown as WorkspaceStore;

const otherWorkspaceMetadata: FrontendWorkspaceMetadata = {
  id: "other-workspace",
  name: "refactor-db",
  projectName: "mux",
  projectPath: "/repo",
  namedWorkspacePath: "/repo",
  runtimeConfig: { type: "local" },
};
const workspaceMetadata = new Map([[otherWorkspaceMetadata.id, otherWorkspaceMetadata]]);

function WarningNameProbe() {
  const streamingWorkspaceName = useConcurrentLocalStreamingWorkspaceName({
    workspaceId: "current-workspace",
    projectPath: "/repo",
    runtimeConfig: { type: "local" },
  });

  return streamingWorkspaceName === null ? null : <div>{streamingWorkspaceName}</div>;
}

function notifyWorkspaceStateChanged(): void {
  for (const listener of subscribers) {
    listener();
  }
}

describe("ConcurrentLocalWarning", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    subscribers.clear();
    canInterrupt = true;
    spyOn(WorkspaceStoreModule, "useWorkspaceStoreRaw").mockReturnValue(fakeStore);
    spyOn(WorkspaceContextModule, "useWorkspaceContext").mockReturnValue({
      workspaceMetadata,
    } as WorkspaceContext);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
    subscribers.clear();
  });

  test("holds the warning across a brief activity handoff", async () => {
    const result = render(<WarningNameProbe />);
    expect(result.getByText("refactor-db")).toBeTruthy();

    act(() => {
      canInterrupt = false;
      notifyWorkspaceStateChanged();
    });

    expect(result.getByText("refactor-db")).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) =>
        window.setTimeout(resolve, WORKSPACE_STREAMING_STATUS_TRANSITION_MS + 50)
      );
    });
    await waitFor(() => expect(result.queryByText("refactor-db")).toBeNull());
  });
});
