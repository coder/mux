import "../../../../tests/ui/dom";

import { type PropsWithChildren } from "react";
import type ProjectSidebarComponent from "./ProjectSidebar";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as MuxLogoDarkModule from "@/browser/assets/logos/mux-logo-dark.svg?react";
import * as MuxLogoLightModule from "@/browser/assets/logos/mux-logo-light.svg?react";
import { installDom } from "../../../../tests/ui/dom";
import { EXPANDED_PROJECTS_KEY } from "@/common/constants/storage";
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
import * as TooltipModule from "../Tooltip/Tooltip";
import * as SidebarCollapseButtonModule from "../SidebarCollapseButton/SidebarCollapseButton";
import * as ConfirmationModalModule from "../ConfirmationModal/ConfirmationModal";
import * as ProjectDeleteConfirmationModalModule from "../ProjectDeleteConfirmationModal/ProjectDeleteConfirmationModal";
import * as WorkspaceStatusIndicatorModule from "../WorkspaceStatusIndicator/WorkspaceStatusIndicator";
import * as PopoverErrorModule from "../PopoverError/PopoverError";
import * as SectionHeaderModule from "../SectionHeader/SectionHeader";
import * as AddSectionButtonModule from "../AddSectionButton/AddSectionButton";
import * as WorkspaceSectionDropZoneModule from "../WorkspaceSectionDropZone/WorkspaceSectionDropZone";
import * as WorkspaceDragLayerModule from "../WorkspaceDragLayer/WorkspaceDragLayer";
import * as SectionDragLayerModule from "../SectionDragLayer/SectionDragLayer";
import * as DraggableSectionModule from "../DraggableSection/DraggableSection";
import * as AgentListItemModule from "../AgentListItem/AgentListItem";

const agentItemTestId = (workspaceId: string) => `agent-item-${workspaceId}`;
const toggleButtonLabel = (workspaceId: string) => `toggle-completed-${workspaceId}`;

function TestWrapper(props: PropsWithChildren) {
  return <>{props.children}</>;
}

const passthroughRef = <T,>(value: T): T => value;

let ProjectSidebar: typeof ProjectSidebarComponent;

function installProjectSidebarModuleMocks() {
  void mock.module("react-dnd", () => ({
    DndProvider: TestWrapper,
    useDrag: () => [{ isDragging: false }, passthroughRef, () => undefined] as const,
    useDrop: () => [{ isOver: false }, passthroughRef] as const,
    useDragLayer: () => ({ isDragging: false, item: null, currentOffset: null }),
  }));

  void mock.module("react-dnd-html5-backend", () => ({
    HTML5Backend: {},
    getEmptyImage: () => null,
  }));
}

function resolveVoidResult() {
  return Promise.resolve({ success: true as const, data: undefined });
}

interface MockAgentListItemProps {
  metadata: FrontendWorkspaceMetadata;
  depth?: number;
  rowRenderMeta?: AgentRowRenderMeta;
  completedChildrenExpanded?: boolean;
  onToggleCompletedChildren?: (workspaceId: string) => void;
}

function installProjectSidebarTestDoubles() {
  spyOn(MuxLogoDarkModule, "default").mockImplementation((() => (
    <svg data-testid="mux-logo-dark" />
  )) as typeof MuxLogoDarkModule.default);
  spyOn(MuxLogoLightModule, "default").mockImplementation((() => (
    <svg data-testid="mux-logo-light" />
  )) as typeof MuxLogoLightModule.default);

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
    confirm: () => Promise.resolve(true),
  }));
  spyOn(ProjectContextModule, "useProjectContext").mockImplementation(() => ({
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
    createSection: () =>
      Promise.resolve({ success: true, data: { id: "section-1", name: "Section" } }),
    updateSection: () => resolveVoidResult(),
    removeSection: () => resolveVoidResult(),
    reorderSections: () => resolveVoidResult(),
    assignWorkspaceToSection: () => resolveVoidResult(),
    hasAnyProject: false,
    resolveNewChatProjectPath: () => null,
  }));
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
    open: () => undefined,
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
        archiveWorkspace: () => Promise.resolve({ success: true }),
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
  spyOn(ConfirmationModalModule, "ConfirmationModal").mockImplementation(
    (() => null) as unknown as typeof ConfirmationModalModule.ConfirmationModal
  );
  spyOn(ProjectDeleteConfirmationModalModule, "ProjectDeleteConfirmationModal").mockImplementation(
    (() =>
      null) as unknown as typeof ProjectDeleteConfirmationModalModule.ProjectDeleteConfirmationModal
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
  spyOn(AddSectionButtonModule, "AddSectionButton").mockImplementation(
    (() => null) as unknown as typeof AddSectionButtonModule.AddSectionButton
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
  spyOn(AgentListItemModule, "AgentListItem").mockImplementation(((
    props: MockAgentListItemProps
  ) => {
    const hasCompletedChildren =
      (props.rowRenderMeta?.hasHiddenCompletedChildren ?? false) ||
      (props.rowRenderMeta?.visibleCompletedChildrenCount ?? 0) > 0;

    return (
      <div
        data-testid={agentItemTestId(props.metadata.id)}
        data-depth={String(props.depth ?? -1)}
        data-row-kind={props.rowRenderMeta?.rowKind ?? "unknown"}
        data-completed-expanded={String(props.completedChildrenExpanded ?? false)}
      >
        <span>{props.metadata.title ?? props.metadata.name}</span>
        {hasCompletedChildren && props.onToggleCompletedChildren ? (
          <button
            type="button"
            aria-label={toggleButtonLabel(props.metadata.id)}
            onClick={() => props.onToggleCompletedChildren?.(props.metadata.id)}
          >
            Toggle completed children
          </button>
        ) : null}
      </div>
    );
  }) as unknown as typeof AgentListItemModule.AgentListItem);
}

function createWorkspace(
  id: string,
  opts?: {
    parentWorkspaceId?: string;
    taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
    title?: string;
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
    installProjectSidebarModuleMocks();
    installProjectSidebarTestDoubles();
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- module mocks must be registered before loading ProjectSidebar in bun tests.
    ({ default: ProjectSidebar } = require("./ProjectSidebar") as {
      default: typeof ProjectSidebarComponent;
    });
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
});
