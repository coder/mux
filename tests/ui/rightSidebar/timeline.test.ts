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
import { CUSTOM_EVENTS } from "@/common/constants/events";
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
    loadErrorKind: null,
  };
}

function renderTimeline(params: {
  events: TimelineEvent[];
  loadOlderHistory?: jest.Mock<Promise<"loaded">, [string]>;
  snapshot?: Partial<WorkspaceTimelineSnapshot>;
  hasOlderHistory?: boolean;
}) {
  const loadOlderHistory = params.loadOlderHistory ?? jest.fn().mockResolvedValue("loaded");
  const workspaceState: { messages: unknown[]; muxMessages: unknown[]; hasOlderHistory: boolean } =
    {
      messages: [],
      muxMessages: [],
      hasOlderHistory: params.hasOlderHistory ?? true,
    };
  const workspaceStore = {
    getWorkspaceState: jest.fn(() => workspaceState),
    loadOlderHistory,
    loadOlderTimeline: jest.fn().mockResolvedValue(undefined),
    retryTimeline: jest.fn(),
  };

  mockUseWorkspaceTimeline.mockReturnValue({
    ...timelineSnapshot(params.events),
    ...params.snapshot,
  });
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

  return { ...view, loadOlderHistory, workspaceStore, workspaceState };
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
      makeEvent("agent-event", "agent.event", 3, {
        source: { system: "agent" },
        data: { description: "Committed the backend slice", category: "milestone" },
      }),
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
        '[data-timeline-event-id="agent-event"][data-timeline-source="agent"]'
      )
    ).not.toBeNull();
    expect(view.getByText("Committed the backend slice")).not.toBeNull();
    expect(view.getByText("milestone")).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-timeline-event-id="user-turn"][data-timeline-source="chat"]'
      )
    ).not.toBeNull();
  });

  test("category filters narrow the feed and isolate agent events", () => {
    const events = [
      makeEvent("turn", "turn.user", 1),
      makeEvent("task", "task.created", 2, { source: { system: "task" } }),
      makeEvent("agent-event", "agent.event", 3, { source: { system: "agent" } }),
      makeEvent("agent-plan", "agent.plan_proposed", 4, { source: { system: "agent" } }),
    ];

    const view = renderTimeline({ events });
    const filterButtons = Array.from(view.container.querySelectorAll("button[aria-pressed]"));
    const subagentsFilter = filterButtons.find((button) => button.textContent === "Subagents");
    const agentFilter = filterButtons.find((button) => button.textContent === "Agent");

    if (!subagentsFilter || !agentFilter) {
      throw new Error("Expected timeline category controls");
    }

    fireEvent.click(subagentsFilter);
    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(1);
    expect(view.container.querySelector('[data-timeline-event-id="task"]')).not.toBeNull();

    fireEvent.click(agentFilter);
    const visibleRows = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-timeline-event-id]")
    );
    expect(visibleRows).toHaveLength(2);
    expect(visibleRows.every((row) => row.dataset.timelineSource === "agent")).toBe(true);
  });

  test("keeps machine-dispatched turns and turn outcomes out of the prompts filter", () => {
    const events = [
      makeEvent("human", "turn.user", 1),
      makeEvent("wakeup", "turn.synthetic", 2),
      makeEvent("outcome", "turn.completed", 3),
      makeEvent("stopped", "turn.interrupted", 4),
    ];

    const view = renderTimeline({ events });
    const promptsFilter = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Prompts"
    );
    if (!promptsFilter) throw new Error("Expected the prompts filter control");

    fireEvent.click(promptsFilter);

    const visible = Array.from(
      view.container.querySelectorAll<HTMLElement>("[data-timeline-event-id]")
    ).map((row) => row.dataset.timelineEventId);
    expect(visible).toEqual(["human"]);
  });

  test("collapses three consecutive same-kind rows and expands the run", () => {
    const events = [
      makeEvent("heartbeat-1", "heartbeat.dispatched", 1, { source: { system: "heartbeat" } }),
      makeEvent("heartbeat-2", "heartbeat.dispatched", 2, { source: { system: "heartbeat" } }),
      makeEvent("heartbeat-3", "heartbeat.dispatched", 3, { source: { system: "heartbeat" } }),
      makeEvent("turn", "turn.completed", 4),
    ];

    const view = renderTimeline({ events });
    const collapsedRun = view.container.querySelector<HTMLElement>(
      '[data-timeline-collapsed-kind="heartbeat.dispatched"][data-timeline-collapsed-count="3"]'
    );

    expect(collapsedRun).not.toBeNull();
    expect(collapsedRun?.getAttribute("aria-expanded")).toBe("false");
    expect(
      view.container.querySelectorAll('[data-timeline-event-kind="heartbeat.dispatched"]')
    ).toHaveLength(0);

    fireEvent.click(collapsedRun!);

    expect(
      view.container.querySelectorAll('[data-timeline-event-kind="heartbeat.dispatched"]')
    ).toHaveLength(3);
    expect(
      view.container
        .querySelector('[data-timeline-collapsed-kind="heartbeat.dispatched"]')
        ?.getAttribute("aria-expanded")
    ).toBe("true");
  });

  test("stops reveal pagination at the page cap when the target remains unavailable", async () => {
    const loadOlderHistory = jest.fn<Promise<"loaded">, [string]>().mockResolvedValue("loaded");
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "missing-message" },
    });
    const view = renderTimeline({ events: [event], loadOlderHistory });

    fireEvent.click(view.container.querySelector('[data-timeline-event-id="anchored"]')!);

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

  test("reveals a target that expanding the display cap makes renderable", async () => {
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "capped-message" },
    });
    // No older history to page, so the only way to reach the target is the cap expansion.
    const view = renderTimeline({ events: [event], hasOlderHistory: false });
    mockShowAllMessages.mockImplementation(() => {
      view.workspaceState.messages = [{ historyId: "capped-message" }];
    });
    const revealed: unknown[] = [];
    const listener = (revealEvent: Event) => revealed.push(revealEvent);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      fireEvent.click(view.container.querySelector('[data-timeline-event-id="anchored"]')!);
      const revealButton = await waitFor(() => view.getByTestId("timeline-reveal"));
      fireEvent.click(revealButton);

      await waitFor(() => {
        if (revealed.length === 0) throw new Error("Reveal was not dispatched");
      });
      expect(view.queryByTestId("timeline-reveal-not-found")).toBeNull();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  test("selects an anchored context boundary so its summary stays reachable", async () => {
    const events = [
      makeEvent("boundary", "compaction.completed", 1, {
        epoch: 2,
        anchor: { messageId: "summary-message" },
      }),
      makeEvent("plain-boundary", "context.reset", 2),
    ];

    const view = renderTimeline({ events });
    const boundary = view.container.querySelector<HTMLElement>(
      '[data-timeline-event-id="boundary"]'
    );
    if (!boundary) throw new Error("Expected the anchored boundary to be selectable");
    expect(view.container.querySelector('[data-timeline-event-id="plain-boundary"]')).toBeNull();

    fireEvent.click(boundary);

    await waitFor(() => view.getByTestId("timeline-reveal"));
    expect(boundary.getAttribute("aria-pressed")).toBe("true");
  });

  test("reveals the selected event from the keyboard shortcut", async () => {
    const event = makeEvent("anchored", "turn.completed", 1, {
      anchor: { messageId: "loaded-message" },
    });
    const view = renderTimeline({ events: [event] });
    view.workspaceState.messages = [{ historyId: "loaded-message" }];
    const revealed: unknown[] = [];
    const listener = (revealEvent: Event) => revealed.push(revealEvent);
    window.addEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);

    try {
      fireEvent.click(view.container.querySelector('[data-timeline-event-id="anchored"]')!);
      await waitFor(() => view.getByTestId("timeline-reveal"));

      fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, shiftKey: true });

      await waitFor(() => {
        if (revealed.length === 0) throw new Error("Reveal was not dispatched");
      });
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.REVEAL_TIMELINE_ANCHOR, listener);
    }
  });

  test("keeps pagination reachable when the active filter has no matches", () => {
    const view = renderTimeline({
      events: [makeEvent("task", "task.created", 1, { source: { system: "task" } })],
      snapshot: { hasOlder: true, nextCursor: 1 },
    });

    const filterButton = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Prompts"
    );
    if (!filterButton) throw new Error("Expected the prompts filter control");
    fireEvent.click(filterButton);

    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(0);
    const loadOlder = Array.from(view.container.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("Load older")
    );
    expect(loadOlder).not.toBeUndefined();
  });

  test("offers a reconnect when the subscription dies with rows already on screen", () => {
    const view = renderTimeline({
      events: [makeEvent("kept", "turn.completed", 1)],
      snapshot: { loadError: "Subscription closed", loadErrorKind: "subscription" },
    });

    expect(view.container.querySelectorAll("[data-timeline-event-id]")).toHaveLength(1);
    const reconnect = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Reconnect"
    );
    if (!reconnect) throw new Error("Expected a reconnect control");
    fireEvent.click(reconnect);

    expect(view.workspaceStore.retryTimeline).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  test("does not offer a reconnect for a failed older page", () => {
    const view = renderTimeline({
      events: [makeEvent("kept", "turn.completed", 1)],
      snapshot: {
        loadError: "Failed to load older events",
        loadErrorKind: "pagination",
        hasOlder: true,
        nextCursor: 1,
      },
    });

    expect(view.container.textContent).toContain("Failed to load older events");
    expect(
      Array.from(view.container.querySelectorAll("button")).some(
        (button) => button.textContent === "Reconnect"
      )
    ).toBe(false);
  });

  test("reports a failed load instead of an empty timeline, and retries on request", () => {
    const view = renderTimeline({
      events: [],
      snapshot: { loadError: "Failed to load timeline" },
    });

    expect(view.container.textContent).toContain("Failed to load timeline");
    expect(view.container.textContent).not.toContain("No timeline events yet");

    const retry = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry"
    );
    if (!retry) throw new Error("Expected a retry control");
    fireEvent.click(retry);

    expect(view.workspaceStore.retryTimeline).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});
