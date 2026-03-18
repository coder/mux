import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type * as ReactDndModuleType from "react-dnd";
import type * as ReactDndHtml5BackendModuleType from "react-dnd-html5-backend";
import * as APIModule from "@/browser/contexts/API";
import * as TelemetryEnabledContextModule from "@/browser/contexts/TelemetryEnabledContext";
import * as WorkspaceTitleEditContextModule from "@/browser/contexts/WorkspaceTitleEditContext";
import * as ContextMenuPositionModule from "@/browser/hooks/useContextMenuPosition";
import * as WorkspaceFallbackModelModule from "@/browser/hooks/useWorkspaceFallbackModel";
import * as WorkspaceUnreadModule from "@/browser/hooks/useWorkspaceUnread";
import * as RuntimeStatusStoreModule from "@/browser/stores/RuntimeStatusStore";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { AgentListItem as AgentListItemComponent } from "./AgentListItem";

let ReactDndModule!: typeof ReactDndModuleType;
let ReactDndHtml5BackendModule!: typeof ReactDndHtml5BackendModuleType;
let AgentListItem!: typeof AgentListItemComponent;

const TEST_WORKSPACE_ID = "workspace-archiving";
const TEST_WORKSPACE_TITLE = "Archiving Workspace";

function createMetadata(): FrontendWorkspaceMetadata {
  return {
    id: TEST_WORKSPACE_ID,
    name: "archiving-workspace",
    title: TEST_WORKSPACE_TITLE,
    projectName: "Project",
    projectPath: "/tmp/project",
    namedWorkspacePath: "/tmp/project/archiving-workspace",
    runtimeConfig: { type: "local" },
    createdAt: new Date().toISOString(),
  };
}

function installAgentListItemTestDoubles() {
  const passthroughRef = <T,>(value: T): T => value;

  spyOn(ReactDndModule, "useDrag").mockImplementation(
    (() =>
      [
        { isDragging: false },
        passthroughRef,
        () => undefined,
      ] as const) as unknown as typeof ReactDndModule.useDrag
  );
  spyOn(ReactDndHtml5BackendModule, "getEmptyImage").mockImplementation(() => new Image());
  spyOn(APIModule, "useAPI").mockImplementation(() => ({
    api: null,
    status: "error",
    error: "API unavailable",
    authenticate: () => undefined,
    retry: () => undefined,
  }));
  spyOn(TelemetryEnabledContextModule, "useLinkSharingEnabled").mockImplementation(() => false);
  spyOn(WorkspaceTitleEditContextModule, "useTitleEdit").mockImplementation(() => ({
    editingWorkspaceId: null,
    requestEdit: () => true,
    confirmEdit: () => Promise.resolve({ success: true }),
    cancelEdit: () => undefined,
    generatingTitleWorkspaceIds: new Set<string>(),
    wrapGenerateTitle: () => undefined,
  }));
  spyOn(ContextMenuPositionModule, "useContextMenuPosition").mockImplementation(() => ({
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
  }));
  spyOn(WorkspaceUnreadModule, "useWorkspaceUnread").mockImplementation(() => ({
    isUnread: false,
    lastReadTimestamp: null,
    recencyTimestamp: null,
  }));
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatus").mockImplementation(() => null);
  spyOn(WorkspaceFallbackModelModule, "useWorkspaceFallbackModel").mockImplementation(
    () => "claude-sonnet-4-5"
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(() => ({
    canInterrupt: false,
    isStarting: false,
    awaitingUserQuestion: false,
    lastAbortReason: null,
    currentModel: null,
    recencyTimestamp: null,
    loadedSkills: [],
    skillLoadErrors: [],
    agentStatus: undefined,
    terminalActiveCount: 0,
    terminalSessionCount: 0,
  }));
}

describe("AgentListItem archiving layout", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ReactDndModule = require("react-dnd") as typeof ReactDndModuleType;
    ReactDndHtml5BackendModule =
      require("react-dnd-html5-backend") as typeof ReactDndHtml5BackendModuleType;
    ({ AgentListItem } = require("./AgentListItem") as {
      AgentListItem: typeof AgentListItemComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
    installAgentListItemTestDoubles();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
    mock.restore();
  });

  test("keeps archiving feedback inline instead of rendering a secondary status row", () => {
    const metadata = createMetadata();
    const view = render(
      <AgentListItem
        metadata={metadata}
        projectPath={metadata.projectPath}
        projectName={metadata.projectName}
        isSelected={false}
        isArchiving
        onSelectWorkspace={() => undefined}
        onForkWorkspace={() => Promise.resolve()}
        onArchiveWorkspace={() => Promise.resolve()}
        onCancelCreation={() => Promise.resolve()}
      />
    );

    const row = view.getByRole("button", {
      name: `Archiving workspace ${TEST_WORKSPACE_TITLE}`,
    });
    const rowView = within(row);

    expect(
      rowView.getByTestId(`workspace-inline-archiving-status-${TEST_WORKSPACE_ID}`)
    ).toBeTruthy();
    expect(rowView.queryByTestId(`workspace-secondary-row-${TEST_WORKSPACE_ID}`)).toBeNull();
  });
});
