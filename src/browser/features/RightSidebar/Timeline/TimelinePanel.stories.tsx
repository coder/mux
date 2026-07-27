import type { Meta, StoryObj } from "@storybook/react-vite";

import { APIContext } from "@/browser/contexts/API";
import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { TimelineEvent } from "@/common/orpc/schemas/timeline";

import { TimelinePanelView, type TimelineWorkspaceStore } from "./TimelinePanel";

const WORKSPACE_ID = "timeline-story-workspace";
const BASE_TIMESTAMP = Date.UTC(2020, 0, 15, 15, 0, 0);

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
    ts: BASE_TIMESTAMP - (20 - seq) * 45_000,
    source: { system: "chat" },
    ...overrides,
  };
}

const MIXED_EVENTS: TimelineEvent[] = [
  makeEvent("turn-completed", "turn.completed", 20, {
    status: "completed",
    data: { model: "anthropic/claude-sonnet-4", mode: "exec", durationMs: 84_000 },
    anchor: { messageId: "assistant-20" },
  }),
  makeEvent("failed-tool", "tool.call", 19, {
    status: "failed",
    data: { toolName: "bash", reason: "Typecheck exited with status 1" },
    anchor: { toolCallId: "tool-failed" },
  }),
  makeEvent("agent-status", "agent.status", 18, {
    source: { system: "agent", key: "timeline-agent" },
    status: "started",
    data: { statusMessage: "Validating the Timeline panel" },
  }),
  makeEvent("agent-mark", "agent.mark", 17, {
    source: { system: "agent", key: "timeline-agent" },
    data: {
      title: "Pagination guard verified",
      detail: "Reveal stops after ten older-history pages.",
      category: "milestone",
    },
  }),
  makeEvent("task-reported", "task.reported", 16, {
    source: { system: "task", key: "task_timeline_story" },
    status: "completed",
    data: { title: "Timeline story fixture completed" },
    anchor: { taskId: "task_timeline_story", childWorkspaceId: "timeline-child-workspace" },
  }),
  makeEvent("compaction", "compaction.completed", 15, {
    source: { system: "chat" },
    status: "completed",
    epoch: 3,
    data: { durationMs: 2_400 },
  }),
  makeEvent("file-edit-5", "tool.call", 14, {
    status: "completed",
    data: { toolName: "file_edit", title: "tests/ui/rightSidebar/timeline.test.ts" },
    anchor: { toolCallId: "tool-file-edit-5" },
  }),
  makeEvent("file-edit-4", "tool.call", 13, {
    status: "completed",
    data: { toolName: "file_edit", title: "TimelinePanel.stories.tsx" },
    anchor: { toolCallId: "tool-file-edit-4" },
  }),
  makeEvent("file-edit-3", "tool.call", 12, {
    status: "completed",
    data: { toolName: "file_edit", title: "timelinePresentation.ts" },
    anchor: { toolCallId: "tool-file-edit-3" },
  }),
  makeEvent("file-edit-2", "tool.call", 11, {
    status: "completed",
    data: { toolName: "file_edit", title: "TimelinePanel.tsx" },
    anchor: { toolCallId: "tool-file-edit-2" },
  }),
  makeEvent("file-edit-1", "tool.call", 10, {
    status: "completed",
    data: { toolName: "file_edit", title: "WorkspaceStore.ts" },
    anchor: { toolCallId: "tool-file-edit-1" },
  }),
  makeEvent("future-event", "future.kind", 9, {
    source: { system: "settings", key: "future-fixture" },
    data: { label: "Forward-compatible event" },
  }),
  makeEvent("user-turn", "turn.user", 8, {
    data: { title: "Add Timeline behavior coverage and responsive stories" },
    anchor: { messageId: "user-8" },
  }),
];

const STORY_STORE: TimelineWorkspaceStore = {
  getWorkspaceState: () => ({ messages: [], muxMessages: [], hasOlderHistory: false }),
  loadOlderHistory: () => Promise.resolve("exhausted"),
  loadOlderTimeline: () => Promise.resolve(),
};

const STORY_API = createMockORPCClient();

const meta = {
  title: "Features/RightSidebar/TimelinePanel",
  component: TimelinePanelView,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <ThemeProvider forcedTheme="dark">
        <APIContext.Provider
          value={{
            status: "connected",
            api: STORY_API,
            error: null,
            authenticate: () => undefined,
            retry: () => undefined,
          }}
        >
          <div className="bg-background text-foreground border-border h-[760px] w-full max-w-[430px] overflow-hidden rounded-xl border">
            <Story />
          </div>
        </APIContext.Provider>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof TimelinePanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

const populatedTimeline = {
  events: MIXED_EVENTS,
  nextCursor: null,
  hasOlder: false,
  initialized: true,
  loadingOlder: false,
  loadError: null,
};

export const Default: Story = {
  args: {
    workspaceId: WORKSPACE_ID,
    timeline: populatedTimeline,
    workspaceStore: STORY_STORE,
  },
};

export const Phone390: Story = {
  args: {
    workspaceId: `${WORKSPACE_ID}-phone`,
    timeline: populatedTimeline,
    workspaceStore: STORY_STORE,
  },
  globals: {
    viewport: { value: "mobile1", isRotated: false },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 390, height: 760, overflow: "hidden" }}>
        <Story />
      </div>
    ),
  ],
  parameters: {
    pixel: {
      matrix: { viewports: ["phone"] },
    },
  },
};

export const Empty: Story = {
  args: {
    workspaceId: `${WORKSPACE_ID}-empty`,
    timeline: {
      events: [],
      nextCursor: null,
      hasOlder: false,
      initialized: true,
      loadingOlder: false,
      loadError: null,
    },
    workspaceStore: STORY_STORE,
  },
};
