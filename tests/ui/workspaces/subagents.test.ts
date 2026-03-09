/**
 * UI integration tests for sub-agent completed-child expansion behavior.
 *
 * Validates that:
 * - Completed child sub-agents (taskStatus=reported) are hidden by default.
 * - Toggling the parent row's expansion control reveals completed children.
 * - Toggling again hides completed children.
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
  return container.querySelector(`[data-workspace-id="${workspaceId}"]`) as HTMLElement | null;
}

function getSubagentConnector(container: HTMLElement, workspaceId: string): HTMLElement | null {
  const workspaceRow = getWorkspaceRow(container, workspaceId);
  if (!workspaceRow) {
    return null;
  }

  // Sub-agent connectors are rendered as a sibling wrapper around the row, so
  // this lookup must walk to the sibling/parent wrapper instead of querying
  // within the row itself.
  const siblingConnector = workspaceRow.previousElementSibling;
  if (
    siblingConnector instanceof HTMLElement &&
    siblingConnector.getAttribute("data-testid") === "subagent-connector"
  ) {
    return siblingConnector;
  }

  const wrapper = workspaceRow.parentElement;
  if (!wrapper) {
    return null;
  }

  for (const child of wrapper.children) {
    if (!(child instanceof HTMLElement)) {
      continue;
    }

    if (child.getAttribute("data-testid") === "subagent-connector") {
      return child;
    }
  }

  return null;
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

  test("reported children are hidden by default and toggle with parent expansion", async () => {
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
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        reportedAt: new Date().toISOString(),
      });

      cleanupDom = installDom();
      view = renderApp({ apiClient: env.orpc, metadata: parentWorkspace });

      await setupWorkspaceView(view, parentWorkspace, parentWorkspace.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;

      // Scenario 1: active children are visible, reported child is hidden by default.
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
      expect(getWorkspaceRow(renderedView.container, reportedChild.id)).toBeNull();

      const parentDisplayTitle = parentWorkspace.title ?? parentWorkspace.name;

      // Scenario 2: expanding the parent reveals reported children.
      const expandButton = await waitFor(
        () => {
          const button = renderedView.container.querySelector(
            `button[aria-label="Expand completed sub-agents for ${parentDisplayTitle}"]`
          ) as HTMLElement | null;
          if (!button) {
            throw new Error("Expand completed sub-agents button not found");
          }
          return button;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(expandButton);

      await waitFor(
        () => {
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (!reportedRow) {
            throw new Error("Expected reported child to be visible after expansion");
          }
        },
        { timeout: 10_000 }
      );

      // Scenario 3: collapsing the parent hides reported children again.
      const collapseButton = await waitFor(
        () => {
          const button = renderedView.container.querySelector(
            `button[aria-label="Collapse completed sub-agents for ${parentDisplayTitle}"]`
          ) as HTMLElement | null;
          if (!button) {
            throw new Error("Collapse completed sub-agents button not found");
          }
          return button;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(collapseButton);

      await waitFor(
        () => {
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (reportedRow) {
            throw new Error("Expected reported child to be hidden after collapsing");
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
      const expandCompletedChildrenButton = await waitFor(
        () => {
          const button = renderedView.container.querySelector(
            `button[aria-label="Expand completed sub-agents for ${parentDisplayTitle}"]`
          ) as HTMLElement | null;
          if (!button) {
            throw new Error("Expand completed sub-agents button not found");
          }
          return button;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(expandCompletedChildrenButton);

      await waitFor(
        () => {
          const reportedRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (!reportedRow) {
            throw new Error("Expected old reported child to be visible after expansion");
          }
        },
        { timeout: 10_000 }
      );

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
        branchPrefix: "subagent-connector-parent-reported",
      });
      workspaceIdsToRemove.push(parentWorkspace.id);

      const reportedChild = await createWorkspaceWithTitle({
        env,
        projectPath: repoPath,
        trunkBranch,
        title: "Reported Child",
        branchPrefix: "subagent-connector-reported",
      });
      workspaceIdsToRemove.push(reportedChild.id);

      const reportedAt = new Date().toISOString();
      await env.config.addWorkspace(repoPath, {
        ...reportedChild,
        parentWorkspaceId: parentWorkspace.id,
        taskStatus: "reported",
        reportedAt,
      });

      cleanupDom = installDom();
      view = renderApp({ apiClient: env.orpc, metadata: parentWorkspace });
      await setupWorkspaceView(view, parentWorkspace, parentWorkspace.id);

      if (!view) {
        throw new Error("View did not initialize");
      }
      const renderedView = view;

      const parentDisplayTitle = parentWorkspace.title ?? parentWorkspace.name;
      const expandCompletedChildrenButton = await waitFor(
        () => {
          const button = renderedView.container.querySelector(
            `button[aria-label="Expand completed sub-agents for ${parentDisplayTitle}"]`
          ) as HTMLElement | null;
          if (!button) {
            throw new Error("Expand completed sub-agents button not found");
          }
          return button;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(expandCompletedChildrenButton);

      await waitFor(
        () => {
          const childRow = getWorkspaceRow(renderedView.container, reportedChild.id);
          if (!childRow) {
            throw new Error("Expected reported child row to be visible");
          }

          const connector = getSubagentConnector(renderedView.container, reportedChild.id);
          if (!connector) {
            throw new Error("Expected reported child connector to be rendered");
          }

          const activeSegments = connector.querySelectorAll("span.subagent-connector-active");
          if (activeSegments.length !== 0) {
            throw new Error("Did not expect active connector segments for reported child");
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
});
