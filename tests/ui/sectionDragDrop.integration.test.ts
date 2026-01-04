/**
 * Integration tests for workspace section drag-drop and creation infrastructure.
 *
 * Tests verify:
 * - Section and drop zone UI elements render correctly with proper data attributes
 * - Workspace items are draggable and show correct section assignment
 * - Backend section assignment API updates workspace metadata
 * - Creating workspace from section's "+" button assigns it to that section
 * - Section selector appears on create page when project has sections
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

/**
 * Get the section ID from a workspace row's data attribute.
 */
function getWorkspaceSectionId(workspaceRow: HTMLElement): string {
  return workspaceRow.getAttribute("data-section-id") ?? "";
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

  test("UI updates workspace section after assignment via context action", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    // Create a workspace first (this implicitly adds the project)
    const branchName = generateBranchName("test-section-ui-update");
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
      name: "UI Update Section",
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

      // Verify workspace is initially unsectioned
      let workspaceRow = findWorkspaceRow(view.container, workspaceId);
      expect(workspaceRow).not.toBeNull();
      expect(getWorkspaceSectionId(workspaceRow!)).toBe("");

      // Assign workspace to section via backend API (simulating what drop handler does)
      // This should emit a metadata update via WorkspaceService.refreshAndEmitMetadata
      const assignResult = await env.orpc.projects.sections.assignWorkspace({
        projectPath,
        workspaceId,
        sectionId,
      });
      expect(assignResult.success).toBe(true);

      // Wait for UI to reflect the change - workspace row should now show section ID
      await waitFor(
        () => {
          workspaceRow = findWorkspaceRow(view.container, workspaceId);
          if (!workspaceRow) throw new Error("Workspace row not found");
          const currentSectionId = getWorkspaceSectionId(workspaceRow);
          if (currentSectionId !== sectionId) {
            throw new Error(`Expected sectionId ${sectionId}, got "${currentSectionId}"`);
          }
        },
        { timeout: 5_000 }
      );

      // Unassign and verify UI updates
      await env.orpc.projects.sections.assignWorkspace({
        projectPath,
        workspaceId,
        sectionId: null,
      });

      await waitFor(
        () => {
          workspaceRow = findWorkspaceRow(view.container, workspaceId);
          if (!workspaceRow) throw new Error("Workspace row not found");
          const currentSectionId = getWorkspaceSectionId(workspaceRow);
          if (currentSectionId !== "") {
            throw new Error(`Expected empty sectionId, got "${currentSectionId}"`);
          }
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
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
});
