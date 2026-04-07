import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import { formatModelDisplayName } from "@/common/utils/ai/modelDisplay";
import { getModelName } from "@/common/utils/ai/models";
import { WorkspaceStatusIndicator } from "./WorkspaceStatusIndicator";

const FALLBACK_MODEL = "anthropic:claude-sonnet-4-5";
const PENDING_MODEL = "openai:gpt-4o-mini";
const PENDING_DISPLAY_NAME = formatModelDisplayName(getModelName(PENDING_MODEL));

function createSidebarState(
  overrides: Partial<WorkspaceStoreModule.WorkspaceSidebarState> = {}
): WorkspaceStoreModule.WorkspaceSidebarState {
  return {
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
  };
}

function renderIndicator(
  overrides: Partial<WorkspaceStoreModule.WorkspaceSidebarState> = {},
  workspaceId = "workspace"
) {
  const state = createSidebarState(overrides);
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(() => state);
  const view = render(
    <WorkspaceStatusIndicator workspaceId={workspaceId} fallbackModel={FALLBACK_MODEL} />
  );
  return {
    state,
    view,
    rerender(nextWorkspaceId = workspaceId) {
      view.rerender(
        <WorkspaceStatusIndicator workspaceId={nextWorkspaceId} fallbackModel={FALLBACK_MODEL} />
      );
    },
    phaseSlot: () => view.container.querySelector("[data-phase-slot]"),
    phaseIcon: () => view.container.querySelector("[data-phase-slot] svg"),
    modelDisplay: () => view.container.querySelector("[data-model-display]"),
  };
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

  for (const [name, overrides, spins] of [
    [
      "keeps unfinished todo status static once the stream is idle",
      { agentStatus: { emoji: "🔄", message: "Run checks" } },
      false,
    ],
    [
      "keeps refresh-style status animated while a stream is still active",
      { canInterrupt: true, agentStatus: { emoji: "🔄", message: "Run checks" } },
      true,
    ],
  ] satisfies Array<[string, Partial<WorkspaceStoreModule.WorkspaceSidebarState>, boolean]>) {
    test(name, () => {
      const { view } = renderIndicator(overrides, name);
      const className = view.container.querySelector("svg")?.getAttribute("class") ?? "";
      expect(view.container.querySelector("svg")).toBeTruthy();
      expect(className.includes("animate-spin")).toBe(spins);
    });
  }

  test("keeps the model label anchored when starting hands off to streaming", () => {
    const indicator = renderIndicator(
      { isStarting: true, pendingStreamModel: PENDING_MODEL },
      "workspace-phase-shift-starting"
    );
    expect(indicator.phaseSlot()?.getAttribute("class") ?? "").toContain("w-3");
    expect(indicator.phaseSlot()?.getAttribute("class") ?? "").toContain("mr-1.5");
    expect(indicator.phaseIcon()?.getAttribute("class") ?? "").toContain("animate-spin");
    expect(indicator.modelDisplay()?.textContent ?? "").toContain(PENDING_DISPLAY_NAME);
    expect(indicator.view.container.textContent?.toLowerCase()).toContain("starting");

    Object.assign(indicator.state, {
      isStarting: false,
      canInterrupt: true,
      currentModel: PENDING_MODEL,
      pendingStreamModel: null,
    });
    indicator.rerender("workspace-phase-shift-streaming");

    expect(indicator.phaseSlot()?.getAttribute("class") ?? "").toContain("w-0");
    expect(indicator.phaseSlot()?.getAttribute("class") ?? "").toContain("mr-0");
    expect(indicator.phaseIcon()?.getAttribute("class") ?? "").not.toContain("animate-spin");
    fireEvent.transitionEnd(indicator.phaseSlot()!, { propertyName: "width" });
    expect(indicator.phaseSlot()).toBeNull();
    expect(indicator.modelDisplay()?.textContent ?? "").toContain(PENDING_DISPLAY_NAME);
    expect(indicator.view.container.textContent?.toLowerCase()).toContain("streaming");
  });

  test("does not leak the collapsed handoff slot after agent status hides it", () => {
    const indicator = renderIndicator(
      { isStarting: true, pendingStreamModel: PENDING_MODEL },
      "workspace-status-handoff-starting"
    );
    expect(indicator.phaseSlot()?.getAttribute("class") ?? "").toContain("w-3");

    Object.assign(indicator.state, {
      isStarting: false,
      canInterrupt: true,
      currentModel: PENDING_MODEL,
      pendingStreamModel: null,
      agentStatus: { emoji: "🔄", message: "Run checks" },
    });
    indicator.rerender("workspace-status-handoff-status");
    expect(indicator.phaseSlot()).toBeNull();
    expect(indicator.view.container.textContent ?? "").toContain("Run checks");

    indicator.state.agentStatus = undefined;
    indicator.rerender("workspace-status-handoff-streaming");
    expect(indicator.phaseSlot()).toBeNull();
    expect(indicator.modelDisplay()?.textContent ?? "").toContain(PENDING_DISPLAY_NAME);
    expect(indicator.view.container.textContent?.toLowerCase()).toContain("streaming");
  });
});
