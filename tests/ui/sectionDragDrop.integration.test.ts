/**
 * Integration tests for workspace sections.
 *
 * Tests verify:
 * - Section and drop zone UI elements render with proper data attributes
 * - Workspace creation with sectionId assigns to that section
 * - Section "+" button pre-selects section in creation flow
 * - Section removal invariants (blocked by active workspaces, clears archived)
 *
 * Limitation: react-dnd-html5-backend doesn't work with happy-dom, so actual
 * drag-drop is tested in Storybook. These tests verify UI infrastructure and
 * backend behavior that the drag handlers depend on.
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

  test("workspace created with sectionId is assigned to that section", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    // Create a section first
    const branchName = generateBranchName("test-create-in-section");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create workspace without section first to ensure project exists
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: "Target Section",
    });
    if (!sectionResult.success) throw new Error(`Failed to create section: ${sectionResult.error}`);
    const sectionId = sectionResult.data.id;

    let workspaceId: string | undefined;
    try {
      // Create workspace WITH sectionId
      const wsResult = await env.orpc.workspace.create({
        projectPath,
        branchName,
        trunkBranch,
        sectionId, // This is the key - creating directly into a section
      });
      if (!wsResult.success) throw new Error(`Failed to create workspace: ${wsResult.error}`);
      workspaceId = wsResult.metadata.id;

      // Verify workspace metadata has the sectionId
      const workspaceInfo = await env.orpc.workspace.getInfo({ workspaceId });
      expect(workspaceInfo?.sectionId).toBe(sectionId);
    } finally {
      if (workspaceId) await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId });
    }
  }, 60_000);

  test("clicking section add button sets pending section for creation", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create workspace to ensure project exists
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-section-add"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create a section
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: "Add Button Section",
    });
    if (!sectionResult.success) throw new Error(`Failed to create section: ${sectionResult.error}`);
    const sectionId = sectionResult.data.id;

    const cleanupDom = installDom();
    expandProjects([projectPath]);

    const view = renderApp({ apiClient: env.orpc, metadata: setupWs.metadata });

    try {
      await setupWorkspaceView(view, setupWs.metadata, setupWs.metadata.id);

      // Wait for section header to appear
      await waitForSection(view.container, sectionId);

      // Find the "+" button in the section header
      const sectionHeader = view.container.querySelector(`[data-section-id="${sectionId}"]`);
      expect(sectionHeader).not.toBeNull();

      const addButton = sectionHeader!.querySelector(
        'button[aria-label="New workspace in section"]'
      );
      expect(addButton).not.toBeNull();

      // Click the add button - this should navigate to create page with section context
      (addButton as HTMLElement).click();

      // Wait for the create page to show section selector with this section pre-selected
      await waitFor(
        () => {
          const sectionSelector = view.container.querySelector('[data-testid="section-selector"]');
          if (!sectionSelector) {
            throw new Error("Section selector not found on create page");
          }
          // Check that the section is selected (value should match sectionId)
          const selectedValue = sectionSelector.getAttribute("data-selected-section");
          if (selectedValue !== sectionId) {
            throw new Error(`Expected section ${sectionId} to be selected, got ${selectedValue}`);
          }
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId });
    }
  }, 60_000);

  // ═══════════════════════════════════════════════════════════════════════════════
  // SECTION REMOVAL INVARIANTS
  // ═══════════════════════════════════════════════════════════════════════════════

  test("cannot remove section with active (non-archived) workspaces", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create a setup workspace first to ensure project is registered
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-removal"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create a section
    const sectionName = `test-section-${Date.now()}`;
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: sectionName,
    });
    expect(sectionResult.success).toBe(true);
    const sectionId = sectionResult.success ? sectionResult.data.id : "";

    // Create a workspace in that section
    const branchName = generateBranchName("section-removal-test");
    const wsResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
      sectionId,
    });
    expect(wsResult.success).toBe(true);
    const workspaceId = wsResult.success ? wsResult.metadata.id : "";

    try {
      // Attempt to remove the section - should fail
      const removeResult = await env.orpc.projects.sections.remove({
        projectPath,
        sectionId,
      });
      expect(removeResult.success).toBe(false);
      if (!removeResult.success) {
        expect(removeResult.error).toContain("active workspace");
      }
    } finally {
      // Cleanup: remove workspaces first, then section
      await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId });
    }
  }, 30_000);

  test("removing section clears sectionId from archived workspaces", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create a setup workspace first to ensure project is registered
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-archive"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create a section
    const sectionName = `test-section-archive-${Date.now()}`;
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: sectionName,
    });
    expect(sectionResult.success).toBe(true);
    const sectionId = sectionResult.success ? sectionResult.data.id : "";

    // Create a workspace in that section
    const branchName = generateBranchName("archive-section-test");
    const wsResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
      sectionId,
    });
    expect(wsResult.success).toBe(true);
    const workspaceId = wsResult.success ? wsResult.metadata.id : "";

    try {
      // Archive the workspace
      const archiveResult = await env.orpc.workspace.archive({ workspaceId });
      expect(archiveResult.success).toBe(true);

      // Verify workspace is archived and has sectionId
      let wsInfo = await env.orpc.workspace.getInfo({ workspaceId });
      expect(wsInfo).not.toBeNull();
      expect(wsInfo?.sectionId).toBe(sectionId);
      expect(wsInfo?.archivedAt).toBeDefined();

      // Now remove the section - should succeed since workspace is archived
      const removeResult = await env.orpc.projects.sections.remove({
        projectPath,
        sectionId,
      });
      expect(removeResult.success).toBe(true);

      // Verify workspace's sectionId is now cleared
      wsInfo = await env.orpc.workspace.getInfo({ workspaceId });
      expect(wsInfo).not.toBeNull();
      expect(wsInfo?.sectionId).toBeUndefined();
    } finally {
      // Cleanup
      await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      // Section already removed in test, but try anyway in case test failed early
      await env.orpc.projects.sections.remove({ projectPath, sectionId }).catch(() => {});
    }
  }, 30_000);
});
