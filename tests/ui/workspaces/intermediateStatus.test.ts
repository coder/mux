/**
 * UI integration test for the “working but no status_set yet” intermediate status.
 *
 * Expectation: While a stream is starting and no status_set tool has been received,
 * the workspace sidebar row should show provider icon + model name + starting label.
 */

import "../dom";

import { waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createStreamCollector } from "../../ipc/streamCollector";
import { createAppHarness } from "../harness";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

function getWorkspaceElement(container: HTMLElement, workspaceId: string): HTMLElement {
  const el = container.querySelector(`[data-workspace-id="${workspaceId}"]`) as HTMLElement | null;
  if (!el) {
    throw new Error(`Workspace element not found for ${workspaceId}`);
  }
  return el;
}

describe("Workspace intermediate status (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("shows model + starting while stream is starting and before status_set", async () => {
    const app = await createAppHarness({ branchPrefix: "status-intermediate" });

    const collector = createStreamCollector(app.env.orpc, app.workspaceId);
    collector.start();
    await collector.waitForSubscription(5000);

    try {
      // Gate stream-start so we get a stable “starting” window.
      const gatedMessage = "[mock:wait-start] Show intermediate status";
      await app.chat.send(gatedMessage);

      // Ensure we entered the starting window.
      await waitFor(
        () => {
          const state = workspaceStore.getWorkspaceSidebarState(app.workspaceId);
          if (!state.isStarting) {
            throw new Error("Workspace is not in starting state yet");
          }
        },
        { timeout: 10_000 }
      );

      // Assert the sidebar shows the intermediate status (provider/model + mode).
      await waitFor(
        () => {
          const wsEl = getWorkspaceElement(app.view.container, app.workspaceId);
          const modelDisplay = wsEl.querySelector("[data-model-display]");
          if (!modelDisplay) {
            throw new Error("Expected model display in intermediate status");
          }

          const text = wsEl.textContent ?? "";
          expect(text.toLowerCase()).toContain("starting");
        },
        { timeout: 10_000 }
      );

      // Stream-start should not have fired yet (gate is still held).
      const sawStreamStartEarly = collector
        .getEvents()
        .some((event) => "type" in event && event.type === "stream-start");
      expect(sawStreamStartEarly).toBe(false);

      // Release the gate and let the stream run.
      app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);

      const streamStart = await collector.waitForEvent("stream-start", 10_000);
      expect(streamStart).not.toBeNull();

      const streamEnd = await collector.waitForEvent("stream-end", 30_000);
      expect(streamEnd).not.toBeNull();

      // After stream completion, the intermediate status row should disappear.
      await waitFor(
        () => {
          const wsEl = getWorkspaceElement(app.view.container, app.workspaceId);
          const modelDisplay = wsEl.querySelector("[data-model-display]");
          if (modelDisplay) {
            throw new Error("Expected intermediate status to disappear after stream end");
          }
        },
        { timeout: 10_000 }
      );
    } finally {
      collector.stop();
      await app.dispose();
    }
  }, 60_000);
});
