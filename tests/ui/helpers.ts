/**
 * Shared UI test helpers for review panel testing.
 */

import { waitFor } from "@testing-library/react";

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
