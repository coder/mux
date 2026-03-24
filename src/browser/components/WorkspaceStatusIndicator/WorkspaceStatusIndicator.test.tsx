import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";

import { WorkspaceStatusIndicator } from "./WorkspaceStatusIndicator";

function mockSidebarState(
  overrides: Partial<WorkspaceStoreModule.WorkspaceSidebarState> = {}
): void {
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(() => ({
    canInterrupt: false,
    isStarting: false,
    awaitingUserQuestion: false,
    lastAbortReason: null,
    currentModel: null,
    recencyTimestamp: null,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    terminalActiveCount: 0,
    terminalSessionCount: 0,
    ...overrides,
  }));
}

describe("WorkspaceStatusIndicator", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("keeps unfinished todo status static once the stream is idle", () => {
    mockSidebarState({
      agentStatus: { emoji: "🔄", message: "Run checks" },
    });

    const view = render(
      <WorkspaceStatusIndicator workspaceId="workspace-idle" fallbackModel="openai:gpt-5.4" />
    );

    const icon = view.container.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("class") ?? "").not.toContain("animate-spin");
  });

  test("keeps refresh-style status animated while a stream is still active", () => {
    mockSidebarState({
      canInterrupt: true,
      agentStatus: { emoji: "🔄", message: "Run checks" },
    });

    const view = render(
      <WorkspaceStatusIndicator workspaceId="workspace-streaming" fallbackModel="openai:gpt-5.4" />
    );

    const icon = view.container.querySelector("svg");
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute("class") ?? "").toContain("animate-spin");
  });
});
