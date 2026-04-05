import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";

import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelName } from "@/common/utils/ai/models";
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
    pendingStreamModel: null,
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

  test("keeps the steady streaming layout free of the transient handoff slot", () => {
    mockSidebarState({
      canInterrupt: true,
      currentModel: "openai:gpt-4o-mini",
    });

    const view = render(
      <WorkspaceStatusIndicator
        workspaceId="workspace-live-stream"
        fallbackModel="anthropic:claude-sonnet-4-5"
      />
    );

    expect(view.container.querySelector("[data-phase-slot]")).toBeNull();
    expect(view.container.textContent?.toLowerCase()).toContain("streaming");
  });

  test("keeps the model label anchored when starting hands off to streaming", () => {
    const pendingModel = "openai:gpt-4o-mini";
    const fallbackModel = "anthropic:claude-sonnet-4-5";
    const pendingDisplayName = formatModelDisplayName(getModelName(pendingModel));
    const fallbackDisplayName = formatModelDisplayName(getModelName(fallbackModel));
    const state: WorkspaceStoreModule.WorkspaceSidebarState = {
      canInterrupt: false,
      isStarting: true,
      awaitingUserQuestion: false,
      lastAbortReason: null,
      currentModel: null,
      pendingStreamModel: pendingModel,
      recencyTimestamp: null,
      loadedSkills: [],
      skillLoadErrors: [],
      agentStatus: undefined,
      terminalActiveCount: 0,
      terminalSessionCount: 0,
    };
    spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(() => state);

    const view = render(
      <WorkspaceStatusIndicator
        workspaceId="workspace-phase-shift-starting"
        fallbackModel={fallbackModel}
      />
    );

    const getPhaseSlot = () => view.container.querySelector("[data-phase-slot]");
    const getPhaseIcon = () => getPhaseSlot()?.querySelector("svg");
    const getModelDisplay = () => view.container.querySelector("[data-model-display]");

    expect(getPhaseSlot()?.getAttribute("class") ?? "").toContain("w-3");
    expect(getPhaseSlot()?.getAttribute("class") ?? "").toContain("mr-1.5");
    expect(getPhaseIcon()?.getAttribute("class") ?? "").toContain("animate-spin");
    expect(getModelDisplay()?.textContent ?? "").toContain(pendingDisplayName);
    expect(getModelDisplay()?.textContent ?? "").not.toContain(fallbackDisplayName);
    expect(view.container.textContent?.toLowerCase()).toContain("starting");

    state.isStarting = false;
    state.canInterrupt = true;
    state.currentModel = pendingModel;
    state.pendingStreamModel = null;
    view.rerender(
      <WorkspaceStatusIndicator
        workspaceId="workspace-phase-shift-streaming"
        fallbackModel={fallbackModel}
      />
    );

    expect(getPhaseSlot()?.getAttribute("class") ?? "").toContain("w-0");
    expect(getPhaseSlot()?.getAttribute("class") ?? "").toContain("mr-0");
    expect(getPhaseIcon()?.getAttribute("class") ?? "").not.toContain("animate-spin");
    expect(getModelDisplay()?.textContent ?? "").toContain(pendingDisplayName);
    expect(getModelDisplay()?.textContent ?? "").not.toContain(fallbackDisplayName);
    expect(view.container.textContent?.toLowerCase()).toContain("streaming");
  });
});
