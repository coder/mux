/**
 * Shared UI test helpers for review panel and git status testing.
 */

import { waitFor } from "@testing-library/react";
import type { GitStatus } from "@/common/types/workspace";

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
 * Wait for git status to indicate dirty (uncommitted changes).
 */
export async function waitForDirtyStatus(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs: number = 60_000
): Promise<GitStatus> {
  let lastStatus: Partial<GitStatus> | null = null;

  await waitFor(
    () => {
      const el = container.querySelector(`[data-workspace-id="${workspaceId}"][data-git-status]`);
      if (!el) throw new Error("Git status element not found");
      lastStatus = getGitStatusFromElement(el as HTMLElement);
      if (!lastStatus) throw new Error("Could not parse git status");
      if (!lastStatus.dirty) {
        throw new Error(`Expected dirty status, got: ${JSON.stringify(lastStatus)}`);
      }
    },
    { timeout: timeoutMs }
  );

  // Type assertion safe because waitFor throws if lastStatus is null or not dirty
  return lastStatus as unknown as GitStatus;
}

/**
 * Wait for git status to indicate clean (no uncommitted changes).
 */
export async function waitForCleanStatus(
  container: HTMLElement,
  workspaceId: string,
  timeoutMs: number = 60_000
): Promise<GitStatus> {
  let lastStatus: Partial<GitStatus> | null = null;

  await waitFor(
    () => {
      const el = container.querySelector(`[data-workspace-id="${workspaceId}"][data-git-status]`);
      if (!el) throw new Error("Git status element not found");
      lastStatus = getGitStatusFromElement(el as HTMLElement);
      if (!lastStatus) throw new Error("Could not parse git status");
      if (lastStatus.dirty) {
        throw new Error(`Expected clean status, got: ${JSON.stringify(lastStatus)}`);
      }
    },
    { timeout: timeoutMs }
  );

  // Type assertion safe because waitFor throws if lastStatus is null or dirty
  return lastStatus as unknown as GitStatus;
}
