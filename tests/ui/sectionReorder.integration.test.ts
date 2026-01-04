/**
 * Integration tests for section reordering via drag-and-drop.
 *
 * Tests verify:
 * - Section headers have draggable attributes for reorder
 * - Backend reorderSections API works correctly
 * - UI reflects new section order after reorder
 *
 * Limitation: react-dnd-html5-backend doesn't work with happy-dom, so actual
 * drag-drop is tested in Storybook. These tests verify UI infrastructure and
 * backend behavior.
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
    .filter((id): id is string => id !== null);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("Section Reordering", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("section headers have draggable attribute for reordering", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create a workspace to ensure project exists
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-reorder"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create two sections
    const section1Result = await env.orpc.projects.sections.create({
      projectPath,
      name: "Section Alpha",
    });
    if (!section1Result.success)
      throw new Error(`Failed to create section: ${section1Result.error}`);
    const section1Id = section1Result.data.id;

    const section2Result = await env.orpc.projects.sections.create({
      projectPath,
      name: "Section Beta",
    });
    if (!section2Result.success)
      throw new Error(`Failed to create section: ${section2Result.error}`);
    const section2Id = section2Result.data.id;

    const cleanupDom = installDom();
    expandProjects([projectPath]);

    const view = renderApp({ apiClient: env.orpc, metadata: setupWs.metadata });

    try {
      await setupWorkspaceView(view, setupWs.metadata, setupWs.metadata.id);

      // Wait for both sections to appear
      const section1El = await waitForSection(view.container, section1Id);
      const section2El = await waitForSection(view.container, section2Id);

      // Verify sections have drag-related data attributes
      // The section header should be marked as draggable for reordering
      expect(section1El.closest("[data-section-drag-id]")).not.toBeNull();
      expect(section2El.closest("[data-section-drag-id]")).not.toBeNull();
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: section1Id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: section2Id });
    }
  }, 60_000);

  test("backend reorderSections API updates section order", async () => {
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

  test("UI reflects section order after reorder via API", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create a workspace to ensure project exists
    const setupWs = await env.orpc.workspace.create({
      projectPath,
      branchName: generateBranchName("setup-reorder-ui"),
      trunkBranch,
    });
    if (!setupWs.success) throw new Error(`Setup failed: ${setupWs.error}`);

    // Create two sections
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

      // Verify initial DOM order
      let orderedIds = getSectionIdsInOrder(view.container);
      expect(orderedIds).toEqual([sectionFirst.data.id, sectionSecond.data.id]);

      // Reorder via API (swap order)
      const reorderResult = await env.orpc.projects.sections.reorder({
        projectPath,
        sectionIds: [sectionSecond.data.id, sectionFirst.data.id],
      });
      expect(reorderResult.success).toBe(true);

      // Wait for UI to update
      await waitFor(
        () => {
          const ids = getSectionIdsInOrder(view.container);
          if (ids[0] !== sectionSecond.data.id) {
            throw new Error(`Expected ${sectionSecond.data.id} first, got ${ids[0]}`);
          }
        },
        { timeout: 5_000 }
      );

      // Verify new DOM order
      orderedIds = getSectionIdsInOrder(view.container);
      expect(orderedIds).toEqual([sectionSecond.data.id, sectionFirst.data.id]);
    } finally {
      await cleanupView(view, cleanupDom);
      await env.orpc.workspace.remove({ workspaceId: setupWs.metadata.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: sectionFirst.data.id });
      await env.orpc.projects.sections.remove({ projectPath, sectionId: sectionSecond.data.id });
    }
  }, 60_000);
});
