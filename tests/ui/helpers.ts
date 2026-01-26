/**
 * Shared UI test helpers for review panel and git status testing.
 */

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { FrontendWorkspaceMetadata, GitStatus } from "@/common/types/workspace";
import type { RenderedApp } from "./renderReviewPanel";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { useGitStatusStoreRaw } from "@/browser/stores/GitStatusStore";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type EventCollector = { getEvents(): unknown[] };

type ToolCallEndEvent = { type: "tool-call-end"; toolName: string };

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function isToolCallEndEvent(event: unknown): event is ToolCallEndEvent {
  if (typeof event !== "object" || event === null) return false;
  const record = event as { type?: unknown; toolName?: unknown };
  return record.type === "tool-call-end" && typeof record.toolName === "string";
}

/**
 * Wait for a tool-call-end event with the specified tool name.
 */
export async function waitForToolCallEnd(
  collector: EventCollector,
  toolName: string,
  timeoutMs: number = 10_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = collector
      .getEvents()
      .find((event) => isToolCallEndEvent(event) && event.toolName === toolName);
    if (match) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for tool-call-end: ${toolName}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFRESH BUTTON HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the CSS class of the refresh button's SVG icon.
 */
export function getRefreshIconClass(refreshButton: HTMLElement): string {
  return refreshButton.querySelector("svg")?.getAttribute("class") ?? "";
}

/**
 * Wait for the refresh button to be in idle state (not spinning or stopping).
 */
export async function waitForRefreshButtonIdle(
  refreshButton: HTMLElement,
  timeoutMs: number = 60_000
): Promise<void> {
  await waitFor(
    () => {
      const cls = getRefreshIconClass(refreshButton);
      expect(cls).not.toContain("animate-spin");
      // Stopping state uses `animate-[spin_0.8s_ease-out_forwards]`.
      expect(cls).not.toContain("animate-[");
    },
    { timeout: timeoutMs }
  );
}

/**
 * Assert that the refresh button has lastRefreshInfo data attribute set.
 * We use a data attribute because Radix tooltip portals don't work in happy-dom.
 */
export async function assertRefreshButtonHasLastRefreshInfo(
  refreshButton: HTMLElement,
  expectedTrigger: string,
  timeoutMs: number = 5_000
): Promise<void> {
  await waitFor(
    () => {
      const trigger = refreshButton.getAttribute("data-last-refresh-trigger");
      if (!trigger) {
        throw new Error("data-last-refresh-trigger not set on button");
      }
      if (trigger !== expectedTrigger) {
        throw new Error(`Expected trigger "${expectedTrigger}" but got "${trigger}"`);
      }
    },
    { timeout: timeoutMs }
  );
}

/**
 * Simulate a file-modifying tool completion (e.g., file_edit_*, bash).
 * This triggers the RefreshController's schedule() without requiring actual AI calls.
 */
export function simulateFileModifyingToolEnd(workspaceId: string): void {
  workspaceStore.simulateFileModifyingToolEnd(workspaceId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// WORKSPACE/VIEW SETUP HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Set up the full App UI and navigate to a workspace.
 * Expands project tree and selects the workspace.
 */
export async function setupWorkspaceView(
  view: RenderedApp,
  metadata: FrontendWorkspaceMetadata,
  workspaceId: string
): Promise<void> {
  await view.waitForReady();

  // Expand project tree
  const projectRow = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-project-path="${metadata.projectPath}"]`);
      if (!el) throw new Error("Project not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );

  const expandButton = projectRow.querySelector('[aria-label*="Expand project"]');
  if (expandButton) {
    fireEvent.click(expandButton);
  } else {
    fireEvent.click(projectRow);
  }

  // Select the workspace
  const workspaceElement = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-workspace-id="${workspaceId}"]`);
      if (!el) throw new Error("Workspace not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(workspaceElement);
}

/**
 * Navigate to a project's creation page (ProjectPage) by clicking the project row.
 *
 * Note: Mux now boots into the built-in mux-chat workspace, so tests that need the
 * creation UI must explicitly open it.
 */
export async function openProjectCreationView(
  view: RenderedApp,
  projectPath: string
): Promise<void> {
  await view.waitForReady();

  const projectRow = await waitFor(
    () => {
      const el = view.container.querySelector(
        `[data-project-path="${projectPath}"][aria-controls]`
      ) as HTMLElement | null;
      if (!el) throw new Error("Project not found in sidebar");
      return el;
    },
    { timeout: 10_000 }
  );

  fireEvent.click(projectRow);

  await waitFor(
    () => {
      const textarea = view.container.querySelector("textarea");
      if (!textarea) {
        throw new Error("Project creation page not rendered");
      }
    },
    { timeout: 10_000 }
  );
}

/**
 * Clean up after a UI test: unmount view, run RTL cleanup, then restore DOM.
 * Use in finally blocks to ensure consistent cleanup.
 */
export async function cleanupView(view: RenderedApp, cleanupDom: () => void): Promise<void> {
  view.unmount();
  cleanup();
  // Wait for any pending React updates to settle before destroying DOM
  await new Promise((r) => setTimeout(r, 100));
  cleanupDom();
}

// ═══════════════════════════════════════════════════════════════════════════════
// GIT STATUS HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get the current git status from a workspace element's data-git-status attribute.
 * Returns null if the attribute is missing or cannot be parsed.
 */
export function getGitStatusFromElement(element: HTMLElement): Partial<GitStatus> | null {
  const statusAttr = element.getAttribute("data-git-status");
  if (!statusAttr) return null;
  try {
    return JSON.parse(statusAttr) as Partial<GitStatus>;
  } catch {
    return null;
  }
}

/**
 * Wait for the git status indicator to appear in the sidebar workspace row.
 * The workspace row displays git status via data-git-status attribute.
 */
export async function waitForGitStatusElement(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs: number = 30_000
): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = container.querySelector(`[data-workspace-id="${workspaceId}"][data-git-status]`);
      if (!el) throw new Error("Git status element not found");
      return el as HTMLElement;
    },
    { timeout: timeoutMs }
  );
}

/**
 * Wait for git status to match a condition.
 */
async function waitForGitStatus(
  container: HTMLElement,
  workspaceId: string,
  predicate: (status: Partial<GitStatus>) => boolean,
  description: string,
  timeoutMs: number
): Promise<GitStatus> {
  let lastStatus: Partial<GitStatus> | null = null;

  await waitFor(
    () => {
      const el = container.querySelector(`[data-workspace-id="${workspaceId}"][data-git-status]`);
      if (!el) throw new Error("Git status element not found");
      lastStatus = getGitStatusFromElement(el as HTMLElement);
      if (!lastStatus) throw new Error("Could not parse git status");
      if (!predicate(lastStatus)) {
        throw new Error(`Expected ${description}, got: ${JSON.stringify(lastStatus)}`);
      }
    },
    { timeout: timeoutMs }
  );

  return lastStatus as unknown as GitStatus;
}

/**
 * Wait for git status to indicate dirty (uncommitted changes).
 */
export function waitForDirtyStatus(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs: number = 60_000
): Promise<GitStatus> {
  return waitForGitStatus(container, workspaceId, (s) => !!s.dirty, "dirty status", timeoutMs);
}

/**
 * Wait for git status to indicate clean (no uncommitted changes).
 */
export function waitForCleanStatus(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs: number = 60_000
): Promise<GitStatus> {
  return waitForGitStatus(container, workspaceId, (s) => !s.dirty, "clean status", timeoutMs);
}

/**
 * Wait for git status to show at least N commits ahead of remote.
 */
export function waitForAheadStatus(
  container: HTMLElement,
  workspaceId: string,
  minAhead: number,
  timeoutMs: number = 60_000
): Promise<GitStatus> {
  return waitForGitStatus(
    container,
    workspaceId,
    (s) => (s.ahead ?? 0) >= minAhead,
    `ahead >= ${minAhead}`,
    timeoutMs
  );
}

/**
 * Wait for git status to be idle (no fetch in-flight) AND match a predicate.
 * Use this to ensure no background fetch can race with subsequent operations.
 */
export function waitForIdleGitStatus(
  workspaceId: string,
  predicate: (status: GitStatus) => boolean,
  description: string,
  timeoutMs: number = 60_000
): Promise<GitStatus> {
  const store = useGitStatusStoreRaw();

  return waitFor(
    () => {
      // Check global in-flight state, not per-workspace (initial fetch doesn't set per-workspace flag)
      if (store.isAnyRefreshInFlight()) {
        throw new Error("Git status fetch in-flight");
      }
      const status = store.getStatus(workspaceId);
      if (!status) throw new Error("Git status not yet available");
      if (!predicate(status)) {
        throw new Error(`Expected ${description}, got: ${JSON.stringify(status)}`);
      }
      return status;
    },
    { timeout: timeoutMs }
  );
}
