import "../../../../tests/ui/dom";

import React, { type ComponentProps, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import * as ReactDndModule from "react-dnd";
import * as ReactDndHtml5BackendModule from "react-dnd-html5-backend";
import * as ReactColorfulModule from "react-colorful";
import { installDom } from "../../../../tests/ui/dom";
import { EXPANDED_PROJECTS_KEY } from "@/common/constants/storage";
import { getDraftScopeId, getInputKey } from "@/common/constants/storage";
import { MULTI_PROJECT_SIDEBAR_SECTION_ID } from "@/common/constants/multiProject";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { AgentRowRenderMeta } from "@/browser/utils/ui/workspaceFiltering";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import * as DesktopTitlebarModule from "@/browser/hooks/useDesktopTitlebar";
import * as ThemeContextModule from "@/browser/contexts/ThemeContext";
import * as APIModule from "@/browser/contexts/API";
import * as ConfirmDialogContextModule from "@/browser/contexts/ConfirmDialogContext";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as RouterContextModule from "@/browser/contexts/RouterContext";
import * as SettingsContextModule from "@/browser/contexts/SettingsContext";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as WorkspaceFallbackModelModule from "@/browser/hooks/useWorkspaceFallbackModel";
import * as WorkspaceUnreadModule from "@/browser/hooks/useWorkspaceUnread";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as ExperimentsModule from "@/browser/hooks/useExperiments";
import * as PopoverErrorHookModule from "@/browser/hooks/usePopoverError";
import * as TooltipModule from "../Tooltip/Tooltip";
import * as SidebarCollapseButtonModule from "../SidebarCollapseButton/SidebarCollapseButton";
import * as ConfirmationModalModule from "../ConfirmationModal/ConfirmationModal";
import * as ProjectDeleteConfirmationModalModule from "../ProjectDeleteConfirmationModal/ProjectDeleteConfirmationModal";
import * as WorkspaceStatusIndicatorModule from "../WorkspaceStatusIndicator/WorkspaceStatusIndicator";
import * as PopoverErrorModule from "../PopoverError/PopoverError";
import * as SectionHeaderModule from "../SectionHeader/SectionHeader";
import * as WorkspaceSectionDropZoneModule from "../WorkspaceSectionDropZone/WorkspaceSectionDropZone";
import * as WorkspaceDragLayerModule from "../WorkspaceDragLayer/WorkspaceDragLayer";
import * as SectionDragLayerModule from "../SectionDragLayer/SectionDragLayer";
import * as DraggableSectionModule from "../DraggableSection/DraggableSection";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type ProjectSidebarComponent from "./ProjectSidebar";

const agentItemTestId = (workspaceId: string) => `agent-item-${workspaceId}`;
const toggleButtonLabel = (workspaceId: string) => `toggle-completed-${workspaceId}`;

function TestWrapper(props: PropsWithChildren) {
  return <>{props.children}</>;
}

const passthroughRef = <T,>(value: T): T => value;

function resolveVoidResult() {
  return Promise.resolve({ success: true as const, data: undefined });
}

function resolveArchiveResult(
  result: { kind: "archived" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "archived",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

function resolveArchivePreflight(
  result: { kind: "ready" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "ready",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

type ArchiveConfirmationResult =
  | { kind: "archived" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
type ArchivePreflightConfirmationResult =
  | { kind: "ready" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
interface ArchiveWorkspaceActionResult {
  success: boolean;
  error?: string;
  data?: ArchiveConfirmationResult;
}
interface ArchivePreflightActionResult {
  success: boolean;
  error?: string;
  data?: ArchivePreflightConfirmationResult;
}

interface MockAgentListItemProps {
  metadata?: FrontendWorkspaceMetadata;
  draft?: {
    draftId: string;
    title?: string;
  };
  depth?: number;
  rowRenderMeta?: AgentRowRenderMeta;
  completedChildrenExpanded?: boolean;
  onToggleCompletedChildren?: (workspaceId: string) => void;
  onArchiveWorkspace?: (workspaceId: string, button: HTMLElement) => Promise<void>;
}

type HexColorPickerProps = ComponentProps<typeof ReactColorfulModule.HexColorPicker>;

let latestArchiveWorkspaceHandler:
  | ((workspaceId: string, button: HTMLElement) => Promise<void>)
  | null = null;

let ProjectSidebar!: typeof ProjectSidebarComponent;
let latestArchiveConfirmationModalProps: {
  isOpen: boolean;
  title: string;
  description?: string;
  warning?: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
} | null = null;
let preflightArchiveWorkspaceMock = mock(
  (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
);
let archiveWorkspaceActionMock = mock(
  (
    _workspaceId: string,
    _options?: { acknowledgedUntrackedPaths?: string[] }
  ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
);
let settingsOpenMock = mock(() => undefined);
let confirmDialogMock = mock(() => Promise.resolve(true));
let archivePopoverShowErrorMock = mock(
  (_workspaceId: string, _error: string, _anchor?: { top: number; left: number }) => undefined
);

function createProjectContextValue(
  overrides: Partial<ProjectContextModule.ProjectContext> = {}
): ProjectContextModule.ProjectContext {
  return {
    userProjects: new Map(),
    systemProjectPath: null,
    resolveProjectPath: () => null,
    getProjectConfig: () => undefined,
    loading: false,
    refreshProjects: () => Promise.resolve(),
    addProject: () => undefined,
    removeProject: () => Promise.resolve({ success: true }),
    isProjectCreateModalOpen: false,
    openProjectCreateModal: () => undefined,
    closeProjectCreateModal: () => undefined,
    workspaceModalState: {
      isOpen: false,
      projectPath: null,
      projectName: "",
      branches: [],
      defaultTrunkBranch: undefined,
      loadErrorMessage: null,
      isLoading: false,
    },
    openWorkspaceModal: () => Promise.resolve(),
    closeWorkspaceModal: () => undefined,
    getBranchesForProject: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
    getSecrets: () => Promise.resolve([]),
    updateSecrets: () => Promise.resolve(),
    updateDisplayName: () => resolveVoidResult(),
    updateColor: () => resolveVoidResult(),
    createSection: () =>
      Promise.resolve({ success: true, data: { id: "section-1", name: "Section" } }),
    updateSection: () => resolveVoidResult(),
    removeSection: () => resolveVoidResult(),
    reorderSections: () => resolveVoidResult(),
    assignWorkspaceToSection: () => resolveVoidResult(),
    hasAnyProject: false,
    resolveNewChatProjectPath: () => null,
    ...overrides,
  };
}

let projectContextValue = createProjectContextValue();

function installProjectSidebarTestDoubles() {
  archivePopoverShowErrorMock = mock(
    (_workspaceId: string, _error: string, _anchor?: { top: number; left: number }) => undefined
  );
  preflightArchiveWorkspaceMock = mock(
    (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
  );
  archiveWorkspaceActionMock = mock(
    (
      _workspaceId: string,
      _options?: { acknowledgedUntrackedPaths?: string[] }
    ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
  );
  confirmDialogMock = mock(() => Promise.resolve(true));
  latestArchiveWorkspaceHandler = null;
  latestArchiveConfirmationModalProps = null;
  void mock.module("@/browser/assets/logos/mux-logo-dark.svg?react", () => ({
    __esModule: true,
    default: () => <svg data-testid="mux-logo-dark" />,
  }));
  void mock.module("@/browser/assets/logos/mux-logo-light.svg?react", () => ({
    __esModule: true,
    default: () => <svg data-testid="mux-logo-light" />,
  }));
  void mock.module("../AgentListItem/AgentListItem", () => ({
    AgentListItem: (props: MockAgentListItemProps) => {
      if (props.draft) {
        return (
          <div data-testid={`draft-item-${props.draft.draftId}`}>
            {props.draft.title ?? "Draft"}
          </div>
        );
      }

      if (!props.metadata) {
        return null;
      }
      const metadata = props.metadata;

      const hasCompletedChildren =
        (props.rowRenderMeta?.hasHiddenCompletedChildren ?? false) ||
        (props.rowRenderMeta?.visibleCompletedChildrenCount ?? 0) > 0;

      const displayTitle =
        metadata.bestOf?.kind === "variants" && metadata.bestOf.label
          ? `${metadata.bestOf.label} · ${metadata.title ?? metadata.name}`
          : (metadata.title ?? metadata.name);

      latestArchiveWorkspaceHandler = props.onArchiveWorkspace ?? null;

      return (
        <div
          data-testid={agentItemTestId(metadata.id)}
          data-depth={String(props.depth ?? -1)}
          data-row-kind={props.rowRenderMeta?.rowKind ?? "unknown"}
          data-completed-expanded={String(props.completedChildrenExpanded ?? false)}
        >
          <span>{displayTitle}</span>
          {hasCompletedChildren && props.onToggleCompletedChildren ? (
            <button
              type="button"
              aria-label={toggleButtonLabel(metadata.id)}
              onClick={() => props.onToggleCompletedChildren?.(metadata.id)}
            >
              Toggle completed children
            </button>
          ) : null}
          {props.onArchiveWorkspace ? (
            <button
              type="button"
              aria-label={`archive-${metadata.id}`}
              onClick={(event) => {
                void props.onArchiveWorkspace?.(metadata.id, event.currentTarget);
              }}
            >
              Archive workspace
            </button>
          ) : null}
        </div>
      );
    },
  }));
  void mock.module("@/browser/hooks/useContextMenuPosition", () => ({
    useContextMenuPosition: () => {
      const [isOpen, setIsOpen] = React.useState(false);
      const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);

      return {
        position,
        isOpen,
        onContextMenu: (event: {
          preventDefault?: () => void;
          stopPropagation?: () => void;
          clientX?: number;
          clientY?: number;
        }) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          setPosition({ x: event.clientX ?? 0, y: event.clientY ?? 0 });
          setIsOpen(true);
        },
        onOpenChange: (open: boolean) => {
          setIsOpen(open);
        },
        touchHandlers: {
          onTouchStart: () => undefined,
          onTouchEnd: () => undefined,
          onTouchMove: () => undefined,
        },
        suppressClickIfLongPress: () => false,
        close: () => {
          setIsOpen(false);
        },
      };
    },
  }));
  const fallbackPopoverError = {
    error: null,
    showError: mock(() => undefined),
    clearError: mock(() => undefined),
  };
  const popoverErrors = [
    {
      error: null,
      showError: archivePopoverShowErrorMock,
      clearError: mock(() => undefined),
    },
    fallbackPopoverError,
    fallbackPopoverError,
    fallbackPopoverError,
    fallbackPopoverError,
    fallbackPopoverError,
  ];
  let popoverErrorIndex = 0;
  spyOn(PopoverErrorHookModule, "usePopoverError").mockImplementation(
    () => popoverErrors[popoverErrorIndex++] ?? fallbackPopoverError
  );
  spyOn(ReactDndModule, "DndProvider").mockImplementation(
    TestWrapper as unknown as typeof ReactDndModule.DndProvider
  );
  spyOn(ReactDndModule, "useDrag").mockImplementation(
    (() =>
      [
        { isDragging: false },
        passthroughRef,
        () => undefined,
      ] as const) as unknown as typeof ReactDndModule.useDrag
  );
  spyOn(ReactDndModule, "useDrop").mockImplementation(
    (() => [{ isOver: false }, passthroughRef] as const) as unknown as typeof ReactDndModule.useDrop
  );
  spyOn(ReactDndModule, "useDragLayer").mockImplementation((() => ({
    isDragging: false,
    item: null,
    currentOffset: null,
  })) as unknown as typeof ReactDndModule.useDragLayer);
  spyOn(ReactDndHtml5BackendModule, "getEmptyImage").mockImplementation(() => new Image());
  spyOn(ReactColorfulModule, "HexColorPicker").mockImplementation(((props: HexColorPickerProps) => (
    <button
      type="button"
      data-testid="hex-color-picker"
      onClick={() => {
        props.onChange?.("#123456");
      }}
    >
      mock color picker
    </button>
  )) as typeof ReactColorfulModule.HexColorPicker);

  spyOn(DesktopTitlebarModule, "isDesktopMode").mockImplementation(() => false);
  spyOn(ThemeContextModule, "useTheme").mockImplementation(() => ({
    theme: "light",
    themePreference: "light",
    setTheme: () => undefined,
    toggleTheme: () => undefined,
    isForced: false,
  }));
  spyOn(APIModule, "useAPI").mockImplementation(() => ({
    api: null,
    status: "error",
    error: "API unavailable",
    authenticate: () => undefined,
    retry: () => undefined,
  }));
  spyOn(ConfirmDialogContextModule, "useConfirmDialog").mockImplementation(() => ({
    confirm: confirmDialogMock,
  }));
  spyOn(ProjectContextModule, "useProjectContext").mockImplementation(() => projectContextValue);
  spyOn(RouterContextModule, "useRouter").mockImplementation(() => ({
    navigateToWorkspace: () => undefined,
    navigateToProject: () => undefined,
    navigateToHome: () => undefined,
    navigateToSettings: () => undefined,
    navigateFromSettings: () => undefined,
    navigateToAnalytics: () => undefined,
    navigateFromAnalytics: () => undefined,
    currentWorkspaceId: null,
    currentSettingsSection: null,
    currentProjectId: null,
    currentProjectPathFromState: null,
    pendingSectionId: null,
    pendingDraftId: null,
    isAnalyticsOpen: false,
  }));
  spyOn(SettingsContextModule, "useSettings").mockImplementation(() => ({
    isOpen: false,
    activeSection: "general",
    open: settingsOpenMock,
    close: () => undefined,
    setActiveSection: () => undefined,
    registerOnClose: () => () => undefined,
    providersExpandedProvider: null,
    setProvidersExpandedProvider: () => undefined,
    runtimesProjectPath: null,
    setRuntimesProjectPath: () => undefined,
    secretsProjectPath: null,
    setSecretsProjectPath: () => undefined,
  }));
  spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
    () =>
      ({
        selectedWorkspace: null,
        setSelectedWorkspace: () => undefined,
        preflightArchiveWorkspace: preflightArchiveWorkspaceMock,
        archiveWorkspace: archiveWorkspaceActionMock,
        removeWorkspace: () => Promise.resolve({ success: true }),
        updateWorkspaceTitle: () => Promise.resolve({ success: true }),
        refreshWorkspaceMetadata: () => Promise.resolve(),
        pendingNewWorkspaceProject: null,
        pendingNewWorkspaceDraftId: null,
        workspaceDraftsByProject: {},
        workspaceDraftPromotionsByProject: {},
        createWorkspaceDraft: () => undefined,
        openWorkspaceDraft: () => undefined,
        deleteWorkspaceDraft: () => undefined,
      }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
  );
  spyOn(WorkspaceFallbackModelModule, "useWorkspaceFallbackModel").mockImplementation(
    () => "openai:gpt-5.4"
  );
  spyOn(WorkspaceUnreadModule, "useWorkspaceUnread").mockImplementation(() => ({
    isUnread: false,
    lastReadTimestamp: null,
    recencyTimestamp: null,
  }));
  spyOn(WorkspaceStoreModule, "useWorkspaceStoreRaw").mockImplementation(
    () =>
      ({
        getWorkspaceMetadata: () => undefined,
        getAggregator: () => undefined,
        subscribeKey: () => () => undefined,
      }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceStoreRaw>
  );

  spyOn(ExperimentsModule, "useExperimentValue").mockImplementation(() => true);

  spyOn(TooltipModule, "Tooltip").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.Tooltip
  );
  spyOn(TooltipModule, "TooltipTrigger").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.TooltipTrigger
  );
  spyOn(TooltipModule, "TooltipContent").mockImplementation(
    (() => null) as unknown as typeof TooltipModule.TooltipContent
  );
  spyOn(SidebarCollapseButtonModule, "SidebarCollapseButton").mockImplementation((() => (
    <button type="button">toggle sidebar</button>
  )) as unknown as typeof SidebarCollapseButtonModule.SidebarCollapseButton);
  spyOn(ConfirmationModalModule, "ConfirmationModal").mockImplementation(((props: {
    isOpen: boolean;
    title: string;
    description?: string;
    warning?: string;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  }) => {
    latestArchiveConfirmationModalProps = props;
    return props.isOpen ? (
      <div data-testid="archive-confirmation-modal">
        <div>{props.title}</div>
        {props.description ? <div>{props.description}</div> : null}
        {props.warning ? <div>{props.warning}</div> : null}
        <button type="button" onClick={() => void props.onConfirm()}>
          {props.confirmLabel ?? "Confirm"}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    ) : null;
  }) as unknown as typeof ConfirmationModalModule.ConfirmationModal);
  spyOn(ProjectDeleteConfirmationModalModule, "ProjectDeleteConfirmationModal").mockImplementation(
    ((props: {
      isOpen: boolean;
      projectName: string;
      onConfirm: () => void;
      onCancel: () => void;
    }) =>
      props.isOpen ? (
        <div data-testid="project-delete-confirmation-modal">{props.projectName}</div>
      ) : null) as unknown as typeof ProjectDeleteConfirmationModalModule.ProjectDeleteConfirmationModal
  );
  spyOn(WorkspaceStatusIndicatorModule, "WorkspaceStatusIndicator").mockImplementation((() => (
    <div data-testid="workspace-status-indicator" />
  )) as unknown as typeof WorkspaceStatusIndicatorModule.WorkspaceStatusIndicator);
  spyOn(PopoverErrorModule, "PopoverError").mockImplementation(
    (() => null) as unknown as typeof PopoverErrorModule.PopoverError
  );
  spyOn(SectionHeaderModule, "SectionHeader").mockImplementation(
    (() => null) as unknown as typeof SectionHeaderModule.SectionHeader
  );
  spyOn(WorkspaceSectionDropZoneModule, "WorkspaceSectionDropZone").mockImplementation(
    TestWrapper as unknown as typeof WorkspaceSectionDropZoneModule.WorkspaceSectionDropZone
  );
  spyOn(WorkspaceDragLayerModule, "WorkspaceDragLayer").mockImplementation(
    (() => null) as unknown as typeof WorkspaceDragLayerModule.WorkspaceDragLayer
  );
  spyOn(SectionDragLayerModule, "SectionDragLayer").mockImplementation(
    (() => null) as unknown as typeof SectionDragLayerModule.SectionDragLayer
  );
  spyOn(DraggableSectionModule, "DraggableSection").mockImplementation(
    TestWrapper as unknown as typeof DraggableSectionModule.DraggableSection
  );
  void mock.module("../PositionedMenu/PositionedMenu", () => ({
    PositionedMenu: (props: { open: boolean; children: React.ReactNode }) =>
      props.open ? <div data-testid="project-actions-menu">{props.children}</div> : null,
    PositionedMenuItem: (props: {
      label: string;
      disabled?: boolean;
      onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
    }) => (
      <button
        type="button"
        disabled={props.disabled}
        onClick={(event) => {
          props.onClick(event);
        }}
      >
        {props.label}
      </button>
    ),
  }));
  /* eslint-disable @typescript-eslint/no-require-imports */
  ({ default: ProjectSidebar } = require("./ProjectSidebar?project-sidebar-test=1") as {
    default: typeof ProjectSidebarComponent;
  });
  /* eslint-enable @typescript-eslint/no-require-imports */
}

function createWorkspace(
  id: string,
  opts?: {
    parentWorkspaceId?: string;
    taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
    title?: string;
    bestOf?: FrontendWorkspaceMetadata["bestOf"];
  }
): FrontendWorkspaceMetadata {
  return {
    id,
    name: `${id}-name`,
    title: opts?.title ?? id,
    projectName: "demo-project",
    projectPath: "/projects/demo-project",
    projects: [
      { projectPath: "/projects/demo-project", projectName: "demo-project" },
      { projectPath: "/projects/other-project", projectName: "other-project" },
    ],
    namedWorkspacePath: `/projects/demo-project/${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: opts?.parentWorkspaceId,
    taskStatus: opts?.taskStatus,
    bestOf: opts?.bestOf,
  };
}

let cleanupDom: (() => void) | null = null;

describe("ProjectSidebar multi-project completed-subagent toggles", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem(
      EXPANDED_PROJECTS_KEY,
      JSON.stringify([MULTI_PROJECT_SIDEBAR_SECTION_ID])
    );
    settingsOpenMock = mock(() => undefined);
    projectContextValue = createProjectContextValue();
    installProjectSidebarTestDoubles();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("filters multi-project rows out entirely when the experiment is disabled", () => {
    spyOn(ExperimentsModule, "useExperimentValue").mockImplementation(() => false);

    const parentWorkspace = createWorkspace("parent", { title: "Parent workspace" });
    const completedChildWorkspace = createWorkspace("child", {
      parentWorkspaceId: "parent",
      taskStatus: "reported",
      title: "Completed child workspace",
    });

    const sortedWorkspacesByProject = new Map([
      ["/projects/demo-project", [parentWorkspace, completedChildWorkspace]],
    ]);

    const view = render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        workspaceRecency={{}}
      />
    );

    expect(view.queryByText("Multi-Project")).toBeNull();
    expect(view.queryByTestId(agentItemTestId("parent"))).toBeNull();
    expect(view.queryByTestId(agentItemTestId("child"))).toBeNull();
  });

  test("reuses normal workspace chevron/collapse behavior for multi-project rows", async () => {
    const parentWorkspace = createWorkspace("parent", { title: "Parent workspace" });
    const completedChildWorkspace = createWorkspace("child", {
      parentWorkspaceId: "parent",
      taskStatus: "reported",
      title: "Completed child workspace",
    });

    const sortedWorkspacesByProject = new Map([
      ["/projects/demo-project", [parentWorkspace, completedChildWorkspace]],
    ]);

    const view = render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        workspaceRecency={{}}
      />
    );

    const parentRow = view.getByTestId(agentItemTestId("parent"));
    expect(parentRow.dataset.rowKind).toBe("primary");
    expect(parentRow.dataset.completedExpanded).toBe("false");
    expect(view.queryByTestId(agentItemTestId("child"))).toBeNull();

    const toggleButton = view.getByRole("button", { name: toggleButtonLabel("parent") });
    fireEvent.click(toggleButton);

    await waitFor(() => {
      expect(view.getByTestId(agentItemTestId("child"))).toBeTruthy();
    });

    const expandedParentRow = view.getByTestId(agentItemTestId("parent"));
    const childRow = view.getByTestId(agentItemTestId("child"));

    expect(expandedParentRow.dataset.completedExpanded).toBe("true");
    expect(childRow.dataset.rowKind).toBe("subagent");
    expect(childRow.dataset.depth).toBe("1");
  });

  test("coalesces best-of sub-agents into a single sidebar row until expanded", async () => {
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(["/projects/demo-project"]));

    const singleProjectRefs = [
      { projectPath: "/projects/demo-project", projectName: "demo-project" },
    ];
    const parentWorkspace = {
      ...createWorkspace("parent", { title: "Parent workspace" }),
      projects: singleProjectRefs,
    };
    const bestOfGroup = { groupId: "best-of-demo", index: 0, total: 3 } as const;
    const childOne = {
      ...createWorkspace("child-1", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        title: "Compare implementation options",
        bestOf: bestOfGroup,
      }),
      projects: singleProjectRefs,
    };
    const childTwo = {
      ...createWorkspace("child-2", {
        parentWorkspaceId: "parent",
        taskStatus: "queued",
        title: "Compare implementation options",
        bestOf: { ...bestOfGroup, index: 1 },
      }),
      projects: singleProjectRefs,
    };
    const childThree = {
      ...createWorkspace("child-3", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        title: "Compare implementation options",
        bestOf: { ...bestOfGroup, index: 2 },
      }),
      projects: singleProjectRefs,
    };

    const sortedWorkspacesByProject = new Map([
      ["/projects/demo-project", [parentWorkspace, childOne, childTwo, childThree]],
    ]);

    const projectConfig = { workspaces: [] };
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(() => ({
      userProjects: new Map([["/projects/demo-project", projectConfig]]),
      systemProjectPath: null,
      resolveProjectPath: () => null,
      getProjectConfig: () => projectConfig,
      loading: false,
      refreshProjects: () => Promise.resolve(),
      addProject: () => undefined,
      removeProject: () => Promise.resolve({ success: true }),
      isProjectCreateModalOpen: false,
      openProjectCreateModal: () => undefined,
      closeProjectCreateModal: () => undefined,
      workspaceModalState: {
        isOpen: false,
        projectPath: null,
        projectName: "",
        branches: [],
        defaultTrunkBranch: undefined,
        loadErrorMessage: null,
        isLoading: false,
      },
      openWorkspaceModal: () => Promise.resolve(),
      closeWorkspaceModal: () => undefined,
      getBranchesForProject: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
      getSecrets: () => Promise.resolve([]),
      updateSecrets: () => Promise.resolve(),
      updateDisplayName: () => resolveVoidResult(),
      updateColor: () => resolveVoidResult(),
      createSection: () =>
        Promise.resolve({ success: true, data: { id: "section-1", name: "Section" } }),
      updateSection: () => resolveVoidResult(),
      removeSection: () => resolveVoidResult(),
      reorderSections: () => resolveVoidResult(),
      assignWorkspaceToSection: () => resolveVoidResult(),
      hasAnyProject: true,
      resolveNewChatProjectPath: () => "/projects/demo-project",
    }));

    const workspaceRecency = {
      parent: Date.now(),
      "child-1": Date.now(),
      "child-2": Date.now(),
      "child-3": Date.now(),
    };

    const view = render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        workspaceRecency={workspaceRecency}
      />
    );

    expect(view.getByTestId(agentItemTestId("parent"))).toBeTruthy();
    const groupRow = view.getByTestId("task-group-best-of-demo");
    expect(groupRow.textContent).toContain("Best of 3");
    expect(view.queryByTestId(agentItemTestId("child-1"))).toBeNull();
    expect(view.queryByTestId(agentItemTestId("child-2"))).toBeNull();
    expect(view.queryByTestId(agentItemTestId("child-3"))).toBeNull();

    fireEvent.click(groupRow);

    await waitFor(() => {
      expect(view.getByTestId(agentItemTestId("child-1"))).toBeTruthy();
      expect(view.getByTestId(agentItemTestId("child-2"))).toBeTruthy();
      expect(view.getByTestId(agentItemTestId("child-3"))).toBeTruthy();
    });
  });

  test("renders variants groups with a shared row and labeled members when expanded", async () => {
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(["/projects/demo-project"]));

    const singleProjectRefs = [
      { projectPath: "/projects/demo-project", projectName: "demo-project" },
    ];
    const parentWorkspace = {
      ...createWorkspace("parent", { title: "Parent workspace" }),
      projects: singleProjectRefs,
    };
    const taskGroup = {
      groupId: "variants-demo",
      index: 0,
      total: 2,
      kind: "variants",
      label: "frontend",
    } as const;
    const childOne = {
      ...createWorkspace("child-1", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        title: "Split review",
        bestOf: taskGroup,
      }),
      projects: singleProjectRefs,
    };
    const childTwo = {
      ...createWorkspace("child-2", {
        parentWorkspaceId: "parent",
        taskStatus: "queued",
        title: "Split review",
        bestOf: { ...taskGroup, index: 1, label: "backend" },
      }),
      projects: singleProjectRefs,
    };

    const sortedWorkspacesByProject = new Map([
      ["/projects/demo-project", [parentWorkspace, childOne, childTwo]],
    ]);

    const projectConfig = { workspaces: [] };
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(() => ({
      userProjects: new Map([["/projects/demo-project", projectConfig]]),
      systemProjectPath: null,
      resolveProjectPath: () => null,
      getProjectConfig: () => projectConfig,
      loading: false,
      refreshProjects: () => Promise.resolve(),
      addProject: () => undefined,
      removeProject: () => Promise.resolve({ success: true }),
      isProjectCreateModalOpen: false,
      openProjectCreateModal: () => undefined,
      closeProjectCreateModal: () => undefined,
      workspaceModalState: {
        isOpen: false,
        projectPath: null,
        projectName: "",
        branches: [],
        defaultTrunkBranch: undefined,
        loadErrorMessage: null,
        isLoading: false,
      },
      openWorkspaceModal: () => Promise.resolve(),
      closeWorkspaceModal: () => undefined,
      getBranchesForProject: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
      getSecrets: () => Promise.resolve([]),
      updateSecrets: () => Promise.resolve(),
      updateDisplayName: () => resolveVoidResult(),
      updateColor: () => resolveVoidResult(),
      createSection: () =>
        Promise.resolve({ success: true, data: { id: "section-1", name: "Section" } }),
      updateSection: () => resolveVoidResult(),
      removeSection: () => resolveVoidResult(),
      reorderSections: () => resolveVoidResult(),
      assignWorkspaceToSection: () => resolveVoidResult(),
      hasAnyProject: true,
      resolveNewChatProjectPath: () => "/projects/demo-project",
    }));

    const workspaceRecency = {
      parent: Date.now(),
      "child-1": Date.now(),
      "child-2": Date.now(),
    };

    const view = render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        workspaceRecency={workspaceRecency}
      />
    );

    const groupRow = view.getByTestId("task-group-variants-demo");
    expect(groupRow.textContent).toContain("Variants · Split review");
    expect(view.queryByTestId(agentItemTestId("child-1"))).toBeNull();
    expect(view.queryByTestId(agentItemTestId("child-2"))).toBeNull();

    fireEvent.click(groupRow);

    await waitFor(() => {
      expect(view.getByText("frontend · Split review")).toBeTruthy();
      expect(view.getByText("backend · Split review")).toBeTruthy();
    });
  });

  test("does not coalesce a best-of group when one candidate still has hidden child tasks", () => {
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(["/projects/demo-project"]));

    const singleProjectRefs = [
      { projectPath: "/projects/demo-project", projectName: "demo-project" },
    ];
    const parentWorkspace = {
      ...createWorkspace("parent", { title: "Parent workspace" }),
      projects: singleProjectRefs,
    };
    const bestOfGroup = { groupId: "best-of-non-leaf", index: 0, total: 2 } as const;
    const childOne = {
      ...createWorkspace("child-1", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        title: "Compare implementation options",
        bestOf: bestOfGroup,
      }),
      projects: singleProjectRefs,
    };
    const hiddenGrandchild = {
      ...createWorkspace("grandchild-1", {
        parentWorkspaceId: "child-1",
        taskStatus: "reported",
        title: "Nested follow-up",
      }),
      projects: singleProjectRefs,
    };
    const childTwo = {
      ...createWorkspace("child-2", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        title: "Compare implementation options",
        bestOf: { ...bestOfGroup, index: 1 },
      }),
      projects: singleProjectRefs,
    };

    const sortedWorkspacesByProject = new Map([
      ["/projects/demo-project", [parentWorkspace, childOne, hiddenGrandchild, childTwo]],
    ]);

    const projectConfig = { workspaces: [] };
    spyOn(ProjectContextModule, "useProjectContext").mockImplementation(() => ({
      userProjects: new Map([["/projects/demo-project", projectConfig]]),
      systemProjectPath: null,
      resolveProjectPath: () => null,
      getProjectConfig: () => projectConfig,
      loading: false,
      refreshProjects: () => Promise.resolve(),
      addProject: () => undefined,
      removeProject: () => Promise.resolve({ success: true }),
      isProjectCreateModalOpen: false,
      openProjectCreateModal: () => undefined,
      closeProjectCreateModal: () => undefined,
      workspaceModalState: {
        isOpen: false,
        projectPath: null,
        projectName: "",
        branches: [],
        defaultTrunkBranch: undefined,
        loadErrorMessage: null,
        isLoading: false,
      },
      openWorkspaceModal: () => Promise.resolve(),
      closeWorkspaceModal: () => undefined,
      getBranchesForProject: () => Promise.resolve({ branches: [], recommendedTrunk: null }),
      getSecrets: () => Promise.resolve([]),
      updateSecrets: () => Promise.resolve(),
      updateDisplayName: () => resolveVoidResult(),
      updateColor: () => resolveVoidResult(),
      createSection: () =>
        Promise.resolve({ success: true, data: { id: "section-1", name: "Section" } }),
      updateSection: () => resolveVoidResult(),
      removeSection: () => resolveVoidResult(),
      reorderSections: () => resolveVoidResult(),
      assignWorkspaceToSection: () => resolveVoidResult(),
      hasAnyProject: true,
      resolveNewChatProjectPath: () => "/projects/demo-project",
    }));

    const workspaceRecency = {
      parent: Date.now(),
      "child-1": Date.now(),
      "grandchild-1": Date.now(),
      "child-2": Date.now(),
    };

    const view = render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={sortedWorkspacesByProject}
        workspaceRecency={workspaceRecency}
      />
    );

    expect(view.queryByTestId("task-group-best-of-non-leaf")).toBeNull();
    expect(view.getByTestId(agentItemTestId("child-1"))).toBeTruthy();
    expect(view.getByTestId(agentItemTestId("child-2"))).toBeTruthy();
    expect(view.queryByTestId(agentItemTestId("grandchild-1"))).toBeNull();
  });
});

describe("ProjectSidebar archive confirmations", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(["/projects/demo-project"]));
    settingsOpenMock = mock(() => undefined);
    projectContextValue = createProjectContextValue({
      userProjects: new Map([["/projects/demo-project", { workspaces: [] }]]),
    });
    installProjectSidebarTestDoubles();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  function renderArchiveSidebar(workspace: FrontendWorkspaceMetadata) {
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          "/projects/demo-project",
          {
            workspaces: [{ path: workspace.namedWorkspacePath }],
          },
        ],
      ]),
    });

    return render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map([["/projects/demo-project", [workspace]]])}
        workspaceRecency={{ [workspace.id]: Date.now() }}
      />
    );
  }

  test("opens the archive confirmation modal when preflight finds untracked files", async () => {
    preflightArchiveWorkspaceMock = mock(
      (_workspaceId: string): Promise<ArchivePreflightActionResult> =>
        resolveArchivePreflight({
          kind: "confirm-lossy-untracked-files",
          paths: [".cache/", "temp.txt"],
        })
    );

    const workspace = {
      ...createWorkspace("archive-preflight-confirm"),
      projects: [{ projectPath: "/projects/demo-project", projectName: "demo-project" }],
    };
    const view = renderArchiveSidebar(workspace);

    const archiveButton = document.createElement("button");
    expect(latestArchiveWorkspaceHandler).toBeTruthy();
    await act(async () => {
      await latestArchiveWorkspaceHandler?.(workspace.id, archiveButton);
    });

    expect(archiveWorkspaceActionMock).not.toHaveBeenCalled();
    expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    expect(view.getByText("Archive workspace with untracked files?")).toBeTruthy();
    expect(view.getByRole("button", { name: "Archive and delete files" })).toBeTruthy();
  });

  test("reopens the archive confirmation modal when archive finds new untracked files", async () => {
    let archiveAttempt = 0;
    archiveWorkspaceActionMock = mock(
      (
        workspaceId: string,
        options?: { acknowledgedUntrackedPaths?: string[] }
      ): Promise<ArchiveWorkspaceActionResult> => {
        archiveAttempt += 1;
        if (archiveAttempt === 1) {
          return resolveArchiveResult({
            kind: "confirm-lossy-untracked-files",
            paths: ["late-file.txt"],
          });
        }

        expect(workspaceId).toBe("archive-late-confirm");
        expect(options).toEqual({ acknowledgedUntrackedPaths: ["late-file.txt"] });
        return resolveArchiveResult({ kind: "archived" });
      }
    );

    const workspace = {
      ...createWorkspace("archive-late-confirm"),
      projects: [{ projectPath: "/projects/demo-project", projectName: "demo-project" }],
    };
    const view = renderArchiveSidebar(workspace);

    const archiveButton = document.createElement("button");
    expect(latestArchiveWorkspaceHandler).toBeTruthy();
    await act(async () => {
      await latestArchiveWorkspaceHandler?.(workspace.id, archiveButton);
    });

    await waitFor(() => {
      expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    });
    expect(archivePopoverShowErrorMock).not.toHaveBeenCalled();
    expect(archiveWorkspaceActionMock).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceActionMock).toHaveBeenNthCalledWith(1, workspace.id, undefined);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive and delete files" }));
    });

    await waitFor(() => {
      expect(archiveWorkspaceActionMock).toHaveBeenCalledTimes(2);
    });
    expect(archiveWorkspaceActionMock).toHaveBeenNthCalledWith(2, workspace.id, {
      acknowledgedUntrackedPaths: ["late-file.txt"],
    });
    expect(archivePopoverShowErrorMock).not.toHaveBeenCalled();
  });

  test("surfaces archive errors after confirmation when untracked paths are unchanged", async () => {
    let preflightCallCount = 0;
    preflightArchiveWorkspaceMock = mock(
      (_workspaceId: string): Promise<ArchivePreflightActionResult> => {
        preflightCallCount += 1;
        return resolveArchivePreflight({
          kind: "confirm-lossy-untracked-files",
          paths: ["late-file.txt"],
        });
      }
    );
    archiveWorkspaceActionMock = mock(
      (
        workspaceId: string,
        options?: { acknowledgedUntrackedPaths?: string[] }
      ): Promise<ArchiveWorkspaceActionResult> => {
        expect(workspaceId).toBe("archive-stable-untracked");
        expect(options).toEqual({ acknowledgedUntrackedPaths: ["late-file.txt"] });
        return Promise.resolve({ success: false as const, error: "snapshot failed" });
      }
    );

    spyOn(PopoverErrorHookModule, "usePopoverError").mockImplementation(
      () =>
        ({
          error: null,
          showError: archivePopoverShowErrorMock,
          clearError: mock(() => undefined),
        }) as unknown as ReturnType<typeof PopoverErrorHookModule.usePopoverError>
    );

    const workspace = {
      ...createWorkspace("archive-stable-untracked"),
      projects: [{ projectPath: "/projects/demo-project", projectName: "demo-project" }],
    };
    const view = renderArchiveSidebar(workspace);

    const archiveButton = document.createElement("button");
    expect(latestArchiveWorkspaceHandler).toBeTruthy();
    await act(async () => {
      await latestArchiveWorkspaceHandler?.(workspace.id, archiveButton);
    });

    await waitFor(() => {
      expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    });

    await act(async () => {
      await latestArchiveConfirmationModalProps?.onConfirm();
    });

    await waitFor(() => {
      expect(archiveWorkspaceActionMock).toHaveBeenCalledTimes(1);
      expect(archivePopoverShowErrorMock).toHaveBeenCalledTimes(1);
    });
    expect(preflightCallCount).toBe(2);
    expect(archivePopoverShowErrorMock).toHaveBeenCalledWith(workspace.id, "snapshot failed");
    expect(view.queryByTestId("archive-confirmation-modal")).toBeNull();
  });
});

describe("ProjectSidebar archive errors", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(["/projects/demo-project"]));
    settingsOpenMock = mock(() => undefined);
    projectContextValue = createProjectContextValue({
      userProjects: new Map([["/projects/demo-project", { workspaces: [] }]]),
    });
    installProjectSidebarTestDoubles();
    spyOn(PopoverErrorHookModule, "usePopoverError").mockImplementation(
      () =>
        ({
          error: null,
          showError: archivePopoverShowErrorMock,
          clearError: mock(() => undefined),
        }) as unknown as ReturnType<typeof PopoverErrorHookModule.usePopoverError>
    );
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("uses the shared toast fallback position for archive failures", async () => {
    archiveWorkspaceActionMock = mock(
      (
        _workspaceId: string,
        _options?: { acknowledgedUntrackedPaths?: string[] }
      ): Promise<ArchiveWorkspaceActionResult> =>
        Promise.resolve({ success: false as const, error: "snapshot failed" })
    );
    const apiWithArchivePreflight = {
      workspace: {
        preflightArchive: () =>
          Promise.resolve({ success: true, data: { kind: "ready" as const } }),
      },
    } as unknown as NonNullable<ReturnType<typeof APIModule.useAPI>["api"]>;
    spyOn(APIModule, "useAPI").mockImplementation(() => ({
      api: apiWithArchivePreflight,
      status: "connected",
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    }));

    const workspace = {
      ...createWorkspace("archive-target"),
      projects: [{ projectPath: "/projects/demo-project", projectName: "demo-project" }],
    };
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          "/projects/demo-project",
          {
            workspaces: [{ path: workspace.namedWorkspacePath }],
          },
        ],
      ]),
    });
    render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map([["/projects/demo-project", [workspace]]])}
        workspaceRecency={{ [workspace.id]: Date.now() }}
      />
    );

    const archiveButton = document.createElement("button");
    expect(latestArchiveWorkspaceHandler).toBeTruthy();
    await act(async () => {
      await latestArchiveWorkspaceHandler?.(workspace.id, archiveButton);
    });

    expect(archiveWorkspaceActionMock).toHaveBeenCalledTimes(1);
    // No untracked files acknowledged (preflight returned "ready"), so options is undefined.
    expect(archiveWorkspaceActionMock).toHaveBeenCalledWith(workspace.id, undefined);

    await waitFor(() => {
      expect(archivePopoverShowErrorMock).toHaveBeenCalledTimes(1);
    });

    const args = archivePopoverShowErrorMock.mock.calls[0];
    expect(args?.[0]).toBe(workspace.id);
    expect(args?.[1]).toBe("snapshot failed");
    expect(args?.length).toBe(2);
  });
});

describe("ProjectSidebar archive confirmations", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(["/projects/demo-project"]));
    settingsOpenMock = mock(() => undefined);
    projectContextValue = createProjectContextValue({
      userProjects: new Map([["/projects/demo-project", { workspaces: [] }]]),
    });
    installProjectSidebarTestDoubles();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("opens the archive confirmation modal when preflight finds untracked files", async () => {
    const workspace = {
      ...createWorkspace("archive-untracked"),
      projects: [{ projectPath: "/projects/demo-project", projectName: "demo-project" }],
    };
    const preflightArchiveWorkspace = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { kind: "confirm-lossy-untracked-files" as const, paths: ["scratch.txt"] },
      })
    );
    const archiveWorkspace = mock(() => Promise.resolve({ success: true as const }));

    spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
      () =>
        ({
          selectedWorkspace: null,
          setSelectedWorkspace: () => undefined,
          preflightArchiveWorkspace,
          archiveWorkspace,
          removeWorkspace: () => Promise.resolve({ success: true }),
          updateWorkspaceTitle: () => Promise.resolve({ success: true }),
          refreshWorkspaceMetadata: () => Promise.resolve(),
          pendingNewWorkspaceProject: null,
          pendingNewWorkspaceDraftId: null,
          workspaceDraftsByProject: {},
          workspaceDraftPromotionsByProject: {},
          createWorkspaceDraft: () => undefined,
          openWorkspaceDraft: () => undefined,
          deleteWorkspaceDraft: () => undefined,
        }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
    );

    render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map([["/projects/demo-project", [workspace]]])}
        workspaceRecency={{ [workspace.id]: Date.now() }}
      />
    );

    const archiveButton = document.createElement("button");
    expect(latestArchiveWorkspaceHandler).toBeTruthy();
    await act(async () => {
      await latestArchiveWorkspaceHandler?.(workspace.id, archiveButton);
    });

    await waitFor(() => {
      expect(latestArchiveConfirmationModalProps?.isOpen).toBe(true);
    });
    expect(latestArchiveConfirmationModalProps?.title).toBe(
      "Archive workspace with untracked files?"
    );
    expect(archiveWorkspace).not.toHaveBeenCalled();
  });

  test("reopens the archive confirmation modal when archive finds new untracked files", async () => {
    const workspace = {
      ...createWorkspace("archive-race-window"),
      projects: [{ projectPath: "/projects/demo-project", projectName: "demo-project" }],
    };
    let preflightCallCount = 0;
    const preflightArchiveWorkspace = mock<
      (workspaceId: string) => Promise<{ success: true; data: { kind: string; paths?: string[] } }>
    >((workspaceId: string) => {
      if (workspaceId !== workspace.id) {
        return Promise.resolve({ success: true, data: { kind: "ready" } });
      }
      preflightCallCount += 1;
      if (preflightCallCount === 1) {
        return Promise.resolve({
          success: true,
          data: { kind: "confirm-lossy-untracked-files", paths: ["a.txt"] },
        });
      }
      return Promise.resolve({
        success: true,
        data: { kind: "confirm-lossy-untracked-files", paths: ["a.txt", "b.txt"] },
      });
    });
    const archiveWorkspace = mock(() =>
      Promise.resolve({
        success: false as const,
        error:
          "Untracked files changed since you reviewed them. New files: b.txt. Please try again.",
      })
    );

    spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
      () =>
        ({
          selectedWorkspace: null,
          setSelectedWorkspace: () => undefined,
          preflightArchiveWorkspace,
          archiveWorkspace,
          removeWorkspace: () => Promise.resolve({ success: true }),
          updateWorkspaceTitle: () => Promise.resolve({ success: true }),
          refreshWorkspaceMetadata: () => Promise.resolve(),
          pendingNewWorkspaceProject: null,
          pendingNewWorkspaceDraftId: null,
          workspaceDraftsByProject: {},
          workspaceDraftPromotionsByProject: {},
          createWorkspaceDraft: () => undefined,
          openWorkspaceDraft: () => undefined,
          deleteWorkspaceDraft: () => undefined,
        }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
    );

    render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map([["/projects/demo-project", [workspace]]])}
        workspaceRecency={{ [workspace.id]: Date.now() }}
      />
    );

    const archiveButton = document.createElement("button");
    expect(latestArchiveWorkspaceHandler).toBeTruthy();
    await act(async () => {
      await latestArchiveWorkspaceHandler?.(workspace.id, archiveButton);
    });

    await waitFor(() => {
      expect(latestArchiveConfirmationModalProps?.isOpen).toBe(true);
      expect(latestArchiveConfirmationModalProps?.warning?.includes("a.txt")).toBe(true);
    });

    await act(async () => {
      await latestArchiveConfirmationModalProps?.onConfirm();
    });

    await waitFor(() => {
      expect(preflightArchiveWorkspace.mock.calls.length).toBe(2);
      expect(latestArchiveConfirmationModalProps?.isOpen).toBe(true);
      expect(latestArchiveConfirmationModalProps?.warning?.includes("b.txt")).toBe(true);
    });
    expect(archivePopoverShowErrorMock).not.toHaveBeenCalled();
  });
});

describe("ProjectSidebar project actions menu", () => {
  const demoProjectPath = "/projects/demo-project";

  beforeEach(() => {
    cleanupDom = installDom();
    window.localStorage.clear();
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([demoProjectPath]));

    settingsOpenMock = mock(() => undefined);
    projectContextValue = createProjectContextValue({
      userProjects: new Map([[demoProjectPath, { workspaces: [] }]]),
    });

    installProjectSidebarTestDoubles();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  function renderSidebar() {
    return render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map()}
        workspaceRecency={{}}
      />
    );
  }

  test("renders always-visible new-chat and kebab buttons, and opens menu from kebab", () => {
    const view = renderSidebar();

    expect(view.getByRole("button", { name: "New chat in demo-project" })).toBeTruthy();
    const projectOptionsButton = view.getByRole("button", {
      name: "Project options for demo-project",
    });

    fireEvent.click(projectOptionsButton);

    const menu = view.getByTestId("project-actions-menu");
    const menuButtons = within(menu).getAllByRole("button");
    expect(menuButtons.map((button) => button.textContent)).toEqual([
      "Edit name",
      "Add sub-folder",
      "Manage secrets",
      "Change color",
      "Delete...",
    ]);
  });

  test("opens the same project actions menu on right-click", () => {
    const view = renderSidebar();

    fireEvent.contextMenu(view.getByText("demo-project"));

    expect(view.getByTestId("project-actions-menu")).toBeTruthy();
    expect(view.getByRole("button", { name: "Edit name" })).toBeTruthy();
  });

  test("menu actions route to settings and delete confirmation", () => {
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [demoProjectPath, { workspaces: [{ path: `${demoProjectPath}/ws-1` }] }],
      ]),
    });

    const view = renderSidebar();

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Manage secrets" }));

    expect(settingsOpenMock).toHaveBeenCalledWith("secrets", {
      secretsProjectPath: demoProjectPath,
    });

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Delete..." }));

    expect(view.getByTestId("project-delete-confirmation-modal").textContent).toBe("demo-project");
  });

  test("reopening the color picker does not apply stale pending color", async () => {
    const updateColor = mock((_projectPath: string, _color: string | null) => resolveVoidResult());
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          demoProjectPath,
          {
            workspaces: [],
            color: "#6B7280",
          },
        ],
      ]),
      updateColor,
    });

    const view = renderSidebar();

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Change color" }));

    // Let the initial sync settle so the picker starts from the current project color.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    fireEvent.click(view.getByTestId("hex-color-picker"));

    // Close before the next debounce window expires so this picker session leaves
    // behind a pending value that must not auto-commit on reopen.
    fireEvent.click(view.getByRole("button", { name: "Change color" }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });

    expect(updateColor).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Change color" }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(updateColor).not.toHaveBeenCalled();
  });

  test("keeps in-progress project color edits across project refreshes", async () => {
    const updateColor = mock((_projectPath: string, _color: string | null) => resolveVoidResult());
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          demoProjectPath,
          {
            workspaces: [],
            color: "#6B7280",
          },
        ],
      ]),
      updateColor,
    });

    const view = renderSidebar();

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Change color" }));

    const initialInput = view.container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(initialInput?.value).toBe("#6b7280");

    fireEvent.click(view.getByTestId("hex-color-picker"));

    await waitFor(() => {
      const input = view.container.querySelector<HTMLInputElement>('input[type="text"]');
      expect(input?.value).toBe("#123456");
    });

    // Simulate a project refresh echoing a new persisted color while the picker
    // remains open; the in-progress local edit should remain untouched.
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          demoProjectPath,
          {
            workspaces: [],
            color: "#112233",
          },
        ],
      ]),
      updateColor,
    });

    view.rerender(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map()}
        workspaceRecency={{}}
      />
    );

    const inputAfterRefresh = view.container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(inputAfterRefresh?.value).toBe("#123456");
  });

  test("Add sub-folder expands collapsed project before auto-editing", async () => {
    window.localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([]));
    const createSection = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { id: "new-section", name: "New sub-folder", color: "#6B7280", nextId: null },
      })
    );
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          demoProjectPath,
          {
            workspaces: [],
            sections: [
              { id: "new-section", name: "New sub-folder", color: "#6B7280", nextId: null },
            ],
          },
        ],
      ]),
      createSection,
    });

    const view = renderSidebar();
    expect(view.getByRole("button", { name: "Expand project demo-project" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Add sub-folder" }));

    await waitFor(() => {
      expect(createSection).toHaveBeenCalledWith(demoProjectPath, "New sub-folder");
      expect(view.getByRole("button", { name: "Collapse project demo-project" })).toBeTruthy();
    });
  });

  test("Add sub-folder abandon reuses section-delete confirmation before removing", async () => {
    const createSection = mock(() =>
      Promise.resolve({
        success: true as const,
        data: { id: "new-section", name: "New sub-folder", color: "#6B7280", nextId: null },
      })
    );
    const removeSection = mock(() => resolveVoidResult());
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          demoProjectPath,
          {
            workspaces: [
              {
                path: `${demoProjectPath}/ws-in-section`,
                sectionId: "new-section",
              },
            ],
            sections: [
              { id: "new-section", name: "New sub-folder", color: "#6B7280", nextId: null },
            ],
          },
        ],
      ]),
      createSection,
      removeSection,
    });

    const view = renderSidebar();

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Add sub-folder" }));

    await waitFor(() => {
      expect(createSection).toHaveBeenCalledWith(demoProjectPath, "New sub-folder");
    });

    let autoEditProps:
      | (Parameters<typeof SectionHeaderModule.SectionHeader>[0] & {
          onAutoCreateAbandon?: () => void;
          autoStartEditing?: boolean;
        })
      | null = null;
    const sectionHeaderCalls = (
      SectionHeaderModule.SectionHeader as unknown as {
        mock: {
          calls: Array<[Parameters<typeof SectionHeaderModule.SectionHeader>[0]]>;
        };
      }
    ).mock.calls;
    for (const [props] of sectionHeaderCalls) {
      if (props.autoStartEditing) {
        autoEditProps = props;
      }
    }

    expect(autoEditProps?.autoStartEditing).toBe(true);
    expect(typeof autoEditProps?.onAutoCreateAbandon).toBe("function");

    autoEditProps?.onAutoCreateAbandon?.();

    await waitFor(() => {
      expect(confirmDialogMock).toHaveBeenCalledWith({
        title: "Delete section?",
        description: "1 workspace(s) in this section will be moved to unsectioned.",
        confirmLabel: "Delete",
        confirmVariant: "destructive",
      });
      expect(removeSection).toHaveBeenCalledWith(demoProjectPath, "new-section");
    });
  });

  test("marks section attention when a promoted draft workspace needs attention", () => {
    const promotedWorkspace = {
      ...createWorkspace("promoted-workspace", { title: "Promoted workspace" }),
      sectionId: "section-1",
      isInitializing: true,
    };

    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        [
          demoProjectPath,
          {
            workspaces: [
              {
                path: `${demoProjectPath}/promoted-workspace`,
                sectionId: "section-1",
              },
            ],
            sections: [{ id: "section-1", name: "Section 1", color: "#6B7280", nextId: null }],
          },
        ],
      ]),
    });

    spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
      () =>
        ({
          selectedWorkspace: null,
          setSelectedWorkspace: () => undefined,
          preflightArchiveWorkspace: preflightArchiveWorkspaceMock,
          archiveWorkspace: archiveWorkspaceActionMock,
          removeWorkspace: () => Promise.resolve({ success: true }),
          updateWorkspaceTitle: () => Promise.resolve({ success: true }),
          refreshWorkspaceMetadata: () => Promise.resolve(),
          pendingNewWorkspaceProject: null,
          pendingNewWorkspaceDraftId: null,
          workspaceDraftsByProject: {
            [demoProjectPath]: [
              {
                draftId: "draft-promoted",
                sectionId: "section-1",
                createdAt: Date.now(),
              },
            ],
          },
          workspaceDraftPromotionsByProject: {
            [demoProjectPath]: {
              "draft-promoted": promotedWorkspace,
            },
          },
          createWorkspaceDraft: () => undefined,
          openWorkspaceDraft: () => undefined,
          deleteWorkspaceDraft: () => undefined,
        }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
    );

    render(
      <ProjectSidebar
        collapsed={false}
        onToggleCollapsed={() => undefined}
        sortedWorkspacesByProject={new Map([[demoProjectPath, [promotedWorkspace]]])}
        workspaceRecency={{}}
      />
    );

    const sectionHeaderCalls = (
      SectionHeaderModule.SectionHeader as unknown as {
        mock: {
          calls: Array<[Parameters<typeof SectionHeaderModule.SectionHeader>[0]]>;
        };
      }
    ).mock.calls;
    const sectionProps = sectionHeaderCalls
      .map(([props]) => props)
      .find((props) => props.section.id === "section-1");

    expect(sectionProps?.hasAttention).toBe(true);
  });

  test("supports inline project name editing with Enter, Escape, and empty-to-null commit", async () => {
    const updateDisplayName = mock(() => resolveVoidResult());
    projectContextValue = createProjectContextValue({
      userProjects: new Map([[demoProjectPath, { workspaces: [], displayName: "Custom Name" }]]),
      updateDisplayName,
    });

    const view = renderSidebar();

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Edit name" }));

    const input = view.getByRole("textbox", { name: "Edit project name for demo-project" });
    expect((input as HTMLInputElement).value).toBe("Custom Name");

    fireEvent.change(input, { target: { value: "  Renamed Project  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(updateDisplayName).toHaveBeenCalledWith(demoProjectPath, "Renamed Project");
    });

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Edit name" }));

    const escapeInput = view.getByRole("textbox", { name: "Edit project name for demo-project" });
    fireEvent.change(escapeInput, { target: { value: "Do not save" } });
    fireEvent.keyDown(escapeInput, { key: "Escape" });

    expect(updateDisplayName.mock.calls.length).toBe(1);

    fireEvent.click(view.getByRole("button", { name: "Project options for demo-project" }));
    fireEvent.click(view.getByRole("button", { name: "Edit name" }));

    const emptyInput = view.getByRole("textbox", { name: "Edit project name for demo-project" });
    fireEvent.change(emptyInput, { target: { value: "   " } });
    fireEvent.blur(emptyInput);

    await waitFor(() => {
      expect(updateDisplayName).toHaveBeenCalledWith(demoProjectPath, null);
    });
  });

  test("renders displayName when set and falls back to basename when unset", () => {
    projectContextValue = createProjectContextValue({
      userProjects: new Map([
        ["/projects/custom-name-project", { workspaces: [], displayName: "Custom Label" }],
        ["/projects/fallback-project", { workspaces: [] }],
      ]),
    });

    const view = renderSidebar();

    expect(view.getByText("Custom Label")).toBeTruthy();
    expect(view.getByText("fallback-project")).toBeTruthy();
  });

  test("keeps empty placeholder visible when only hidden empty drafts exist", () => {
    spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
      () =>
        ({
          selectedWorkspace: null,
          setSelectedWorkspace: () => undefined,
          preflightArchiveWorkspace: () =>
            Promise.resolve({ success: true, data: { kind: "ready" as const } }),
          archiveWorkspace: archiveWorkspaceActionMock,
          removeWorkspace: () => Promise.resolve({ success: true }),
          updateWorkspaceTitle: () => Promise.resolve({ success: true }),
          refreshWorkspaceMetadata: () => Promise.resolve(),
          pendingNewWorkspaceProject: null,
          pendingNewWorkspaceDraftId: null,
          workspaceDraftsByProject: {
            [demoProjectPath]: [
              {
                draftId: "draft-hidden-empty",
                sectionId: null,
                createdAt: Date.now(),
              },
            ],
          },
          workspaceDraftPromotionsByProject: {},
          createWorkspaceDraft: () => undefined,
          openWorkspaceDraft: () => undefined,
          deleteWorkspaceDraft: () => undefined,
        }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
    );

    const view = renderSidebar();

    expect(view.getByText("Empty")).toBeTruthy();
  });

  test("hides empty placeholder immediately when a hidden draft becomes visible", async () => {
    const draftId = "draft-hidden-empty";
    spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
      () =>
        ({
          selectedWorkspace: null,
          setSelectedWorkspace: () => undefined,
          preflightArchiveWorkspace: () =>
            Promise.resolve({ success: true, data: { kind: "ready" as const } }),
          archiveWorkspace: archiveWorkspaceActionMock,
          removeWorkspace: () => Promise.resolve({ success: true }),
          updateWorkspaceTitle: () => Promise.resolve({ success: true }),
          refreshWorkspaceMetadata: () => Promise.resolve(),
          pendingNewWorkspaceProject: null,
          pendingNewWorkspaceDraftId: null,
          workspaceDraftsByProject: {
            [demoProjectPath]: [
              {
                draftId,
                sectionId: null,
                createdAt: Date.now(),
              },
            ],
          },
          workspaceDraftPromotionsByProject: {},
          createWorkspaceDraft: () => undefined,
          openWorkspaceDraft: () => undefined,
          deleteWorkspaceDraft: () => undefined,
        }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
    );

    const view = renderSidebar();
    expect(view.getByText("Empty")).toBeTruthy();

    const draftScopeId = getDraftScopeId(demoProjectPath, draftId);
    const draftInputKey = getInputKey(draftScopeId);

    act(() => {
      updatePersistedState<string>(draftInputKey, "Visible draft prompt", "");
    });

    await waitFor(() => {
      expect(view.queryByText("Empty")).toBeNull();
    });
  });
});
