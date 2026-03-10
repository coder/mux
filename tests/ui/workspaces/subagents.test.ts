/**
 * UI integration tests for sub-agent completed-child expansion behavior.
 *
 * Validates that:
 * - Completed child sub-agents (taskStatus=reported) are hidden by default.
 * - Double-clicking any workspace row enters rename mode.
 * - The overflow menu exposes Show/Hide sub-agent actions.
 * - Keyboard users can still expand/collapse completed children from the row.
 * - Expanded chevron indicators render only when the status dot is hidden.
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
import { HistoryService } from "@/node/services/historyService";
import { createMuxMessage } from "@/common/types/message";
import { getWorkspaceLastReadKey } from "@/common/constants/storage";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";

import { installDom } from "../dom";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { renderApp, type RenderedApp } from "../renderReviewPanel";

function getWorkspaceRow(container: HTMLElement, workspaceId: string): HTMLElement | null {
  return container.querySelector(
    `[data-workspace-id="${workspaceId}"][role="button"]`
  ) as HTMLElement | null;
}

function getSubagentConnector(container: HTMLElement, workspaceId: string): HTMLElement | null {
  // Find all connector elements and match by shared parent with the target workspace row.
  // This avoids fragile sibling/parent traversal assumptions.
  const connectors = container.querySelectorAll('[data-testid="subagent-connector"]');
  for (const connector of connectors) {
    const wrapper = connector.parentElement;
    if (!wrapper) continue;
    if (wrapper.querySelector(`[data-workspace-id="${workspaceId}"]`)) {
      return connector as HTMLElement;
    }
  }
  return null;
}

async function findWorkspaceActionsButton(params: {
  container: HTMLElement;
  title: string;
}): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const button = params.container.querySelector(
        `button[aria-label="Workspace actions for ${params.title}"]`
      ) as HTMLButtonElement | null;
      if (!button) {
        throw new Error(`Workspace actions button not found for ${params.title}`);
      }
      return button;
    },
    { timeout: 10_000 }
  );
}

async function findMenuItem(label: string): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const buttons = Array.from(document.querySelectorAll("button")) as HTMLButtonElement[];
      const menuItem = buttons.find((button) => button.textContent?.includes(label));
      if (!menuItem) {
        throw new Error(`Menu item not found: ${label}`);
      }
      return menuItem;
    },
    { timeout: 10_000 }
  );
}

function getAncestorTrunkSegments(container: HTMLElement, workspaceId: string): HTMLElement[] {
  const connector = getSubagentConnector(container, workspaceId);
  if (!connector) {
    return [];
  }

  const wrapper = connector.parentElement;
  if (!wrapper) {
    return [];
  }

  return Array.from(wrapper.querySelectorAll('[data-testid="ancestor-trunk"]')) as HTMLElement[];
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

  test("double-click renames parent rows and overflow menu toggles completed sub-agents", async () => {
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
      expect(parentRow.getAttribute("aria-expanded")).toBe("false");
      expect(parentRow.getAttribute("aria-keyshortcuts")).toBe("ArrowRight ArrowLeft");

      // Scenario 2: double-clicking the parent always enters rename mode.
      fireEvent.doubleClick(parentRow);

      await waitFor(
        () => {
          const editInput = renderedView.container.querySelector(
            `input[aria-label="Edit title for workspace ${parentDisplayTitle}"]`
          );
          if (!editInput) {
            throw new Error("Expected rename input to appear after double-clicking parent row");
          }
        },
        { timeout: 10_000 }
      );
      expect(getWorkspaceRow(renderedView.container, interruptedCompletedChild.id)).toBeNull();
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).toBeNull();

      const renameInput = renderedView.container.querySelector(
        `input[aria-label="Edit title for workspace ${parentDisplayTitle}"]`
      ) as HTMLInputElement | null;
      expect(renameInput).not.toBeNull();
      fireEvent.keyDown(renameInput!, { key: "Escape" });

      await waitFor(
        () => {
          const editInput = renderedView.container.querySelector(
            `input[aria-label="Edit title for workspace ${parentDisplayTitle}"]`
          );
          if (editInput) {
            throw new Error("Expected rename input to close after pressing Escape");
          }
        },
        { timeout: 10_000 }
      );

      const parentActionsButton = await findWorkspaceActionsButton({
        container: renderedView.container,
        title: parentDisplayTitle,
      });

      // Scenario 3: the overflow menu shows "Show sub-agents" while collapsed.
      fireEvent.click(parentActionsButton);
      const showSubAgentsButton = await findMenuItem("Show sub-agents");
      fireEvent.click(showSubAgentsButton);

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

      // Expanded rows with hidden status dots should show the completed-children indicator.
      expect(
        parentRow.querySelector(
          `[data-testid="completed-children-expanded-indicator-${parentWorkspace.id}"]`
        )
      ).not.toBeNull();

      // Scenario 4: the overflow menu switches to "Hide sub-agents" when expanded.
      fireEvent.click(parentActionsButton);
      const hideSubAgentsButton = await findMenuItem("Hide sub-agents");
      fireEvent.click(hideSubAgentsButton);

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

      // Scenario 5: keyboard users can still reveal and hide completed children from the row.
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

  test("expanded rows hide chevron indicator when status dot is visible", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();

    const workspaceIdsToRemove: string[] = [];
    let view: RenderedApp | undefined;
    let cleanupDom: (() => void) | undefined;

    try {
      await trustProject(env, repoPath);
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const selectedWorkspace = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Selected Agent",
        branchPrefix: "subagent-selected-anchor",
      });
      workspaceIdsToRemove.push(selectedWorkspace.id);

      const parentWorkspace = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Unread Parent Agent",
        branchPrefix: "subagent-unread-parent",
      });
      workspaceIdsToRemove.push(parentWorkspace.id);

      const reportedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Completed Child",
        branchPrefix: "subagent-unread-reported",
      });
      workspaceIdsToRemove.push(reportedChild.id);

      const completedAt = new Date().toISOString();
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        reportedAt: completedAt,
      });

      const historyService = new HistoryService(env.config);
      const appendResult = await historyService.appendToHistory(
        parentWorkspace.id,
        createMuxMessage("parent-unread-message", "user", "Mark this workspace unread")
      );
      if (!appendResult.success) {
        throw new Error(`Failed to seed unread history: ${appendResult.error}`);
      }

      cleanupDom = installDom();
      updatePersistedState(getWorkspaceLastReadKey(parentWorkspace.id), 0);

      view = renderApp({ apiClient: env.orpc, metadata: selectedWorkspace });
      await setupWorkspaceView(view, selectedWorkspace, selectedWorkspace.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;

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

      fireEvent.keyDown(parentRow, { key: "ArrowRight" });

      await waitFor(
        () => {
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (!reportedRow) {
            throw new Error("Expected completed child to be visible after expansion");
          }
        },
        { timeout: 10_000 }
      );
      expect(parentRow.getAttribute("aria-expanded")).toBe("true");
      expect(
        parentRow.querySelector(
          `[data-testid="completed-children-expanded-indicator-${parentWorkspace.id}"]`
        )
      ).toBeNull();
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
      expect(parentRow.getAttribute("aria-expanded")).toBe("false");
      const parentActionsButton = await findWorkspaceActionsButton({
        container: renderedView.container,
        title: parentDisplayTitle,
      });
      fireEvent.click(parentActionsButton);
      const showSubAgentsButton = await findMenuItem("Show sub-agents");
      fireEvent.click(showSubAgentsButton);

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

  test("renders active connector classes for running sub-agents", async () => {
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
        title: "Connector Parent",
        branchPrefix: "subagent-connector-parent",
      });
      workspaceIdsToRemove.push(parentWorkspace.id);

      const runningChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Running Child",
        branchPrefix: "subagent-connector-running",
      });
      workspaceIdsToRemove.push(runningChild.id);

      await env.config.addWorkspace(repoPath, {
        ...runningChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "running",
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
          const childRow = getWorkspaceRow(renderedView.container, runningChild.id);
          if (!childRow) {
            throw new Error("Expected running child row to be visible");
          }

          const connector = getSubagentConnector(renderedView.container, runningChild.id);
          if (!connector) {
            throw new Error("Expected running child connector to be rendered");
          }

          const activeSegments = connector.querySelectorAll("span.subagent-connector-active");
          if (activeSegments.length === 0) {
            throw new Error("Expected active connector segments for running child");
          }

          const animatedElbow = connector.querySelector("path.subagent-connector-elbow-active");
          if (!animatedElbow) {
            throw new Error("Expected animated connector elbow for running child");
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

  test("renders ancestor trunk continuity for nested rows across active and inactive branches", async () => {
    const env = await createTestEnvironment();
    const repoPath = await createTempGitRepo();

    const workspaceIdsToRemove: string[] = [];
    let view: RenderedApp | undefined;
    let cleanupDom: (() => void) | undefined;

    try {
      await trustProject(env, repoPath);
      const trunkBranch = await detectDefaultTrunkBranch(repoPath);

      const activeParent = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Active Nested Parent",
        branchPrefix: "subagent-ancestor-active-parent",
      });
      workspaceIdsToRemove.push(activeParent.id);

      const activeLowerSibling = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Active Lower Sibling",
        branchPrefix: "subagent-ancestor-active-sibling",
      });
      workspaceIdsToRemove.push(activeLowerSibling.id);

      const activeNestedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Active Nested Child",
        branchPrefix: "subagent-ancestor-active-child",
      });
      workspaceIdsToRemove.push(activeNestedChild.id);

      const activeGrandchild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Active Nested Grandchild",
        branchPrefix: "subagent-ancestor-active-grandchild",
      });
      workspaceIdsToRemove.push(activeGrandchild.id);

      const inactiveParent = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Inactive Nested Parent",
        branchPrefix: "subagent-ancestor-inactive-parent",
      });
      workspaceIdsToRemove.push(inactiveParent.id);

      const inactiveLowerSibling = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Inactive Lower Sibling",
        branchPrefix: "subagent-ancestor-inactive-sibling",
      });
      workspaceIdsToRemove.push(inactiveLowerSibling.id);

      const inactiveNestedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Inactive Nested Child",
        branchPrefix: "subagent-ancestor-inactive-child",
      });
      workspaceIdsToRemove.push(inactiveNestedChild.id);

      const inactiveGrandchild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Inactive Nested Grandchild",
        branchPrefix: "subagent-ancestor-inactive-grandchild",
      });
      workspaceIdsToRemove.push(inactiveGrandchild.id);

      await env.config.addWorkspace(repoPath, {
        ...activeNestedChild,
        parentWorkspaceId: activeParent.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...activeGrandchild,
        parentWorkspaceId: activeNestedChild.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...activeLowerSibling,
        parentWorkspaceId: activeParent.id,
        taskStatus: "running",
      });

      await env.config.addWorkspace(repoPath, {
        ...inactiveNestedChild,
        parentWorkspaceId: inactiveParent.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...inactiveGrandchild,
        parentWorkspaceId: inactiveNestedChild.id,
        taskStatus: "queued",
      });
      await env.config.addWorkspace(repoPath, {
        ...inactiveLowerSibling,
        parentWorkspaceId: inactiveParent.id,
        taskStatus: "queued",
      });

      cleanupDom = installDom();
      view = renderApp({ apiClient: env.orpc, metadata: activeParent });
      await setupWorkspaceView(view, activeParent, activeParent.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;

      await waitFor(
        () => {
          if (!getWorkspaceRow(renderedView.container, activeGrandchild.id)) {
            throw new Error("Expected active nested grandchild row to be visible");
          }
          if (!getWorkspaceRow(renderedView.container, inactiveGrandchild.id)) {
            throw new Error("Expected inactive nested grandchild row to be visible");
          }
        },
        { timeout: 10_000 }
      );

      const activeAncestorTrunks = getAncestorTrunkSegments(
        renderedView.container,
        activeGrandchild.id
      );
      expect(activeAncestorTrunks.length).toBeGreaterThan(0);
      expect(activeAncestorTrunks[0]?.getAttribute("data-trunk-active")).toBe("true");

      const inactiveAncestorTrunks = getAncestorTrunkSegments(
        renderedView.container,
        inactiveGrandchild.id
      );
      expect(inactiveAncestorTrunks.length).toBeGreaterThan(0);
      expect(inactiveAncestorTrunks[0]?.getAttribute("data-trunk-active")).toBe("false");

      const peerAncestorTrunks = getAncestorTrunkSegments(
        renderedView.container,
        activeLowerSibling.id
      );
      expect(peerAncestorTrunks).toHaveLength(0);
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

  test("does not render active connector classes for non-running sub-agents", async () => {
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
        title: "Connector Parent",
        branchPrefix: "subagent-connector-parent-queued",
      });
      workspaceIdsToRemove.push(parentWorkspace.id);

      const queuedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Queued Child",
        branchPrefix: "subagent-connector-queued",
      });
      workspaceIdsToRemove.push(queuedChild.id);

      await env.config.addWorkspace(repoPath, {
        ...queuedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "queued",
      });

      cleanupDom = installDom();
      view = renderApp({ apiClient: env.orpc, metadata: parentWorkspace });
      await setupWorkspaceView(view, parentWorkspace, parentWorkspace.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;

      // Wait for the queued child row to appear in the sidebar.
      await waitFor(
        () => {
          const childRow = getWorkspaceRow(renderedView.container, queuedChild.id);
          if (!childRow) {
            throw new Error("Expected queued child row to be visible");
          }
        },
        { timeout: 10_000 }
      );

      // A queued sub-agent should NOT have active connector segments
      // (only "running" status triggers the active animation).
      const activeSegments = renderedView.container.querySelectorAll(
        "span.subagent-connector-active"
      );
      expect(activeSegments.length).toBe(0);

      const animatedElbows = renderedView.container.querySelectorAll(
        "path.subagent-connector-elbow-active"
      );
      expect(animatedElbows.length).toBe(0);
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
