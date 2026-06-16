import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { installDom } from "../../../../tests/ui/dom";
import type * as ReactDndModuleType from "react-dnd";
import type * as ReactDndHtml5BackendModuleType from "react-dnd-html5-backend";
import type * as APIModuleType from "@/browser/contexts/API";
import type * as ProjectContextModuleType from "@/browser/contexts/ProjectContext";
import type * as WorkspaceTitleEditContextModuleType from "@/browser/contexts/WorkspaceTitleEditContext";
import type * as ContextMenuPositionModuleType from "@/browser/hooks/useContextMenuPosition";
import type * as ExperimentsModuleType from "@/browser/hooks/useExperiments";
import type * as WorkspaceFallbackModelModuleType from "@/browser/hooks/useWorkspaceFallbackModel";
import type * as WorkspaceUnreadModule from "@/browser/hooks/useWorkspaceUnread";
import type * as RuntimeStatusStoreModuleType from "@/browser/stores/RuntimeStatusStore";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as TooltipModule from "../Tooltip/Tooltip";
import * as WorkspaceStatusIndicatorModule from "../WorkspaceStatusIndicator/WorkspaceStatusIndicator";
import type {
  AgentRowRenderMeta,
  WorkspaceDelegatedActivity,
} from "@/browser/utils/ui/workspaceFiltering";
import type { StreamAbortReasonSnapshot } from "@/common/types/stream";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { WorkspaceSelection } from "./AgentListItem";
import type { AgentListItem as AgentListItemComponent } from "./AgentListItem";

let AgentListItem!: typeof AgentListItemComponent;

const TEST_WORKSPACE_ID = "workspace-archiving";
const TEST_WORKSPACE_TITLE = "Archiving Workspace";
const HEARTBEAT_INTERVAL_MS = 60_000;
const SUBAGENT_ROW_META: AgentRowRenderMeta = {
  depth: 1,
  rowKind: "subagent",
  connectorPosition: "single",
  connectorStartsAtParent: true,
  sharedTrunkActiveThroughRow: false,
  sharedTrunkActiveBelowRow: false,
  ancestorTrunks: [],
  hasHiddenCompletedChildren: false,
  visibleCompletedChildrenCount: 0,
};

type MockWorkspaceUnreadState = ReturnType<typeof WorkspaceUnreadModule.useWorkspaceUnread>;
type MockWorkspaceSidebarState = ReturnType<typeof WorkspaceStoreModule.useWorkspaceSidebarState>;

let mockWorkspaceHeartbeatsEnabled = false;
let mockWorkspaceUnreadState: MockWorkspaceUnreadState;
let mockWorkspaceSidebarState: MockWorkspaceSidebarState;

function createWorkspaceUnreadState(
  overrides: Partial<MockWorkspaceUnreadState> = {}
): MockWorkspaceUnreadState {
  return {
    isUnread: false,
    lastReadTimestamp: null,
    recencyTimestamp: null,
    ...overrides,
  };
}

function createWorkspaceSidebarState(
  overrides: Partial<MockWorkspaceSidebarState> = {}
): MockWorkspaceSidebarState {
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

function createMetadata(
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id: TEST_WORKSPACE_ID,
    name: "archiving-workspace",
    title: TEST_WORKSPACE_TITLE,
    projectName: "Project",
    projectPath: "/tmp/project",
    namedWorkspacePath: "/tmp/project/archiving-workspace",
    runtimeConfig: { type: "local" },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createSystemAbortReason(): StreamAbortReasonSnapshot {
  return {
    reason: "system",
    at: Date.now(),
  };
}

function createHeartbeatMetadata(overrides: Partial<FrontendWorkspaceMetadata["heartbeat"]> = {}) {
  return createMetadata({
    heartbeat: { enabled: true, intervalMs: HEARTBEAT_INTERVAL_MS, ...overrides },
  });
}

function installAgentListItemTestDoubles() {
  const passthroughRef = <T,>(value: T): T => value;

  spyOn(TooltipModule, "Tooltip").mockImplementation(((props: { children: ReactNode }) => (
    <>{props.children}</>
  )) as unknown as typeof TooltipModule.Tooltip);
  spyOn(TooltipModule, "TooltipTrigger").mockImplementation(((props: { children: ReactNode }) => (
    <>{props.children}</>
  )) as unknown as typeof TooltipModule.TooltipTrigger);
  spyOn(TooltipModule, "TooltipContent").mockImplementation(((props: { children: ReactNode }) => (
    <>{props.children}</>
  )) as unknown as typeof TooltipModule.TooltipContent);
  spyOn(WorkspaceStatusIndicatorModule, "WorkspaceStatusIndicator").mockImplementation(((props: {
    workspaceId: string;
  }) => (
    <div data-testid={`workspace-status-indicator-${props.workspaceId}`} />
  )) as unknown as typeof WorkspaceStatusIndicatorModule.WorkspaceStatusIndicator);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const actualReactDnd = require("react-dnd?real=1") as typeof ReactDndModuleType;
  const actualReactDndHtml5Backend =
    require("react-dnd-html5-backend?real=1") as typeof ReactDndHtml5BackendModuleType;
  const actualApi = require("@/browser/contexts/API?real=1") as typeof APIModuleType;
  const actualProjectContext =
    require("@/browser/contexts/ProjectContext?real=1") as typeof ProjectContextModuleType;
  const actualWorkspaceTitleEditContext =
    require("@/browser/contexts/WorkspaceTitleEditContext?real=1") as typeof WorkspaceTitleEditContextModuleType;
  const actualContextMenuPosition =
    require("@/browser/hooks/useContextMenuPosition?real=1") as typeof ContextMenuPositionModuleType;
  const actualExperiments =
    require("@/browser/hooks/useExperiments?real=1") as typeof ExperimentsModuleType;
  const actualWorkspaceUnread =
    require("@/browser/hooks/useWorkspaceUnread?real=1") as typeof WorkspaceUnreadModule;
  const actualRuntimeStatusStore =
    require("@/browser/stores/RuntimeStatusStore?real=1") as typeof RuntimeStatusStoreModuleType;
  const actualWorkspaceFallbackModel =
    require("@/browser/hooks/useWorkspaceFallbackModel?real=1") as typeof WorkspaceFallbackModelModuleType;
  const actualWorkspaceStore =
    require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */

  void mock.module("react-dnd", () => ({
    ...actualReactDnd,
    useDrag: () => [{ isDragging: false }, passthroughRef, () => undefined] as const,
  }));

  void mock.module("react-dnd-html5-backend", () => ({
    ...actualReactDndHtml5Backend,
    getEmptyImage: () => new Image(),
  }));

  void mock.module("@/browser/contexts/API", () => ({
    ...actualApi,
    useAPI: () => ({
      api: null,
      status: "error" as const,
      error: "API unavailable",
      authenticate: () => undefined,
      retry: () => undefined,
    }),
  }));

  void mock.module("@/browser/contexts/ProjectContext", () => ({
    ...actualProjectContext,
    useProjectContext: () => ({
      getProjectConfig: () => undefined,
      userProjects: new Map(),
    }),
  }));

  void mock.module("@/browser/contexts/WorkspaceTitleEditContext", () => ({
    ...actualWorkspaceTitleEditContext,
    useTitleEdit: () => ({
      editingWorkspaceId: null,
      requestEdit: () => true,
      confirmEdit: () => Promise.resolve({ success: true }),
      cancelEdit: () => undefined,
      generatingTitleWorkspaceIds: new Set<string>(),
      wrapGenerateTitle: () => undefined,
    }),
  }));

  void mock.module("../WorkspaceHeartbeatModal", () => ({
    WorkspaceHeartbeatModal: () => null,
  }));

  void mock.module("../AutomationModal", () => ({
    AutomationModal: () => null,
  }));

  void mock.module("@/browser/hooks/useContextMenuPosition", () => ({
    ...actualContextMenuPosition,
    useContextMenuPosition: () => ({
      position: null,
      isOpen: false,
      onContextMenu: () => undefined,
      onOpenChange: () => undefined,
      touchHandlers: {
        onTouchStart: () => undefined,
        onTouchEnd: () => undefined,
        onTouchMove: () => undefined,
      },
      suppressClickIfLongPress: () => false,
      close: () => undefined,
    }),
  }));

  void mock.module("@/browser/hooks/useExperiments", () => ({
    ...actualExperiments,
    useExperimentValue: () => mockWorkspaceHeartbeatsEnabled,
  }));

  void mock.module("@/browser/hooks/useWorkspaceUnread", () => ({
    ...actualWorkspaceUnread,
    useWorkspaceUnread: () => mockWorkspaceUnreadState,
  }));

  void mock.module("@/browser/stores/RuntimeStatusStore", () => ({
    ...actualRuntimeStatusStore,
    useRuntimeStatus: () => null,
  }));

  void mock.module("@/browser/hooks/useWorkspaceFallbackModel", () => ({
    ...actualWorkspaceFallbackModel,
    useWorkspaceFallbackModel: () => "claude-sonnet-4-5",
  }));

  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    ...actualWorkspaceStore,
    useWorkspaceSidebarState: () => mockWorkspaceSidebarState,
  }));
}

function renderWorkspaceItem(
  options: {
    metadata?: FrontendWorkspaceMetadata;
    isSelected?: boolean;
    isArchiving?: boolean;
    depth?: number;
    rowRenderMeta?: AgentRowRenderMeta;
    subAgentConnectorLayout?: "default" | "task-group-member";
    taskGroupHeaderTitle?: string;
    delegatedActivity?: WorkspaceDelegatedActivity;
    completedChildrenExpanded?: boolean;
    onToggleCompletedChildren?: (workspaceId: string) => void;
    onSelectWorkspace?: (selection: WorkspaceSelection) => void;
  } = {}
) {
  const metadata = options.metadata ?? createMetadata();
  const view = render(
    <AgentListItem
      metadata={metadata}
      projectPath={metadata.projectPath}
      projectName={metadata.projectName}
      isSelected={options.isSelected ?? false}
      isArchiving={options.isArchiving}
      depth={options.depth ?? options.rowRenderMeta?.depth}
      rowRenderMeta={options.rowRenderMeta}
      subAgentConnectorLayout={options.subAgentConnectorLayout}
      taskGroupHeaderTitle={options.taskGroupHeaderTitle}
      delegatedActivity={options.delegatedActivity}
      completedChildrenExpanded={options.completedChildrenExpanded}
      onToggleCompletedChildren={options.onToggleCompletedChildren}
      onSelectWorkspace={options.onSelectWorkspace ?? (() => undefined)}
      onForkWorkspace={() => Promise.resolve()}
      onArchiveWorkspace={() => Promise.resolve()}
      onCancelCreation={() => Promise.resolve()}
    />
  );

  return {
    metadata,
    view,
    // Lazy: D8 title suppression changes the accessible name for group-member
    // rows, so only resolve the default lookup when a test actually uses it.
    get row() {
      return view.getByRole("button", {
        name: `${options.isArchiving ? "Archiving" : "Select"} workspace ${metadata.title ?? metadata.name}`,
      });
    },
  };
}

describe("AgentListItem", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    mockWorkspaceHeartbeatsEnabled = false;
    mockWorkspaceUnreadState = createWorkspaceUnreadState();
    mockWorkspaceSidebarState = createWorkspaceSidebarState();
    installAgentListItemTestDoubles();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ AgentListItem } = require("./AgentListItem?agent-list-item-test=1") as {
      AgentListItem: typeof AgentListItemComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("suppresses group-member titles that repeat the group header (D8)", () => {
    // Variant member: label-only row keeps the variant label as the title text.
    const variant = renderWorkspaceItem({
      metadata: createMetadata({
        title: "Split review",
        parentWorkspaceId: "parent",
        bestOf: { groupId: "g1", index: 0, total: 2, kind: "variants", label: "frontend" },
      }),
      subAgentConnectorLayout: "task-group-member",
      taskGroupHeaderTitle: "Split review",
    });
    expect(variant.view.getByRole("button", { name: "Select workspace frontend" })).toBeTruthy();
    expect(variant.view.queryByText("Split review")).toBeNull();
    cleanup();

    // Best-of member: bare letters become "Candidate A" so the row stays readable.
    const candidate = renderWorkspaceItem({
      metadata: createMetadata({
        title: "Split review",
        parentWorkspaceId: "parent",
        bestOf: { groupId: "g1", index: 0, total: 2 },
      }),
      subAgentConnectorLayout: "task-group-member",
      taskGroupHeaderTitle: "Split review",
    });
    expect(
      candidate.view.getByRole("button", { name: "Select workspace Candidate A" })
    ).toBeTruthy();
    cleanup();

    // A custom (differing) title still renders alongside the label.
    const customTitle = renderWorkspaceItem({
      metadata: createMetadata({
        title: "My renamed run",
        parentWorkspaceId: "parent",
        bestOf: { groupId: "g1", index: 1, total: 2, kind: "variants", label: "backend" },
      }),
      subAgentConnectorLayout: "task-group-member",
      taskGroupHeaderTitle: "Split review",
    });
    expect(
      customTitle.view.getByRole("button", { name: "Select workspace backend · My renamed run" })
    ).toBeTruthy();
    expect(customTitle.view.getByText("My renamed run")).toBeTruthy();
  });

  test("shows active delegated workflow work on idle workspace rows", () => {
    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 2,
        queuedCount: 1,
        workflowActiveCount: 2,
        workflowQueuedCount: 1,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByText("Workflow running · 2 sub-agents active · 1 queued")).toBeTruthy();
    const descriptionId = row.getAttribute("aria-describedby");
    expect(descriptionId).toBe(`workspace-status-description-${TEST_WORKSPACE_ID}`);
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "Workflow running · 2 sub-agents active · 1 queued"
    );
    expect(rowView.queryByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("keeps coordinator streaming copy ahead of delegated workflow work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ canInterrupt: true });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 1,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeTruthy();
    expect(rowView.queryByText("Workflow running · 1 sub-agent active")).toBeNull();
  });

  test("keeps coordinator streaming copy ahead of active delegated work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ canInterrupt: true });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 0,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeTruthy();
    expect(rowView.getByTestId(`workspace-status-indicator-${TEST_WORKSPACE_ID}`)).toBeTruthy();
    expect(rowView.queryByText("1 sub-agent active")).toBeNull();
  });

  test("keeps own question status ahead of delegated workflow work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({ awaitingUserQuestion: true });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 1,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".bg-border-pending.border-surface-sky")).toBeTruthy();
    expect(rowView.getByText("Mux has a few questions")).toBeTruthy();
    expect(rowView.queryByText("Workflow running · 1 sub-agent active")).toBeNull();
  });

  test("shows queued delegated workflow work without marking the row active", () => {
    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 0,
        queuedCount: 1,
        workflowActiveCount: 0,
        workflowQueuedCount: 1,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".workspace-status-dot-active")).toBeNull();
    expect(rowView.getByText("Workflow queued · 1 sub-agent queued")).toBeTruthy();
  });

  test("keeps own system errors ahead of delegated workflow work", () => {
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      lastAbortReason: createSystemAbortReason(),
    });

    const { row } = renderWorkspaceItem({
      delegatedActivity: {
        activeCount: 1,
        queuedCount: 0,
        workflowActiveCount: 1,
        workflowQueuedCount: 0,
      },
    });
    const rowView = within(row);

    expect(row.querySelector(".bg-content-destructive.border-surface-destructive")).toBeTruthy();
    expect(rowView.queryByText("Workflow running · 1 sub-agent active")).toBeNull();
  });

  test("keeps archiving feedback inline instead of rendering a secondary status row", () => {
    const { row } = renderWorkspaceItem({ isArchiving: true });
    const rowView = within(row);

    expect(
      rowView.getByTestId(`workspace-inline-archiving-status-${TEST_WORKSPACE_ID}`)
    ).toBeTruthy();
    expect(rowView.queryByTestId(`workspace-secondary-row-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("does not render a goal target pill in the workspace row", () => {
    mockWorkspaceHeartbeatsEnabled = true;
    mockWorkspaceSidebarState = createWorkspaceSidebarState({
      goal: {
        goalId: "11111111-1111-4111-8111-111111111111",
        status: "active",
        objective: "Ship goal budgets",
        budgetCents: 500,
        costCents: 125,
        turnsUsed: 4,
        turnCap: null,
        startedAtMs: Date.now(),
      },
    });

    const { row } = renderWorkspaceItem();

    expect(within(row).queryByTestId(`workspace-goal-pill-${TEST_WORKSPACE_ID}`)).toBeNull();
  });

  test("renders a heartbeat icon directly in the leading slot for seen rows when the heartbeat experiment is enabled", () => {
    mockWorkspaceHeartbeatsEnabled = true;

    const { row } = renderWorkspaceItem({
      metadata: createHeartbeatMetadata(),
    });
    const rowView = within(row);
    const heartbeatIcon = rowView.getByTestId("heartbeat-icon");

    expect(heartbeatIcon).toBeTruthy();
    expect(heartbeatIcon.parentElement?.className).toContain(
      "relative z-20 flex shrink-0 items-center justify-center self-center"
    );
    expect(heartbeatIcon.parentElement?.getAttribute("style")).toContain("width: 16px");
    expect(heartbeatIcon.parentElement?.getAttribute("style")).toContain("height: 16px");
    expect(
      rowView.queryByRole("button", { name: `Archive workspace ${TEST_WORKSPACE_TITLE}` })
    ).toBeNull();
  });

  test.each([
    [
      "sub-agent connectors to the parent and child leading status slots",
      1,
      "default" as const,
      "18px",
      "8px",
    ],
    [
      "task-group member connectors to the task-group rail",
      2.5,
      "task-group-member" as const,
      "38px",
      "1px",
    ],
  ])("anchors %s", (_name, depth, subAgentConnectorLayout, left, width) => {
    const { view } = renderWorkspaceItem({
      depth,
      subAgentConnectorLayout,
      rowRenderMeta: SUBAGENT_ROW_META,
    });

    const topSegment = view.getByTestId("subagent-connector-top-segment");
    const elbow = view.getByTestId("subagent-connector-elbow");

    expect(topSegment.getAttribute("style")).toContain(`left: ${left}`);
    expect(elbow.getAttribute("style")).toContain(`left: ${left}`);
    expect(elbow.getAttribute("style")).toContain(`width: ${width}`);
  });

  test("does not render a heartbeat icon fallback when completed children indicator is shown", () => {
    mockWorkspaceHeartbeatsEnabled = true;

    const { row, metadata } = renderWorkspaceItem({
      metadata: createHeartbeatMetadata(),
      rowRenderMeta: {
        depth: 0,
        rowKind: "primary",
        connectorPosition: "single",
        connectorStartsAtParent: false,
        sharedTrunkActiveThroughRow: false,
        sharedTrunkActiveBelowRow: false,
        ancestorTrunks: [],
        hasHiddenCompletedChildren: false,
        visibleCompletedChildrenCount: 1,
      },
      completedChildrenExpanded: true,
      onToggleCompletedChildren: () => undefined,
    });
    const rowView = within(row);

    expect(rowView.queryByTestId("heartbeat-icon")).toBeNull();
    expect(
      rowView.getByTestId(`completed-children-expanded-indicator-${metadata.id}`)
    ).toBeTruthy();
    expect(
      rowView.queryByRole("button", { name: `Archive workspace ${TEST_WORKSPACE_TITLE}` })
    ).toBeNull();
  });

  test.each([
    ["the heartbeat experiment is disabled", false, createHeartbeatMetadata()],
    ["heartbeat is disabled", true, createHeartbeatMetadata({ enabled: false })],
    ["heartbeat settings are missing", true, createMetadata()],
  ])("does not render a heartbeat icon fallback when %s", (_name, experimentEnabled, metadata) => {
    mockWorkspaceHeartbeatsEnabled = experimentEnabled;

    const { row } = renderWorkspaceItem({ metadata });

    expect(within(row).queryByTestId("heartbeat-icon")).toBeNull();
  });

  test("keeps the unread idle status dot when heartbeat is enabled", () => {
    mockWorkspaceHeartbeatsEnabled = true;
    mockWorkspaceUnreadState = createWorkspaceUnreadState({ isUnread: true });

    const { row } = renderWorkspaceItem({
      metadata: createHeartbeatMetadata(),
    });

    expect(within(row).queryByTestId("heartbeat-icon")).toBeNull();
    expect(row.querySelector(".bg-surface-invert-secondary.border-surface-tertiary")).toBeTruthy();
  });

  test("keeps the secondary status row mounted through a quick create-to-stream handoff", () => {
    const metadata = createMetadata({ isInitializing: true });
    const renderItem = () => (
      <AgentListItem
        metadata={metadata}
        projectPath={metadata.projectPath}
        projectName={metadata.projectName}
        isSelected={false}
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    );
    const view = render(renderItem());
    const getRow = () =>
      view.container.querySelector<HTMLElement>(
        `[data-workspace-id="${metadata.id}"][role="button"]`
      );
    const getSecondaryRow = () => view.queryByTestId(`workspace-secondary-row-${metadata.id}`);

    const assertRowStaysActive = () => {
      expect(getSecondaryRow()).toBeTruthy();
      const row = getRow();
      expect(row).toBeTruthy();
      expect(row?.querySelector(".workspace-status-dot-active")).toBeTruthy();
    };

    assertRowStaysActive();

    metadata.isInitializing = false;
    mockWorkspaceSidebarState = createWorkspaceSidebarState();
    view.rerender(renderItem());

    assertRowStaysActive();

    mockWorkspaceSidebarState = createWorkspaceSidebarState({ canInterrupt: true });
    view.rerender(renderItem());

    assertRowStaysActive();
  });

  test.each([
    {
      name: "active rows",
      sidebarState: createWorkspaceSidebarState({ canInterrupt: true }),
      expectedSelector: ".workspace-status-dot-active",
      expectedText: null,
    },
    {
      name: "starting rows",
      sidebarState: createWorkspaceSidebarState({ isStarting: true }),
      expectedSelector: ".workspace-status-dot-active",
      expectedText: null,
    },
    {
      name: "question rows",
      sidebarState: createWorkspaceSidebarState({ awaitingUserQuestion: true }),
      expectedSelector: ".bg-border-pending.border-surface-sky",
      expectedText: "Mux has a few questions",
    },
    {
      name: "error rows",
      sidebarState: createWorkspaceSidebarState({ lastAbortReason: createSystemAbortReason() }),
      expectedSelector: ".bg-content-destructive.border-surface-destructive",
      expectedText: null,
    },
  ])(
    "leaves $name unchanged when heartbeat is enabled",
    ({ sidebarState, expectedSelector, expectedText }) => {
      mockWorkspaceHeartbeatsEnabled = true;
      mockWorkspaceSidebarState = sidebarState;

      const { row } = renderWorkspaceItem({
        metadata: createMetadata({
          heartbeat: { enabled: true, intervalMs: HEARTBEAT_INTERVAL_MS },
        }),
      });

      expect(within(row).queryByTestId("heartbeat-icon")).toBeNull();
      expect(row.querySelector(expectedSelector)).toBeTruthy();
      if (expectedText) {
        expect(within(row).getByText(expectedText)).toBeTruthy();
      }
    }
  );
});
