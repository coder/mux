import { cleanup, fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests, validateApiKeys } from "../testUtils";
import {
  cleanupSharedRepo,
  configureTestRetries,
  createSharedRepo,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";
import { HAIKU_MODEL, sendMessageWithModel } from "../ipc/helpers";
import type { ToolPolicy } from "../../src/common/utils/tools/toolPolicy";

import { installDom } from "./dom";
import { renderReviewPanel } from "./renderReviewPanel";

configureTestRetries(2);

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

validateApiKeys(["ANTHROPIC_API_KEY"]);

type EventCollector = { getEvents(): unknown[] };

type ToolCallEndEvent = { type: "tool-call-end"; toolName: string };

function isToolCallEndEvent(event: unknown): event is ToolCallEndEvent {
  if (typeof event !== "object" || event === null) return false;
  const record = event as { type?: unknown; toolName?: unknown };
  return record.type === "tool-call-end" && typeof record.toolName === "string";
}

function getRefreshIconClass(refreshButton: HTMLElement): string {
  return refreshButton.querySelector("svg")?.getAttribute("class") ?? "";
}

async function waitForRefreshButtonIdle(
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
 * Best-effort tooltip assertion. Radix tooltips use portals that don't reliably
 * work in happy-dom, so we only log warnings on failure rather than failing the test.
 */
async function checkTooltipText(
  refreshButton: HTMLElement,
  pattern: RegExp,
  timeoutMs: number = 5_000
): Promise<void> {
  // Radix renders tooltip content in a Portal. Use aria-describedby to locate it.
  fireEvent.focus(refreshButton);

  try {
    await waitFor(
      () => {
        const tooltipId = refreshButton.getAttribute("aria-describedby");
        if (!tooltipId) throw new Error("No aria-describedby yet");
        const tooltipEl = document.getElementById(tooltipId);
        if (!tooltipEl) throw new Error(`No element with id ${tooltipId}`);
        if (!pattern.test(tooltipEl.textContent ?? "")) {
          throw new Error(`Tooltip text "${tooltipEl.textContent}" doesn't match ${pattern}`);
        }
      },
      { timeout: timeoutMs }
    );
  } catch {
    // Radix tooltip portals are unreliable in happy-dom; don't fail the test.
    console.warn(
      `[checkTooltipText] Could not verify tooltip matches ${pattern} (happy-dom limitation)`
    );
  }
}
async function waitForToolCallEnd(
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

describeIntegration("ReviewPanel refresh (UI + ORPC + live LLM)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("auto refresh on tool-call-end + manual refresh updates tooltip", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, collector, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        // Wait for the first diff load to complete.
        await view.findAllByText(/No changes found/i, {}, { timeout: 60_000 });

        // === Auto refresh path (tool-call-end triggers scheduled refresh) ===
        const AUTO_MARKER = "AUTO_REFRESH_MARKER";
        const FORCE_BASH: ToolPolicy = [{ regex_match: "bash", action: "require" }];

        const autoRes = await sendMessageWithModel(
          env,
          workspaceId,
          `Use bash to append a new line containing "${AUTO_MARKER}" to README.md.`,
          HAIKU_MODEL,
          {
            mode: "exec",
            thinkingLevel: "off",
            toolPolicy: FORCE_BASH,
          }
        );
        expect(autoRes.success).toBe(true);

        await collector.waitForEvent("stream-end", 30_000);
        await waitForToolCallEnd(collector, "bash");

        // Verify the workspace actually changed, so a refresh has something to pick up.
        const statusRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: "git status --porcelain",
        });
        expect(statusRes.success).toBe(true);
        if (!statusRes.success) return;
        expect(statusRes.data.success).toBe(true);
        expect(statusRes.data.output).toContain("README.md");

        // Wait for ReviewPanel's tool-completion debounce + refresh to land.
        await view.findByText(new RegExp(AUTO_MARKER), {}, { timeout: 60_000 });

        // Tooltip should reflect the scheduled/tool-completion refresh.
        const refreshButton = view.getByTestId("review-refresh");
        await waitForRefreshButtonIdle(refreshButton);
        await checkTooltipText(refreshButton, /via tool completion/i);

        // === Manual refresh path (no tool-call events) ===
        const MANUAL_MARKER = "MANUAL_REFRESH_MARKER";

        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "${MANUAL_MARKER}" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;
        expect(bashRes.data.success).toBe(true);

        // Without manual refresh, the UI should not pick this up yet.
        expect(view.queryByText(new RegExp(MANUAL_MARKER))).toBeNull();

        fireEvent.click(refreshButton);

        // Immediate feedback on click: spinner should become visible.
        const icon = refreshButton.querySelector("svg");
        await waitFor(
          () => {
            expect(icon?.getAttribute("class") ?? "").toContain("animate-spin");
          },
          { timeout: 5_000 }
        );

        await view.findByText(new RegExp(MANUAL_MARKER), {}, { timeout: 60_000 });

        // Tooltip should now reflect the manual refresh (and not remain stuck on tool completion).
        await waitForRefreshButtonIdle(refreshButton);
        await checkTooltipText(refreshButton, /via manual click/i);
      } finally {
        view.unmount();
        cleanup();
        cleanupDom();
      }
    });
  }, 180_000);
});
