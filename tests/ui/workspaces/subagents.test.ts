/**
 * UI integration tests for sub-agent completed-child expansion behavior.
 *
 * Validates that:
 * - Completed child sub-agents (taskStatus=reported) are hidden by default.
 * - Double-clicking the parent row reveals completed children.
 * - Keyboard users can still expand/collapse completed children from the row.
 * - Double-clicking a workspace without completed children still enters rename mode.
 * - Double-clicking again hides completed children.
 */

import "../dom";

import { fireEvent, waitFor } from "@testing-library/react";

import { cleanupTestEnvironment, createTestEnvironment, preloadTestModules } from "../../ipc/setup";
import {
  cleanupTempGitRepo,
  createTempGitRepo,
  generateBranchName,
  trustProject,
} from "../../ipc/helpers";

import { detectDefaultTrunkBranch } from "@/node/git";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";

function getWorkspaceRow(container: HTMLElement, workspaceId: string): HTMLElement | null {
  return container.querySelector(
    `[data-workspace-id="${workspaceId}"][role="button"]`
  ) as HTMLElement | null;
}

async function createWorkspaceWithTitle(params: {
  projectPath: string;
  trunkBranch: string;
  title: string;
  branchPrefix: string;
  env: Awaited<ReturnType<typeof createTestEnvironment>>;
}): Promise<FrontendWorkspaceMetadata> {
  const result = await params.env.orpc.workspace.create({
    projectPath: params.projectPath,
    branchName: generateBranchName(params.branchPrefix),
    trunkBranch: params.trunkBranch,
    title: params.title,
  });

  if (!result.success) {
    throw new Error(`Failed to create workspace (${params.title}): ${result.error}`);
  }

  return result.metadata;
}

describe("Workspace sidebar completed sub-agent expansion (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("completed children with stale interrupted status stay hidden by default and toggle with parent expansion", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();

    const workspaceIdsToRemove: string[] = [];
    let view: RenderedApp | undefined;
    let cleanupDom: (() => void) | undefined;

    try {
      await trustProject(env, repoPath);
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const parentWorkspace = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Parent Agent",
        branchPrefix: "subagent-parent",
      });
      workspaceIdsToRemove.push(parentWorkspace.id);

      const activeChildOne = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Active Child One",
        branchPrefix: "subagent-active-1",
      });
      workspaceIdsToRemove.push(activeChildOne.id);

      const activeChildTwo = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Active Child Two",
        branchPrefix: "subagent-active-2",
      });
      workspaceIdsToRemove.push(activeChildTwo.id);

      const interruptedCompletedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Interrupted Completed Child",
        branchPrefix: "subagent-interrupted-completed",
      });
      workspaceIdsToRemove.push(interruptedCompletedChild.id);

      const reportedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Reported Child",
        branchPrefix: "subagent-reported",
      });
      workspaceIdsToRemove.push(reportedChild.id);

      // Seed child metadata to simulate parent/sub-agent hierarchy with mixed statuses.
      await env.config.addWorkspace(repoPath, {
        ...activeChildOne,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "running",
      });
      await env.config.addWorkspace(repoPath, {
        ...activeChildTwo,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "queued",
      });
      const completedAt = new Date().toISOString();
      await env.config.addWorkspace(repoPath, {
        ...interruptedCompletedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "interrupted",
        reportedAt: completedAt,
      });
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        reportedAt: completedAt,
      });

      cleanupDom = installDom();
      view = renderApp({ apiClient: env.orpc, metadata: parentWorkspace });

      await setupWorkspaceView(view, parentWorkspace, parentWorkspace.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;

      // Scenario 1: active children are visible, while both completed children stay hidden.
      await waitFor(
        () => {
          if (!getWorkspaceRow(renderedView.container, activeChildOne.id)) {
            throw new Error("Expected first active child to be visible");
          }
          if (!getWorkspaceRow(renderedView.container, activeChildTwo.id)) {
            throw new Error("Expected second active child to be visible");
          }
        },
        { timeout: 10_000 }
      );
      expect(getWorkspaceRow(renderedView.container, interruptedCompletedChild.id)).toBeNull();
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).toBeNull();

      const parentDisplayTitle = parentWorkspace.title ?? parentWorkspace.name;
      const parentRow = await waitFor(
        () => {
          const row = getWorkspaceRow(renderedView.container, parentWorkspace.id);
          if (!row) {
            throw new Error("Parent workspace row not found");
          }
          return row;
        },
        { timeout: 10_000 }
      );
      expect(
        renderedView.container.querySelector(
          `button[aria-label="Expand completed sub-agents for ${parentDisplayTitle}"]`
        )
      ).toBeNull();
      expect(
        renderedView.container.querySelector(
          `button[aria-label="Collapse completed sub-agents for ${parentDisplayTitle}"]`
        )
      ).toBeNull();
      expect(parentRow.getAttribute("aria-expanded")).toBe("false");
      expect(parentRow.getAttribute("aria-keyshortcuts")).toBe("ArrowRight ArrowLeft");

      // Scenario 2: double-clicking the parent reveals both completed children.
      fireEvent.doubleClick(parentRow);

      await waitFor(
        () => {
          const interruptedCompletedRow = getWorkspaceRow(
            renderedView.container,
            interruptedCompletedChild.id
          );
          if (!interruptedCompletedRow) {
            throw new Error("Expected interrupted completed child to be visible after expansion");
          }
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (!reportedRow) {
            throw new Error("Expected reported child to be visible after expansion");
          }
        },
        { timeout: 10_000 }
      );
      expect(parentRow.getAttribute("aria-expanded")).toBe("true");

      const parentActionsButton = renderedView.container.querySelector(
        `button[aria-label="Workspace actions for ${parentDisplayTitle}"]`
      ) as HTMLButtonElement | null;
      expect(parentActionsButton).not.toBeNull();
      const parentActionsIcon = parentActionsButton?.querySelector("svg");
      expect(parentActionsIcon).not.toBeNull();
      fireEvent.doubleClick(parentActionsIcon!);
      expect(parentRow.getAttribute("aria-expanded")).toBe("true");
      expect(getWorkspaceRow(renderedView.container, interruptedCompletedChild.id)).not.toBeNull();
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).not.toBeNull();
      expect(
        renderedView.container.querySelector(
          `input[aria-label="Edit title for workspace ${parentDisplayTitle}"]`
        )
      ).toBeNull();

      fireEvent.keyDown(parentActionsButton!, { key: "ArrowLeft" });
      expect(parentRow.getAttribute("aria-expanded")).toBe("true");
      expect(getWorkspaceRow(renderedView.container, interruptedCompletedChild.id)).not.toBeNull();
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).not.toBeNull();

      // Scenario 3: keyboard users can still reveal and hide completed children from the row.
      fireEvent.keyDown(parentRow, { key: "ArrowLeft" });

      await waitFor(
        () => {
          const interruptedCompletedRow = getWorkspaceRow(
            renderedView.container,
            interruptedCompletedChild.id
          );
          if (interruptedCompletedRow) {
            throw new Error(
              "Expected interrupted completed child to be hidden after keyboard collapsing"
            );
          }
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (reportedRow) {
            throw new Error("Expected reported child to be hidden after keyboard collapsing");
          }
        },
        { timeout: 10_000 }
      );
      expect(parentRow.getAttribute("aria-expanded")).toBe("false");

      fireEvent.keyDown(parentRow, { key: "ArrowRight" });

      await waitFor(
        () => {
          const interruptedCompletedRow = getWorkspaceRow(
            renderedView.container,
            interruptedCompletedChild.id
          );
          if (!interruptedCompletedRow) {
            throw new Error(
              "Expected interrupted completed child to be visible after keyboard expansion"
            );
          }
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (!reportedRow) {
            throw new Error("Expected reported child to be visible after keyboard expansion");
          }
        },
        { timeout: 10_000 }
      );
      expect(parentRow.getAttribute("aria-expanded")).toBe("true");

      // Scenario 4: double-clicking the parent again hides both completed children.
      fireEvent.doubleClick(parentRow);

      await waitFor(
        () => {
          const interruptedCompletedRow = getWorkspaceRow(
            renderedView.container,
            interruptedCompletedChild.id
          );
          if (interruptedCompletedRow) {
            throw new Error("Expected interrupted completed child to be hidden after collapsing");
          }
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (reportedRow) {
            throw new Error("Expected reported child to be hidden after collapsing");
          }
        },
        { timeout: 10_000 }
      );
      expect(parentRow.getAttribute("aria-expanded")).toBe("false");
    } finally {
      if (view && cleanupDom) {
        await cleanupView(view, cleanupDom);
      } else if (cleanupDom) {
        cleanupDom();
      }

      for (const workspaceId of workspaceIdsToRemove.reverse()) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort cleanup.
        }
      }

      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 90_000);

  test("double-clicking a workspace without completed children still enters rename mode", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();

    const workspaceIdsToRemove: string[] = [];
    let view: RenderedApp | undefined;
    let cleanupDom: (() => void) | undefined;

    try {
      await trustProject(env, repoPath);
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const workspace = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Standalone Agent",
        branchPrefix: "subagent-rename-fallback",
      });
      workspaceIdsToRemove.push(workspace.id);

      cleanupDom = installDom();
      view = renderApp({ apiClient: env.orpc, metadata: workspace });
      await setupWorkspaceView(view, workspace, workspace.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;
      const displayTitle = workspace.title ?? workspace.name;
      const row = await waitFor(
        () => {
          const nextRow = getWorkspaceRow(renderedView.container, workspace.id);
          if (!nextRow) {
            throw new Error("Workspace row not found");
          }
          return nextRow;
        },
        { timeout: 10_000 }
      );
      expect(row.getAttribute("aria-expanded")).toBeNull();

      fireEvent.doubleClick(row);

      await waitFor(
        () => {
          const editInput = renderedView.container.querySelector(
            `input[aria-label="Edit title for workspace ${displayTitle}"]`
          );
          if (!editInput) {
            throw new Error("Expected rename input to appear after double-clicking a leaf row");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      if (view && cleanupDom) {
        await cleanupView(view, cleanupDom);
      } else if (cleanupDom) {
        cleanupDom();
      }

      for (const workspaceId of workspaceIdsToRemove.reverse()) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort cleanup.
        }
      }

      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 90_000);

  test("expanding completed children reveals old reported rows without expanding age tiers", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();

    const workspaceIdsToRemove: string[] = [];
    let view: RenderedApp | undefined;
    let cleanupDom: (() => void) | undefined;

    try {
      await trustProject(env, repoPath);
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const parentWorkspace = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Parent Agent",
        branchPrefix: "subagent-old-parent",
      });
      workspaceIdsToRemove.push(parentWorkspace.id);

      const activeChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Active Child",
        branchPrefix: "subagent-old-active",
      });
      workspaceIdsToRemove.push(activeChild.id);

      const reportedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Old Reported Child",
        branchPrefix: "subagent-old-reported",
      });
      workspaceIdsToRemove.push(reportedChild.id);

      const reportedChildTimestamp = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();

      await env.config.addWorkspace(repoPath, {
        ...activeChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "running",
      });
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        createdAt: reportedChildTimestamp,
        reportedAt: reportedChildTimestamp,
      });

      cleanupDom = installDom();
      view = renderApp({ apiClient: env.orpc, metadata: parentWorkspace });
      await setupWorkspaceView(view, parentWorkspace, parentWorkspace.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;

      await waitFor(
        () => {
          if (!getWorkspaceRow(renderedView.container, activeChild.id)) {
            throw new Error("Expected active child to be visible");
          }
        },
        { timeout: 10_000 }
      );
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).toBeNull();

      const parentDisplayTitle = parentWorkspace.title ?? parentWorkspace.name;
      const parentRow = await waitFor(
        () => {
          const row = getWorkspaceRow(renderedView.container, parentWorkspace.id);
          if (!row) {
            throw new Error("Parent workspace row not found");
          }
          return row;
        },
        { timeout: 10_000 }
      );
      expect(
        renderedView.container.querySelector(
          `button[aria-label="Expand completed sub-agents for ${parentDisplayTitle}"]`
        )
      ).toBeNull();
      expect(parentRow.getAttribute("aria-expanded")).toBe("false");
      fireEvent.doubleClick(parentRow);

      await waitFor(
        () => {
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (!reportedRow) {
            throw new Error("Expected old reported child to be visible after expansion");
          }
        },
        { timeout: 10_000 }
      );
      expect(parentRow.getAttribute("aria-expanded")).toBe("true");

      const ageTierExpandButton = renderedView.container.querySelector(
        'button[aria-label^="Expand workspaces older than "]'
      );
      expect(ageTierExpandButton).toBeNull();
    } finally {
      if (view && cleanupDom) {
        await cleanupView(view, cleanupDom);
      } else if (cleanupDom) {
        cleanupDom();
      }

      for (const workspaceId of workspaceIdsToRemove.reverse()) {
        try {
          await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
        } catch {
          // Best effort cleanup.
        }
      }

      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 90_000);
});
