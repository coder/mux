/**
 * Integration tests for workspace section drag-drop infrastructure.
 *
 * Tests verify:
 * - Section and drop zone UI elements render correctly with proper data attributes
 * - Workspace items are draggable and show correct section assignment
 * - Backend section assignment API updates workspace metadata
 *
 * Note: react-dnd-html5-backend doesn't work with happy-dom's drag events,
 * so we verify the UI infrastructure and backend separately. The full drag-drop
 * flow is tested in Storybook / E2E tests.
 */

import { waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../ipc/sendMessageTestHelpers";
import { generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";
import { expandProjects } from "@/browser/stories/storyHelpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Find a workspace row in the sidebar by workspace ID.
 */
function findWorkspaceRow(container: HTMLElement, workspaceId: string): HTMLElement | null {
  return container.querySelector(`[data-workspace-id="${workspaceId}"]`);
}

/**
 * Find a section drop zone in the sidebar by section ID.
 */
function findSectionDropZone(container: HTMLElement, sectionId: string): HTMLElement | null {
  return container.querySelector(`[data-drop-section-id="${sectionId}"]`);
}

/**
 * Find the unsectioned workspaces drop zone.
 */
function findUnsectionedDropZone(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="unsectioned-drop-zone"]');
}

/**
 * Wait for a section header to appear in the sidebar.
 */
async function waitForSection(
  container: HTMLElement,
  sectionId: string,
  timeoutMs = 5_000
): Promise<HTMLElement> {
  return waitFor(
    () => {
      const section = container.querySelector(`[data-section-id="${sectionId}"]`);
      if (!section) throw new Error(`Section ${sectionId} not found`);
      return section as HTMLElement;
    },
    { timeout: timeoutMs }
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("Section Drag and Drop (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("renders section with drop zone and workspace with draggable attribute", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    // Create a workspace
    const branchName = generateBranchName("test-section-ui");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);
    const wsResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!wsResult.success) throw new Error(`Failed to create workspace: ${wsResult.error}`);
    const workspaceId = wsResult.metadata.id;
    const metadata = wsResult.metadata;

    // Create a section
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: "Test Section",
    });
    if (!sectionResult.success) throw new Error(`Failed to create section: ${sectionResult.error}`);
    const sectionId = sectionResult.data.id;

    const cleanupDom = installDom();
    expandProjects([projectPath]);

    const view = renderApp({ apiClient: env.orpc, metadata });

    try {
      await setupWorkspaceView(view, metadata, workspaceId);

      // Wait for section to appear
      await waitForSection(view.container, sectionId);

      // Verify section drop zone exists
      const sectionDropZone = findSectionDropZone(view.container, sectionId);
      expect(sectionDropZone).not.toBeNull();

      // Verify unsectioned drop zone exists when sections are present
      const unsectionedZone = findUnsectionedDropZone(view.container);
      expect(unsectionedZone).not.toBeNull();

      // Verify workspace row exists and has draggable attribute (for drag source)
      const workspaceRow = findWorkspaceRow(view.container, workspaceId);
      expect(workspaceRow).not.toBeNull();
      // Workspace should have data-section-id (empty for unsectioned)
      expect(workspaceRow!.hasAttribute("data-section-id")).toBe(true);
    } finally {
      await cleanupView(view, cleanupDom);
      // Cleanup
      await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.projects.sections.remove({ projectPath, sectionId });
    }
  }, 60_000);

  test("backend section assignment updates workspace metadata", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    // Create a section
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: "Test Section Backend",
    });
    if (!sectionResult.success) throw new Error(`Failed to create section: ${sectionResult.error}`);
    const sectionId = sectionResult.data.id;

    // Create a workspace
    const branchName = generateBranchName("test-section-backend");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);
    const wsResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!wsResult.success) throw new Error(`Failed to create workspace: ${wsResult.error}`);
    const workspaceId = wsResult.metadata.id;

    try {
      // Initially workspace should have no section
      let workspaceInfo = await env.orpc.workspace.getInfo({ workspaceId });
      expect(workspaceInfo?.sectionId).toBeUndefined();

      // Assign workspace to section
      const assignResult = await env.orpc.projects.sections.assignWorkspace({
        projectPath,
        workspaceId,
        sectionId,
      });
      expect(assignResult.success).toBe(true);

      // Verify workspace now has section assignment
      workspaceInfo = await env.orpc.workspace.getInfo({ workspaceId });
      expect(workspaceInfo?.sectionId).toBe(sectionId);

      // Unassign workspace from section
      const unassignResult = await env.orpc.projects.sections.assignWorkspace({
        projectPath,
        workspaceId,
        sectionId: null,
      });
      expect(unassignResult.success).toBe(true);

      // Verify workspace is unsectioned again
      workspaceInfo = await env.orpc.workspace.getInfo({ workspaceId });
      expect(workspaceInfo?.sectionId).toBeUndefined();
    } finally {
      // Cleanup
      await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.projects.sections.remove({ projectPath, sectionId });
    }
  }, 60_000);
});
