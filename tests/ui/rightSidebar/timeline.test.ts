import "../dom";

import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { APIContext } from "@/browser/contexts/API";
import { TimelinePanel } from "@/browser/features/RightSidebar/Timeline/TimelinePanel";
import {
  showAllMessages,
  useWorkspaceStoreRaw,
  useWorkspaceTimeline,
  type WorkspaceTimelineSnapshot,
} from "@/browser/stores/WorkspaceStore";
import type { TimelineEvent } from "@/common/orpc/schemas/timeline";

import { installDom } from "../dom";

jest.mock("@/browser/stores/WorkspaceStore", () => ({
  showAllMessages: jest.fn(),
  useWorkspaceStoreRaw: jest.fn(),
  useWorkspaceTimeline: jest.fn(),
}));

const WORKSPACE_ID = "timeline-test-workspace";
const BASE_TIMESTAMP = Date.UTC(2026, 6, 27, 12, 0, 0);

const mockShowAllMessages = jest.mocked(showAllMessages);
const mockUseWorkspaceStoreRaw = jest.mocked(useWorkspaceStoreRaw);
const mockUseWorkspaceTimeline = jest.mocked(useWorkspaceTimeline);

function makeEvent(
  id: string,
  kind: string,
  seq: number,
  overrides: Partial<TimelineEvent> = {}
): TimelineEvent {
  return {
    v: 1,
    id,
    kind,
    seq,
    ts: BASE_TIMESTAMP + seq * 1000,
    source: { system: "chat" },
    ...overrides,
  };
}

function timelineSnapshot(events: TimelineEvent[]): WorkspaceTimelineSnapshot {
  return {
    events,
    nextCursor: null,
    hasOlder: false,
    initialized: true,
    loadingOlder: false,
    loadError: null,
  };
}

function renderTimeline(params: {
  events: TimelineEvent[];
  loadOlderHistory?: jest.Mock<Promise<"loaded">, [string]>;
}) {
  const loadOlderHistory = params.loadOlderHistory ?? jest.fn().mockResolvedValue("loaded");
  const workspaceState = {
    messages: [],
    muxMessages: [],
    hasOlderHistory: true,
  };
  const workspaceStore = {
    getWorkspaceState: jest.fn(() => workspaceState),
    loadOlderHistory,
    loadOlderTimeline: jest.fn().mockResolvedValue(undefined),
  };

  mockUseWorkspaceTimeline.mockReturnValue(timelineSnapshot(params.events));
  mockUseWorkspaceStoreRaw.mockReturnValue(workspaceStore as never);

  const api = {
    workspace: {
      timeline: {
        preview: jest.fn().mockResolvedValue({
          role: "assistant",
          textExcerpt: "Preview fixture",
        }),
      },
    },
  };

  const view = render(
    React.createElement(APIContext.Provider, {
      value: {
        status: "connected",
        api: api as never,
        error: null,
        authenticate: () => undefined,
        retry: () => undefined,
      },
      children: React.createElement(TimelinePanel, { workspaceId: WORKSPACE_ID }),
    })
  );

  return { ...view, loadOlderHistory };
}

describe("TimelinePanel", () => {
  let cleanupDom: () => void;

  beforeEach(() => {
    cleanupDom = installDom();
    localStorage.clear();
    mockShowAllMessages.mockReset();
    mockUseWorkspaceStoreRaw.mockReset();
    mockUseWorkspaceTimeline.mockReset();
  });

  afterEach(() => {
    cleanup();
    cleanupDom();
  });

  test("renders fixture rows, unknown kinds, and agent-authored semantics", () => {
    const events = [
      makeEvent("user-turn", "turn.user", 1),
      makeEvent("future-event", "future.kind", 2),
      makeEvent("agent-mark", "agent.mark", 3, { source: { system: "agent" } }),
    ];

    const view = renderTimeline({ events });

    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(3);
    expect(
      view.container.querySelector(
        '[data-timeline-event-id="future-event"][data-timeline-event-kind="future.kind"]'
      )
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-timeline-event-id="agent-mark"][data-timeline-source="agent"]'
      )
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-timeline-event-id="user-turn"][data-timeline-source="chat"]'
      )
    ).not.toBeNull();
  });

  test("category filters narrow the feed and isolate agent notes", () => {
    const events = [
      makeEvent("turn", "turn.completed", 1),
      makeEvent("tool", "tool.call", 2),
      makeEvent("agent-mark", "agent.mark", 3, { source: { system: "agent" } }),
      makeEvent("agent-status", "agent.status", 4, { source: { system: "agent" } }),
    ];

    const view = renderTimeline({ events });
    const filterButtons = Array.from(view.container.querySelectorAll("button[aria-pressed]"));
    const toolsFilter = filterButtons.find((button) => button.textContent === "Tools");
    const agentNotesFilter = filterButtons.find((button) => button.textContent === "Agent notes");

    if (!toolsFilter || !agentNotesFilter) {
      throw new Error("Expected timeline category controls");
    }

    fireEvent.click(toolsFilter);
    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(1);
    expect(view.container.querySelector('[data-timeline-event-id="tool"]')).not.toBeNull();

    fireEvent.click(agentNotesFilter);
    const visibleRows = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-timeline-event-id]")
    );
    expect(visibleRows).toHaveLength(2);
    expect(visibleRows.every((row) => row.dataset.timelineSource === "agent")).toBe(true);
  });

  test("collapses three consecutive same-kind rows and expands the run", () => {
    const events = [
      makeEvent("tool-1", "tool.call", 1),
      makeEvent("tool-2", "tool.call", 2),
      makeEvent("tool-3", "tool.call", 3),
      makeEvent("turn", "turn.completed", 4),
    ];

    const view = renderTimeline({ events });
    const collapsedRun = view.container.querySelector<HTMLElement>(
      '[data-timeline-collapsed-kind="tool.call"][data-timeline-collapsed-count="3"]'
    );

    expect(collapsedRun).not.toBeNull();
    expect(collapsedRun?.getAttribute("aria-expanded")).toBe("false");
    expect(view.container.querySelectorAll('[data-timeline-event-kind="tool.call"]')).toHaveLength(
      0
    );

    fireEvent.click(collapsedRun as HTMLElement);

    expect(view.container.querySelectorAll('[data-timeline-event-kind="tool.call"]')).toHaveLength(
      3
    );
    expect(
      view.container
        .querySelector('[data-timeline-collapsed-kind="tool.call"]')
        ?.getAttribute("aria-expanded")
    ).toBe("true");
  });

  test("stops reveal pagination at the page cap when the target remains unavailable", async () => {
    const loadOlderHistory = jest.fn<Promise<"loaded">, [string]>().mockResolvedValue("loaded");
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "missing-message" },
    });
    const view = renderTimeline({ events: [event], loadOlderHistory });

    fireEvent.click(
      view.container.querySelector('[data-timeline-event-id="anchored"]') as HTMLElement
    );

    const revealButton = await waitFor(() => {
      const button = view.getByTestId("timeline-reveal");
      if (!button) throw new Error("Reveal action not rendered");
      return button;
    });
    fireEvent.click(revealButton);

    await waitFor(() => {
      expect(view.getByTestId("timeline-reveal-not-found")).not.toBeNull();
    });

    expect(loadOlderHistory).toHaveBeenCalledTimes(10);
    expect(loadOlderHistory).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(mockShowAllMessages).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});
