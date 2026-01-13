/**
 * Integration tests for workspace sections.
 *
 * Tests verify:
 * - Section UI elements render correctly with proper data attributes
 * - Section and drop zone UI elements render with proper data attributes
 * - Workspace creation with sectionId assigns to that section
 * - Section "+" button pre-selects section in creation flow
 * - Section removal invariants (blocked by active workspaces, clears archived)
 * - Section reordering via API and UI reflection
 *
 * Testing approach:
 * - Section creation uses ORPC (happy-dom doesn't reliably handle React controlled inputs)
 * - We test that sections render correctly, not the text input submission interaction
 * - Workspace creation uses ORPC for speed (setup/teardown is acceptable per AGENTS.md)
 * - DnD gestures tested in Storybook (react-dnd-html5-backend doesn't work in happy-dom)
 */

import { act, fireEvent, waitFor } from "@testing-library/react";

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
 * Get all section IDs in DOM order.
 */
function getSectionIdsInOrder(container: HTMLElement): string[] {
  const sections = container.querySelectorAll("[data-section-id]");
  return Array.from(sections)
    .map((el) => el.getAttribute("data-section-id"))
    .filter((id): id is string => id !== null && id !== "");
}

/**
 * Create a section via ORPC. Returns the section ID.
 *
 * Note: This does NOT wait for UI to update - use with tests that don't need
 * immediate UI reflection, or call refreshProjects() after and wait appropriately.
 *
 * We use ORPC instead of UI interactions because happy-dom doesn't properly
 * handle React controlled inputs (fireEvent.change doesn't trigger React state updates
 * synchronously, causing keyDown/blur handlers to see stale state).
 */
async function createSectionViaAPI(
  env: ReturnType<typeof getSharedEnv>,
  projectPath: string,
  sectionName: string
): Promise<string> {
  const result = await env.orpc.projects.sections.create({
    projectPath,
    name: sectionName,
  });

  if (!result.success) {
    throw new Error(`Failed to create section: ${result.error}`);
  }

  return result.data.id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("Workspace Sections", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // UI Infrastructure
  // ─────────────────────────────────────────────────────────────────────────────

  test("section renders with drop zones after creation", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();

    // Create a workspace first (ORPC is fine for setup)
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

    // Create section BEFORE rendering so it's in the initial config
    const sectionId = await createSectionViaAPI(env, projectPath, "Test Section");

    const cleanupDom = installDom();
    expandProjects([projectPath]);

    const view = renderApp({ apiClient: env.orpc, metadata });

    try {
      await setupWorkspaceView(view, metadata, workspaceId);

      // Wait for section to appear in UI
      await waitForSection(view.container, sectionId);

      // Verify section drop zone exists (for workspace drag-drop)
      const sectionDropZone = findSectionDropZone(view.container, sectionId);
      expect(sectionDropZone).not.toBeNull();

      // Verify unsectioned drop zone exists when sections are present
      const unsectionedZone = findUnsectionedDropZone(view.container);
      expect(unsectionedZone).not.toBeNull();

      // Verify workspace row exists and has data-section-id attribute
      const workspaceRow = findWorkspaceRow(view.container, workspaceId);
      expect(workspaceRow).not.toBeNull();
      expect(workspaceRow!.hasAttribute("data-section-id")).toBe(true);

      // Verify section has drag-related attribute for reordering
      const sectionDragWrapper = view.container.querySelector(
        `[data-section-drag-id="${sectionId}"]`
      );
      expect(sectionDragWrapper).not.toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.projects.sections.remove({ projectPath, sectionId });
    }
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────────
  // Workspace Creation with Section
  // ─────────────────────────────────────────────────────────────────────────────

  test("workspace created with sectionId is assigned to that section", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
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
        branchName: generateBranchName("test-create-in-section"),
        trunkBranch,
        sectionId,
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

    // Create workspace to ensure project exists (ORPC for setup is acceptable)
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-section-add"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create section BEFORE rendering so it's in the initial config
    const sectionId = await createSectionViaAPI(env, projectPath, "Add Button Section");

    const cleanupDom = installDom();
    expandProjects([projectPath]);

    const view = renderApp({ apiClient: env.orpc, metadata: setupWs.metadata });

    try {
      await setupWorkspaceView(view, setupWs.metadata, setupWs.metadata.id);

      // Wait for section to render
      await waitForSection(view.container, sectionId);

      // Find the "+" button in the section header
      const sectionHeader = view.container.querySelector(`[data-section-id="${sectionId}"]`);
      expect(sectionHeader).not.toBeNull();

      const addButton = sectionHeader!.querySelector(
        'button[aria-label="New workspace in section"]'
      );
      expect(addButton).not.toBeNull();

      // Click the add button - this should navigate to create page with section context
      // Wrap in act() to ensure React state updates are properly flushed
      await act(async () => {
        fireEvent.click(addButton as HTMLElement);
      });

      // Wait for the create page to show section selector with this section pre-selected
      await waitFor(
        () => {
          const sectionSelector = view.container.querySelector('[data-testid="section-selector"]');
          if (!sectionSelector) {
            throw new Error("Section selector not found on create page");
          }
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Section Reordering
  // ─────────────────────────────────────────────────────────────────────────────

  test("reorderSections API updates section order", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create a workspace to ensure project exists
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-reorder-api"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create three sections (they'll be in creation order: A, B, C)
    const sectionA = await env.orpc.projects.sections.create({
      projectPath,
      name: "Section A",
    });
    if (!sectionA.success) throw new Error(`Failed to create section: ${sectionA.error}`);

    const sectionB = await env.orpc.projects.sections.create({
      projectPath,
      name: "Section B",
    });
    if (!sectionB.success) throw new Error(`Failed to create section: ${sectionB.error}`);

    const sectionC = await env.orpc.projects.sections.create({
      projectPath,
      name: "Section C",
    });
    if (!sectionC.success) throw new Error(`Failed to create section: ${sectionC.error}`);

    try {
      // Verify initial order
      let sections = await env.orpc.projects.sections.list({ projectPath });
      expect(sections.map((s) => s.name)).toEqual(["Section A", "Section B", "Section C"]);

      // Reorder to C, A, B
      const reorderResult = await env.orpc.projects.sections.reorder({
        projectPath,
        sectionIds: [sectionC.data.id, sectionA.data.id, sectionB.data.id],
      });
      expect(reorderResult.success).toBe(true);

      // Verify new order
      sections = await env.orpc.projects.sections.list({ projectPath });
      expect(sections.map((s) => s.name)).toEqual(["Section C", "Section A", "Section B"]);
    } finally {
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: sectionA.data.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: sectionB.data.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: sectionC.data.id });
    }
  }, 60_000);

  // Note: UI auto-refresh after reorder requires the full DnD flow which triggers
  // ProjectContext.reorderSections -> refreshProjects(). Direct API calls bypass this.
  // The sorting logic is unit-tested in workspaceFiltering.test.ts (sortSectionsByLinkedList).
  // This test verifies initial render respects section order from backend.
  test("sections render in linked-list order from config", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create a workspace to ensure project exists
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-section-order"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create two sections (will be in creation order: First, Second)
    const sectionFirst = await env.orpc.projects.sections.create({
      projectPath,
      name: "First Section",
    });
    if (!sectionFirst.success) throw new Error(`Failed to create section: ${sectionFirst.error}`);

    const sectionSecond = await env.orpc.projects.sections.create({
      projectPath,
      name: "Second Section",
    });
    if (!sectionSecond.success) throw new Error(`Failed to create section: ${sectionSecond.error}`);

    const cleanupDom = installDom();
    expandProjects([projectPath]);

    const view = renderApp({ apiClient: env.orpc, metadata: setupWs.metadata });

    try {
      await setupWorkspaceView(view, setupWs.metadata, setupWs.metadata.id);

      // Wait for sections to appear
      await waitForSection(view.container, sectionFirst.data.id);
      await waitForSection(view.container, sectionSecond.data.id);

      // Verify DOM order matches linked-list order (First -> Second)
      const orderedIds = getSectionIdsInOrder(view.container);
      expect(orderedIds).toEqual([sectionFirst.data.id, sectionSecond.data.id]);
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: sectionFirst.data.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: sectionSecond.data.id });
    }
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────────
  // Section Removal Invariants
  // ─────────────────────────────────────────────────────────────────────────────

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
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: `test-section-${Date.now()}`,
    });
    expect(sectionResult.success).toBe(true);
    const sectionId = sectionResult.success ? sectionResult.data.id : "";

    // Create a workspace in that section
    const wsResult = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("section-removal-test"),
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
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: `test-section-archive-${Date.now()}`,
    });
    expect(sectionResult.success).toBe(true);
    const sectionId = sectionResult.success ? sectionResult.data.id : "";

    // Create a workspace in that section
    const wsResult = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("archive-section-test"),
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
      await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      // Section already removed in test, but try anyway in case test failed early
      await env.orpc.projects.sections.remove({ projectPath, sectionId }).catch(() => {});
    }
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────────
  // Section Deletion Error Feedback
  // ─────────────────────────────────────────────────────────────────────────────

  test("clicking delete on section with active workspaces shows error popover", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create a setup workspace first to ensure project is registered
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-delete-error"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create a section
    const sectionResult = await env.orpc.projects.sections.create({
      projectPath,
      name: `test-delete-error-${Date.now()}`,
    });
    expect(sectionResult.success).toBe(true);
    const sectionId = sectionResult.success ? sectionResult.data.id : "";

    // Create a workspace in that section (active, not archived)
    const wsResult = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("in-section-delete-error"),
      trunkBranch,
      sectionId,
    });
    expect(wsResult.success).toBe(true);
    const workspaceId = wsResult.success ? wsResult.metadata.id : "";
    const metadata = wsResult.success ? wsResult.metadata : setupWs.metadata;

    const cleanupDom = installDom();
    expandProjects([projectPath]);

    const view = renderApp({ apiClient: env.orpc, metadata });

    try {
      await setupWorkspaceView(view, metadata, workspaceId);

      // Wait for section to appear in UI
      await waitForSection(view.container, sectionId);

      // Find and click the delete button on the section
      const sectionElement = view.container.querySelector(`[data-section-id="${sectionId}"]`);
      expect(sectionElement).not.toBeNull();

      // Hover over section to reveal action buttons (they're only visible on hover)
      fireEvent.mouseEnter(sectionElement!);

      const deleteButton = sectionElement!.querySelector('[aria-label="Delete section"]');
      expect(deleteButton).not.toBeNull();
      fireEvent.click(deleteButton!);

      // Wait for error popover to appear with message about active workspaces
      await waitFor(
        () => {
          const errorPopover = document.querySelector('[role="alert"]');
          if (!errorPopover) throw new Error("Error popover not found");
          const errorText = errorPopover.textContent ?? "";
          if (!errorText.toLowerCase().includes("active workspace")) {
            throw new Error(`Expected error about active workspaces, got: ${errorText}`);
          }
        },
        { timeout: 5_000 }
      );
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.workspace.remove({ workspaceId });
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId }).catch(() => {});
    }
  }, 60_000);
});
