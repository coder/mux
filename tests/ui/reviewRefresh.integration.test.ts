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
        // Wait for initial load to settle.
        await waitFor(
          () => {
            expect(view.queryByText(/Loading diff/i)).toBeNull();
          },
          { timeout: 30_000 }
        );

        // === Auto refresh path (tool-call-end triggers scheduled refresh) ===
        const AUTO_MARKER = "AUTO_REFRESH_MARKER";
        const FORCE_FILE_EDIT: ToolPolicy = [
          { regex_match: "file_edit_insert", action: "require" },
        ];

        const autoRes = await sendMessageWithModel(
          env,
          workspaceId,
          `Use file_edit_insert to add a new line containing "${AUTO_MARKER}" to README.md.`,
          HAIKU_MODEL,
          {
            mode: "exec",
            thinkingLevel: "off",
            toolPolicy: FORCE_FILE_EDIT,
          }
        );
        expect(autoRes.success).toBe(true);

        await collector.waitForEvent("stream-end", 30_000);
        await waitForToolCallEnd(collector, "file_edit_insert");

        // Wait for ReviewPanel's tool-completion debounce + refresh to land.
        await view.findByText(new RegExp(AUTO_MARKER), {}, { timeout: 60_000 });

        // Tooltip should reflect the scheduled/tool-completion refresh.
        const refreshButton = view.getByTestId("review-refresh");
        fireEvent.focus(refreshButton);
        await view.findByText(/via tool completion/i, {}, { timeout: 10_000 });

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
        fireEvent.focus(refreshButton);
        await view.findByText(/via manual click/i, {}, { timeout: 10_000 });
      } finally {
        view.unmount();
        cleanup();
        cleanupDom();
      }
    });
  }, 180_000);
});
