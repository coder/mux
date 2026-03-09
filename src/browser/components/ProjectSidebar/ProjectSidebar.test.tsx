import "../../../../tests/ui/dom";

import { type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import { EXPANDED_PROJECTS_KEY } from "@/common/constants/storage";
import { MULTI_PROJECT_SIDEBAR_SECTION_ID } from "@/common/constants/multiProject";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { AgentRowRenderMeta } from "@/browser/utils/ui/workspaceFiltering";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

const agentItemTestId = (workspaceId: string) => `agent-item-${workspaceId}`;
const toggleButtonLabel = (workspaceId: string) => `toggle-completed-${workspaceId}`;

function TestWrapper(props: PropsWithChildren) {
  return <>{props.children}</>;
}

void mock.module("react-dnd", () => {
  const passthroughRef = <T,>(value: T): T => value;

  return {
    DndProvider: TestWrapper,
    useDrag: () => [{ isDragging: false }, passthroughRef, () => undefined] as const,
    useDrop: () => [{ isOver: false }, passthroughRef] as const,
    useDragLayer: () => ({
      isDragging: false,
      item: null,
      currentOffset: null,
    }),
  };
});

void mock.module("react-dnd-html5-backend", () => ({
  HTML5Backend: {},
  getEmptyImage: () => new Image(),
}));

void mock.module("@/browser/assets/logos/mux-logo-dark.svg?react", () => ({
  __esModule: true,
  default: () => <svg data-testid="mux-logo-dark" />,
}));

void mock.module("@/browser/assets/logos/mux-logo-light.svg?react", () => ({
  __esModule: true,
  default: () => <svg data-testid="mux-logo-light" />,
}));

void mock.module("@/browser/hooks/useDesktopTitlebar", () => ({
  isDesktopMode: () => false,
}));

void mock.module("@/browser/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: "light" }),
}));

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({ api: null }),
}));

void mock.module("@/browser/contexts/ConfirmDialogContext", () => ({
  useConfirmDialog: () => ({ confirm: () => Promise.resolve(true) }),
}));

void mock.module("@/browser/contexts/ProjectContext", () => ({
  useProjectContext: () => ({
    userProjects: new Map(),
    openProjectCreateModal: () => undefined,
    removeProject: () => Promise.resolve(),
    createSection: () => Promise.resolve(),
    updateSection: () => Promise.resolve(),
    removeSection: () => Promise.resolve(),
    reorderSections: () => Promise.resolve(),
    assignWorkspaceToSection: () => Promise.resolve(),
  }),
}));

void mock.module("@/browser/contexts/RouterContext", () => ({
  useRouter: () => ({ navigateToProject: () => undefined }),
}));

void mock.module("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({ open: () => undefined }),
}));

void mock.module("@/browser/contexts/WorkspaceContext", () => ({
  useWorkspaceActions: () => ({
    selectedWorkspace: null,
    setSelectedWorkspace: () => undefined,
    archiveWorkspace: () => Promise.resolve(),
    removeWorkspace: () => Promise.resolve(),
    updateWorkspaceTitle: () => Promise.resolve(),
    refreshWorkspaceMetadata: () => Promise.resolve(),
    pendingNewWorkspaceProject: null,
    pendingNewWorkspaceDraftId: null,
    workspaceDraftsByProject: {},
    workspaceDraftPromotionsByProject: {},
    createWorkspaceDraft: () => undefined,
    openWorkspaceDraft: () => undefined,
    deleteWorkspaceDraft: () => undefined,
  }),
}));

void mock.module("@/browser/contexts/WorkspaceTitleEditContext", () => ({
  TitleEditProvider: TestWrapper,
  useTitleEdit: () => ({
    requestEdit: () => undefined,
    wrapGenerateTitle: (_workspaceId: string, fn: () => Promise<unknown>) => fn(),
  }),
}));

void mock.module("@/browser/hooks/useWorkspaceFallbackModel", () => ({
  useWorkspaceFallbackModel: () => "openai:gpt-5.4",
}));

void mock.module("@/browser/hooks/useWorkspaceUnread", () => ({
  useWorkspaceUnread: () => ({ isUnread: false }),
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useWorkspaceStoreRaw: () => ({ getWorkspaceMetadata: () => null }),
}));

void mock.module("../Tooltip/Tooltip", () => ({
  Tooltip: TestWrapper,
  TooltipTrigger: TestWrapper,
  TooltipContent: () => null,
}));

void mock.module("../SidebarCollapseButton/SidebarCollapseButton", () => ({
  SidebarCollapseButton: () => <button type="button">toggle sidebar</button>,
}));

void mock.module("../ConfirmationModal/ConfirmationModal", () => ({
  ConfirmationModal: () => null,
}));

void mock.module("../ProjectDeleteConfirmationModal/ProjectDeleteConfirmationModal", () => ({
  ProjectDeleteConfirmationModal: () => null,
}));

void mock.module("../WorkspaceStatusIndicator/WorkspaceStatusIndicator", () => ({
  WorkspaceStatusIndicator: () => <div data-testid="workspace-status-indicator" />,
}));

void mock.module("../PopoverError/PopoverError", () => ({
  PopoverError: () => null,
}));

void mock.module("../SectionHeader/SectionHeader", () => ({
  SectionHeader: () => null,
}));

void mock.module("../AddSectionButton/AddSectionButton", () => ({
  AddSectionButton: () => null,
}));

void mock.module("../WorkspaceSectionDropZone/WorkspaceSectionDropZone", () => ({
  WorkspaceSectionDropZone: TestWrapper,
}));

void mock.module("../WorkspaceDragLayer/WorkspaceDragLayer", () => ({
  WorkspaceDragLayer: () => null,
}));

void mock.module("../SectionDragLayer/SectionDragLayer", () => ({
  SectionDragLayer: () => null,
}));

void mock.module("../DraggableSection/DraggableSection", () => ({
  DraggableSection: TestWrapper,
}));

interface MockAgentListItemProps {
  metadata: FrontendWorkspaceMetadata;
  depth?: number;
  rowRenderMeta?: AgentRowRenderMeta;
  completedChildrenExpanded?: boolean;
  onToggleCompletedChildren?: (workspaceId: string) => void;
}

void mock.module("../AgentListItem/AgentListItem", () => ({
  AgentListItem: (props: MockAgentListItemProps) => {
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
  },
}));

import ProjectSidebar from "./ProjectSidebar";

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
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
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
