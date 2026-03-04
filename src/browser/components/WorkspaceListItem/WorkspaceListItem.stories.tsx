import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { WorkspaceListItem } from "@/browser/components/WorkspaceListItem/WorkspaceListItem";
import { APIProvider } from "@/browser/contexts/API";
import { TelemetryEnabledProvider } from "@/browser/contexts/TelemetryEnabledContext";
import { TitleEditProvider } from "@/browser/contexts/WorkspaceTitleEditContext";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { screen, waitFor, userEvent } from "@storybook/test";
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

const meta: Meta<typeof WorkspaceListItem> = {
  title: "Components/WorkspaceListItem",
  component: WorkspaceListItem,
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

function StoryScaffold(props: { children: ReactNode; activeWorkspaceId?: string }) {
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
  for (const workspace of STORY_WORKSPACES) {
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
                <div className="space-y-1">{props.children}</div>
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
      <WorkspaceListItem
        metadata={STORY_WORKSPACES[0]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <WorkspaceListItem
        metadata={STORY_WORKSPACES[1]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <WorkspaceListItem
        metadata={STORY_WORKSPACES[2]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <WorkspaceListItem
        metadata={STORY_WORKSPACES[3]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <WorkspaceListItem
        metadata={STORY_WORKSPACES[4]}
        projectPath={PROJECT_PATH}
        projectName={PROJECT_NAME}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
      <WorkspaceListItem
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
      <WorkspaceListItem
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
      <WorkspaceListItem
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
