import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { AgentListItem } from "@/browser/components/AgentListItem/AgentListItem";
import { APIProvider } from "@/browser/contexts/API";
import { TelemetryEnabledProvider } from "@/browser/contexts/TelemetryEnabledContext";
import { TitleEditProvider } from "@/browser/contexts/WorkspaceTitleEditContext";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { expect, screen, waitFor, userEvent, within } from "@storybook/test";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { NOW, createWorkspace } from "@/browser/stories/mockFactory";
import { useWorkspaceStoreRaw, workspaceStore } from "@/browser/stores/WorkspaceStore";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import {
  GIT_STATUS_INDICATOR_MODE_KEY,
  LEFT_SIDEBAR_COLLAPSED_KEY,
  getStatusStateKey,
  getWorkspaceLastReadKey,
} from "@/common/constants/storage";
import type { AgentRowRenderMeta } from "@/browser/utils/ui/workspaceFiltering";

const meta: Meta<typeof AgentListItem> = {
  title: "Components/AgentListItem",
  component: AgentListItem,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const PROJECT_PATH = "/home/user/projects/workspace-item-states";
const PROJECT_NAME = "workspace-item-states";
const STORY_WORKSPACES = [
  createWorkspace({
    id: "ws-selected",
    name: "selected",
    title: "Selected agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 1_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-active",
    name: "active",
    title: "Active agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 2_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-idle",
    name: "idle",
    title: "Idle agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 3_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-error",
    name: "error",
    title: "Error state agent workflow",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 4_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-question",
    name: "question",
    title: "Agent workflow needs input",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 5_000).toISOString(),
  }),
];

function StoryScaffold(props: {
  children: ReactNode;
  activeWorkspaceId?: string;
  workspaces?: ReadonlyArray<(typeof STORY_WORKSPACES)[number]>;
  rowContainerClassName?: string;
}) {
  const api = createMockORPCClient({
    onChat: (workspaceId, emit) => {
      emit({ type: "caught-up", hasOlderHistory: false });
      if (workspaceId === "ws-active") {
        emit({
          type: "stream-start",
          workspaceId,
          messageId: "story-ws-active-stream",
          model: "mock-model",
          historySequence: 1_000,
          startTime: NOW,
        });
      }
      if (workspaceId === "ws-error") {
        emit({
          type: "stream-start",
          workspaceId,
          messageId: "story-ws-error-stream",
          model: "mock-model",
          historySequence: 1_001,
          startTime: NOW,
        });
        emit({
          type: "stream-abort",
          workspaceId,
          messageId: "story-ws-error-stream",
          abortReason: "system",
        });
      }
      if (workspaceId === "ws-question") {
        emit({
          type: "stream-start",
          workspaceId,
          messageId: "story-ws-question-stream",
          model: "mock-model",
          historySequence: 1_002,
          startTime: NOW,
        });
        emit({
          type: "tool-call-start",
          workspaceId,
          messageId: "story-ws-question-stream",
          toolCallId: "story-call-ask-1",
          toolName: "ask_user_question",
          args: {
            questions: [
              {
                id: "scope",
                prompt: "Which approach should we use?",
                options: [
                  { id: "a", label: "Approach A" },
                  { id: "b", label: "Approach B" },
                ],
              },
            ],
          },
          tokens: 5,
          timestamp: NOW,
        });
      }
    },
  });
  const workspaceStoreRaw = useWorkspaceStoreRaw();
  useEffect(() => {
    workspaceStoreRaw.setClient(api);
    return () => {
      workspaceStoreRaw.setClient(null);
    };
  }, [api, workspaceStoreRaw]);
  const workspaces = props.workspaces ?? STORY_WORKSPACES;
  for (const workspace of workspaces) {
    workspaceStore.addWorkspace(workspace);
  }
  workspaceStore.setActiveWorkspaceId(props.activeWorkspaceId ?? null);
  updatePersistedState(LEFT_SIDEBAR_COLLAPSED_KEY, false);
  updatePersistedState(GIT_STATUS_INDICATOR_MODE_KEY, "line-delta");
  updatePersistedState(getStatusStateKey("ws-selected"), {
    emoji: "🔍",
    message: "Agent text will go here like so",
  });
  updatePersistedState(getStatusStateKey("ws-active"), {
    emoji: "🔧",
    message: "Agent text will go here like so",
  });
  updatePersistedState(getStatusStateKey("ws-error"), {
    emoji: "🔧",
    message: "Build failed with error",
  });
  updatePersistedState(getStatusStateKey("ws-question"), {
    emoji: "🔍",
    message: "Agent has a question for you",
  });

  return (
    <APIProvider client={api}>
      <TelemetryEnabledProvider>
        <TitleEditProvider onUpdateTitle={() => Promise.resolve({ success: true })}>
          <TooltipProvider>
            <DndProvider backend={HTML5Backend}>
              <div className="border-border bg-surface-primary w-[360px] rounded-md border p-2">
                <div className={props.rowContainerClassName ?? "space-y-1"}>{props.children}</div>
              </div>
            </DndProvider>
          </TooltipProvider>
        </TitleEditProvider>
      </TelemetryEnabledProvider>
    </APIProvider>
  );
}

function renderFigmaStates() {
  return (
    <StoryScaffold>
      <AgentListItem
        metadata={STORY_WORKSPACES[0]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={STORY_WORKSPACES[1]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={STORY_WORKSPACES[2]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={STORY_WORKSPACES[3]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={STORY_WORKSPACES[4]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        variant="draft"
        draft={{
          draftId: "draft-state",
          draftNumber: 1,
          title: "Draft agent workflow",
          promptPreview: "",
          onOpen: () => undefined,
          onDelete: () => undefined,
        }}
        projectPath={PROJECT_PATH}
        isSelected={false}
      />
    </StoryScaffold>
  );
}

function renderSingleWorkspaceState(workspaceIndex: number, options?: { isArchiving?: boolean }) {
  const workspace = STORY_WORKSPACES[workspaceIndex];
  return (
    <StoryScaffold activeWorkspaceId={workspace.id}>
      <AgentListItem
        metadata={workspace}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={workspace.id === "ws-selected"}
        isArchiving={options?.isArchiving === true}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    </StoryScaffold>
  );
}

function renderIdleState(isUnread: boolean) {
  const workspace = STORY_WORKSPACES[2];
  const createdAtMs = Date.parse(workspace.createdAt ?? new Date(NOW).toISOString());
  // Explicitly control idle visual state for stories: unread => gray ring dot, seen => hidden dot.
  updatePersistedState(
    getWorkspaceLastReadKey(workspace.id),
    isUnread ? createdAtMs - 60_000 : createdAtMs + 60_000
  );
  return renderSingleWorkspaceState(2);
}

function renderDraftState() {
  return (
    <StoryScaffold>
      <AgentListItem
        variant="draft"
        draft={{
          draftId: "draft-state",
          draftNumber: 1,
          title: "Draft agent workflow",
          promptPreview: "",
          onOpen: () => undefined,
          onDelete: () => undefined,
        }}
        projectPath={PROJECT_PATH}
        isSelected={false}
      />
    </StoryScaffold>
  );
}

const SUB_AGENT_ROW_META_BASE = {
  depth: 1,
  rowKind: "subagent",
  connectorStartsAtParent: true,
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: false,
  visibleCompletedChildrenCount: 0,
} as const satisfies Omit<AgentRowRenderMeta, "connectorPosition">;

function createSubAgentRowRenderMeta(
  connectorPosition: AgentRowRenderMeta["connectorPosition"],
  overrides?: Partial<
    Pick<
      AgentRowRenderMeta,
      "connectorStartsAtParent" | "sharedTrunkActiveThroughRow" | "sharedTrunkActiveBelowRow"
    >
  >
): AgentRowRenderMeta {
  return {
    ...SUB_AGENT_ROW_META_BASE,
    connectorPosition,
    ...overrides,
  };
}

function renderWorkspaceWithRowMeta(options: {
  workspaceIndex: number;
  rowRenderMeta: AgentRowRenderMeta;
  isSelected?: boolean;
  completedChildrenExpanded?: boolean;
  onToggleCompletedChildren?: (workspaceId: string) => void;
  activeWorkspaceId?: string;
  metadataOverride?: Partial<(typeof STORY_WORKSPACES)[number]>;
}) {
  const workspace = {
    ...STORY_WORKSPACES[options.workspaceIndex],
    ...options.metadataOverride,
  };
  return (
    <StoryScaffold activeWorkspaceId={options.activeWorkspaceId}>
      <AgentListItem
        metadata={workspace}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={options.rowRenderMeta.depth}
        rowRenderMeta={options.rowRenderMeta}
        completedChildrenExpanded={options.completedChildrenExpanded}
        onToggleCompletedChildren={options.onToggleCompletedChildren}
        isSelected={options.isSelected ?? false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    </StoryScaffold>
  );
}

const NESTED_CONNECTOR_WORKSPACES = [
  createWorkspace({
    id: "ws-nested-parent",
    name: "nested-parent",
    title: "Nested Parent",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 6_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-nested-child-a",
    name: "nested-child-a",
    title: "Child A",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 7_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-nested-gc-1",
    name: "nested-gc-1",
    title: "Grandchild 1",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 8_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-nested-gc-2",
    name: "nested-gc-2",
    title: "Grandchild 2",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 9_000).toISOString(),
  }),
  createWorkspace({
    id: "ws-nested-child-b",
    name: "nested-child-b",
    title: "Child B",
    projectName: PROJECT_NAME,
    projectPath: PROJECT_PATH,
    createdAt: new Date(NOW - 10_000).toISOString(),
  }),
];

const NESTED_CONNECTOR_PARENT_ROW_META = {
  depth: 0,
  rowKind: "primary",
  connectorPosition: "single",
  connectorStartsAtParent: false,
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: false,
  visibleCompletedChildrenCount: 0,
} as const satisfies AgentRowRenderMeta;

function renderNestedConnectorContinuityStory(ancestorTrunkActive: boolean) {
  const grandchildAncestorTrunks = [{ depth: 1, active: ancestorTrunkActive }] as const;
  const childB = ancestorTrunkActive
    ? ({ ...NESTED_CONNECTOR_WORKSPACES[4], taskStatus: "running" } as const)
    : NESTED_CONNECTOR_WORKSPACES[4];

  return (
    <StoryScaffold
      workspaces={[
        NESTED_CONNECTOR_WORKSPACES[0],
        NESTED_CONNECTOR_WORKSPACES[1],
        NESTED_CONNECTOR_WORKSPACES[2],
        NESTED_CONNECTOR_WORKSPACES[3],
        childB,
      ]}
      rowContainerClassName="space-y-0"
    >
      <AgentListItem
        metadata={NESTED_CONNECTOR_WORKSPACES[0]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={NESTED_CONNECTOR_PARENT_ROW_META.depth}
        rowRenderMeta={NESTED_CONNECTOR_PARENT_ROW_META}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={NESTED_CONNECTOR_WORKSPACES[1]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={1}
        rowRenderMeta={createSubAgentRowRenderMeta("middle")}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={NESTED_CONNECTOR_WORKSPACES[2]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={2}
        rowRenderMeta={{
          ...createSubAgentRowRenderMeta("middle"),
          depth: 2,
          ancestorTrunks: grandchildAncestorTrunks,
        }}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={NESTED_CONNECTOR_WORKSPACES[3]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={2}
        rowRenderMeta={{
          ...createSubAgentRowRenderMeta("last", {
            connectorStartsAtParent: false,
          }),
          depth: 2,
          ancestorTrunks: grandchildAncestorTrunks,
        }}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <AgentListItem
        metadata={childB}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        depth={1}
        rowRenderMeta={createSubAgentRowRenderMeta("last", {
          connectorStartsAtParent: false,
        })}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    </StoryScaffold>
  );
}

async function assertNestedConnectorContinuity(
  canvasElement: HTMLElement,
  expectedTrunkActive: "true" | "false"
) {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Nested Parent")).toBeInTheDocument();
  await expect(canvas.getByText("Child A")).toBeInTheDocument();
  await expect(canvas.getByText("Grandchild 1")).toBeInTheDocument();
  await expect(canvas.getByText("Grandchild 2")).toBeInTheDocument();
  await expect(canvas.getByText("Child B")).toBeInTheDocument();

  await waitFor(async () => {
    await expect(canvasElement.querySelectorAll('[data-testid="ancestor-trunk"]')).toHaveLength(2);
  });

  const ancestorTrunks = canvasElement.querySelectorAll<HTMLElement>(
    '[data-testid="ancestor-trunk"]'
  );
  for (const trunk of ancestorTrunks) {
    await expect(trunk).toHaveAttribute("data-trunk-active", expectedTrunkActive);
    await expect(trunk.style.left).toBe("20px");
  }
}

export const FigmaStates: Story = {
  args: undefined as never,
  render: renderFigmaStates,
};

export const Selected: Story = {
  args: undefined as never,
  render: () => renderSingleWorkspaceState(0),
};

export const Active: Story = {
  args: undefined as never,
  render: () => renderSingleWorkspaceState(1),
};

export const IdleSeen: Story = {
  args: undefined as never,
  render: () => renderIdleState(false),
};

export const IdleNotSeen: Story = {
  args: undefined as never,
  render: () => renderIdleState(true),
};

export const ErrorState: Story = {
  args: undefined as never,
  render: () => renderSingleWorkspaceState(3),
};

export const Archiving: Story = {
  args: undefined as never,
  render: () => renderSingleWorkspaceState(3, { isArchiving: true }),
};

export const Question: Story = {
  args: undefined as never,
  render: () => renderSingleWorkspaceState(4),
};

export const Draft: Story = {
  args: undefined as never,
  render: renderDraftState,
};

const PRIMARY_ROW_META_WITH_HIDDEN_COMPLETED_CHILDREN = {
  depth: 0,
  rowKind: "primary",
  connectorPosition: "single",
  connectorStartsAtParent: false,
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: true,
  visibleCompletedChildrenCount: 0,
} as const satisfies AgentRowRenderMeta;

const noopToggleCompletedChildren = () => undefined;

export const SubAgentMiddle: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Middle",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: createSubAgentRowRenderMeta("middle"),
    }),
};

export const SubAgentRunning: Story = {
  args: undefined as never,
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: createSubAgentRowRenderMeta("middle", {
        connectorStartsAtParent: true,
        sharedTrunkActiveThroughRow: true,
        sharedTrunkActiveBelowRow: true,
      }),
      metadataOverride: {
        taskStatus: "running",
      },
    }),
};

export const SubAgentLast: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Last",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: createSubAgentRowRenderMeta("last"),
    }),
};

export const SubAgentSingle: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Single",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: createSubAgentRowRenderMeta("single"),
    }),
};

export const SubAgentMiddleSelected: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Middle Selected",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: createSubAgentRowRenderMeta("middle"),
      isSelected: true,
    }),
};

export const SubAgentWithStatusText: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent With Status Text",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 1,
      rowRenderMeta: createSubAgentRowRenderMeta("middle"),
      activeWorkspaceId: "ws-active",
    }),
};

export const SubAgentMiddleSelectedWithStatusText: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Middle Selected With Status Text",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 1,
      rowRenderMeta: createSubAgentRowRenderMeta("middle"),
      isSelected: true,
      activeWorkspaceId: "ws-active",
    }),
};

export const SubAgentLastWithStatusText: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Last With Status Text",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 1,
      rowRenderMeta: createSubAgentRowRenderMeta("last"),
      activeWorkspaceId: "ws-active",
    }),
};

export const SubAgentLastSelected: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Last Selected",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: createSubAgentRowRenderMeta("last"),
      isSelected: true,
    }),
};

export const SubAgentLastSelectedWithStatusText: Story = {
  args: undefined as never,
  name: "SubAgent States/SubAgent Last Selected With Status Text",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 1,
      rowRenderMeta: createSubAgentRowRenderMeta("last"),
      isSelected: true,
      activeWorkspaceId: "ws-active",
    }),
};

export const NestedConnectorContinuity: Story = {
  args: undefined as never,
  name: "SubAgent States/Nested Connector Continuity",
  render: () => renderNestedConnectorContinuityStory(false),
  play: async ({ canvasElement }) => {
    await assertNestedConnectorContinuity(canvasElement, "false");
  },
};

export const NestedConnectorContinuityActiveAncestor: Story = {
  args: undefined as never,
  name: "SubAgent States/Nested Connector Continuity Active Ancestor",
  render: () => renderNestedConnectorContinuityStory(true),
  play: async ({ canvasElement }) => {
    await assertNestedConnectorContinuity(canvasElement, "true");
  },
};
export const ParentWithCompletedChildrenCollapsed: Story = {
  args: undefined as never,
  name: "SubAgent States/Parent With Completed Children Collapsed",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: PRIMARY_ROW_META_WITH_HIDDEN_COMPLETED_CHILDREN,
      completedChildrenExpanded: false,
      onToggleCompletedChildren: noopToggleCompletedChildren,
    }),
};

export const ParentWithCompletedChildrenExpanded: Story = {
  args: undefined as never,
  name: "SubAgent States/Parent With Completed Children Expanded",
  render: () =>
    renderWorkspaceWithRowMeta({
      workspaceIndex: 2,
      rowRenderMeta: PRIMARY_ROW_META_WITH_HIDDEN_COMPLETED_CHILDREN,
      completedChildrenExpanded: true,
      onToggleCompletedChildren: noopToggleCompletedChildren,
    }),
};
export const ClickKebabButton: Story = {
  args: undefined as never,
  render: () => renderSingleWorkspaceState(1),
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-active"]');
      if (!row) throw new Error("ws-active row not found");
    });

    const row = canvasElement.querySelector<HTMLElement>('[data-workspace-id="ws-active"]')!;
    await userEvent.hover(row);

    const kebabButton = row.querySelector<HTMLButtonElement>(
      'button[aria-label^="Workspace actions for"]'
    );
    if (!kebabButton) {
      throw new Error("workspace kebab button not found");
    }

    await userEvent.click(kebabButton);
    await screen.findByText("Generate new title");
  },
};
