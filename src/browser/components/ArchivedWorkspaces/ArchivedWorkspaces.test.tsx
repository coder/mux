import "../../../../tests/ui/dom";

import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import type { APIClient } from "@/browser/contexts/API";
import type * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as TooltipModule from "@/browser/components/Tooltip/Tooltip";
import * as ForceDeleteModalModule from "@/browser/components/ForceDeleteModal/ForceDeleteModal";
import * as RuntimeBadgeModule from "@/browser/components/RuntimeBadge/RuntimeBadge";
import * as SkeletonModule from "@/browser/components/Skeleton/Skeleton";
import * as OptimisticBatchLRUModule from "@/browser/hooks/useOptimisticBatchLRU";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { ArchivedWorkspaces } from "./ArchivedWorkspaces";

function installTestDoubles() {
  // Re-register the full WorkspaceStore mock before each test to avoid Bun's global mock leakage.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const actualWorkspaceStore =
    require("@/browser/stores/WorkspaceStore?real=1") as typeof WorkspaceStoreModule;
  /* eslint-enable @typescript-eslint/no-require-imports */

  void mock.module("@/browser/stores/WorkspaceStore", () => ({
    ...actualWorkspaceStore,
  }));
}

function createWorkspace(overrides: Partial<FrontendWorkspaceMetadata>): FrontendWorkspaceMetadata {
  return {
    id: overrides.id ?? "ws-1",
    name: overrides.name ?? "workspace-1",
    projectName: overrides.projectName ?? "project",
    projectPath: overrides.projectPath ?? "/tmp/project",
    createdAt: overrides.createdAt ?? "2026-03-01T00:00:00.000Z",
    archivedAt: overrides.archivedAt ?? "2026-03-02T00:00:00.000Z",
    runtimeConfig: overrides.runtimeConfig ?? { type: "worktree", srcBaseDir: "/tmp/src" },
    namedWorkspacePath: overrides.namedWorkspacePath ?? "/tmp/src/project/workspace-1",
    ...overrides,
  };
}

let cleanupDom: (() => void) | null = null;

describe("ArchivedWorkspaces", () => {
  const deleteWorktreeMock = mock(() => Promise.resolve({ success: true }));
  const getSessionUsageBatchMock = mock(() => Promise.resolve({}));
  const unarchiveWorkspaceMock = mock(() => Promise.resolve({ success: true }));
  const removeWorkspaceMock = mock(() => Promise.resolve({ success: true }));
  const setSelectedWorkspaceMock = mock(() => undefined);
  const onWorkspacesChangedMock = mock(() => undefined);

  beforeEach(() => {
    installTestDoubles();
    cleanupDom = installDom();
    deleteWorktreeMock.mockClear();
    getSessionUsageBatchMock.mockClear();
    unarchiveWorkspaceMock.mockClear();
    removeWorkspaceMock.mockClear();
    setSelectedWorkspaceMock.mockClear();
    onWorkspacesChangedMock.mockClear();
    localStorage.clear();

    spyOn(APIModule, "useAPI").mockImplementation(() => ({
      api: {
        workspace: {
          deleteWorktree: deleteWorktreeMock,
          getSessionUsageBatch: getSessionUsageBatchMock,
        },
      } as unknown as APIClient,
      status: "connected",
      error: null,
      authenticate: () => undefined,
      retry: () => undefined,
    }));

    spyOn(WorkspaceContextModule, "useWorkspaceContext").mockImplementation(
      () =>
        ({
          unarchiveWorkspace: unarchiveWorkspaceMock,
          removeWorkspace: removeWorkspaceMock,
          setSelectedWorkspace: setSelectedWorkspaceMock,
        }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceContext>
    );

    spyOn(TooltipModule, "Tooltip").mockImplementation(((props: { children: ReactNode }) => (
      <>{props.children}</>
    )) as unknown as typeof TooltipModule.Tooltip);
    spyOn(TooltipModule, "TooltipTrigger").mockImplementation(((props: { children: ReactNode }) => (
      <>{props.children}</>
    )) as unknown as typeof TooltipModule.TooltipTrigger);
    spyOn(TooltipModule, "TooltipContent").mockImplementation(((props: { children: ReactNode }) => (
      <>{props.children}</>
    )) as unknown as typeof TooltipModule.TooltipContent);
    spyOn(ForceDeleteModalModule, "ForceDeleteModal").mockImplementation(
      (() => null) as unknown as typeof ForceDeleteModalModule.ForceDeleteModal
    );
    spyOn(RuntimeBadgeModule, "RuntimeBadge").mockImplementation((() => (
      <span data-testid="runtime-badge" />
    )) as unknown as typeof RuntimeBadgeModule.RuntimeBadge);
    spyOn(SkeletonModule, "Skeleton").mockImplementation((() => (
      <div data-testid="skeleton" />
    )) as unknown as typeof SkeletonModule.Skeleton);
    spyOn(OptimisticBatchLRUModule, "useOptimisticBatchLRU").mockImplementation((() => ({
      values: {},
      status: "success",
    })) as unknown as typeof OptimisticBatchLRUModule.useOptimisticBatchLRU);
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows an error when restoring an archived workspace fails", async () => {
    unarchiveWorkspaceMock.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "Restore failed" })
    );
    const workspace = createWorkspace({
      id: "ws-restore-error",
      name: "restore-error",
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    const restoreButton = await waitFor(() =>
      view.getByLabelText(`Restore workspace ${workspace.name}`)
    );
    fireEvent.click(restoreButton);

    await waitFor(() => {
      expect(unarchiveWorkspaceMock).toHaveBeenCalledWith(workspace.id);
    });
    expect(onWorkspacesChangedMock).not.toHaveBeenCalled();

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("Failed to restore workspace");
    expect(alert.textContent).toContain("Restore failed");
  });

  test("shows delete worktree for archived worktree workspaces and calls the API", async () => {
    const workspace = createWorkspace({
      id: "ws-worktree",
      name: "worktree-ws",
      transcriptOnly: false,
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    const deleteWorktreeButton = await waitFor(() =>
      view.getByLabelText(`Remove local checkout for workspace ${workspace.name}`)
    );
    fireEvent.click(deleteWorktreeButton);

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenCalledWith({ workspaceId: workspace.id });
    });
    expect(onWorkspacesChangedMock).toHaveBeenCalledTimes(1);
  });

  test("shows an error when single-workspace delete worktree fails", async () => {
    deleteWorktreeMock.mockImplementationOnce(() =>
      Promise.resolve({ success: false, error: "Permission denied" })
    );
    const workspace = createWorkspace({
      id: "ws-worktree-error",
      name: "worktree-error",
      transcriptOnly: false,
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={workspace.projectPath}
        projectName={workspace.projectName}
        workspaces={[workspace]}
        onWorkspacesChanged={onWorkspacesChangedMock}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    const deleteWorktreeButton = await waitFor(() =>
      view.getByLabelText(`Remove local checkout for workspace ${workspace.name}`)
    );
    fireEvent.click(deleteWorktreeButton);

    await waitFor(() => {
      expect(deleteWorktreeMock).toHaveBeenCalledWith({ workspaceId: workspace.id });
    });
    expect(onWorkspacesChangedMock).not.toHaveBeenCalled();

    const alert = await waitFor(() => view.getByRole("alert"));
    expect(alert.textContent).toContain("Failed to delete managed worktree");
    expect(alert.textContent).toContain("Permission denied");
  });

  test("hides delete worktree for transcript-only and non-worktree archived workspaces", async () => {
    const transcriptOnlyWorkspace = createWorkspace({
      id: "ws-transcript-only",
      name: "transcript-only",
      transcriptOnly: true,
    });
    const localWorkspace = createWorkspace({
      id: "ws-local",
      name: "local-ws",
      runtimeConfig: { type: "local" },
      transcriptOnly: false,
    });

    const view = render(
      <ArchivedWorkspaces
        projectPath={transcriptOnlyWorkspace.projectPath}
        projectName={transcriptOnlyWorkspace.projectName}
        workspaces={[transcriptOnlyWorkspace, localWorkspace]}
      />
    );

    fireEvent.click(view.getByLabelText("Expand archived workspaces"));

    await waitFor(() => {
      expect(
        view.queryByLabelText(`Remove local checkout for workspace ${transcriptOnlyWorkspace.name}`)
      ).toBeNull();
      expect(
        view.queryByLabelText(`Remove local checkout for workspace ${localWorkspace.name}`)
      ).toBeNull();
    });
  });
});
