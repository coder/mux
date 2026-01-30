/**
 * Integration tests for stream interruption UI behavior.
 *
 * Tests verify that:
 * - User-initiated interrupts (Ctrl+C/Escape) do NOT show warning RetryBarrier
 *
 * Note: The error-case UI behavior (showing RetryBarrier for network errors) is covered
 * by unit tests in retryEligibility.test.ts. Testing it in UI integration tests is
 * complex due to timing issues with the mock AI router error handling.
 */

import "./dom";
import { waitFor } from "@testing-library/react";

import { preloadTestModules } from "../ipc/setup";
import { createAppHarness } from "./harness";

describe("Stream Interrupt UI (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("user-initiated interrupt hides RetryBarrier warning", async () => {
    const app = await createAppHarness({ branchPrefix: "stream-interrupt" });

    try {
      // Send a message to start streaming
      // The mock router will respond with "Mock response: <message>"
      await app.chat.send("Test message for interrupt");

      // Wait for response to complete
      await app.chat.expectTranscriptContains("Mock response:", 30_000);

      // Now send another message to trigger a new stream, then immediately interrupt it
      // This creates a partial message state with lastAbortReason="user"
      const interruptMessage = "Message to interrupt";

      // Start the message but don't wait for completion
      const sendPromise = app.chat.send(interruptMessage);

      // Give the stream a moment to start
      await new Promise((r) => setTimeout(r, 200));

      // Interrupt the stream (simulating user pressing Escape)
      // This should set lastAbortReason to "user"
      await app.env.orpc.workspace.interruptStream({
        workspaceId: app.workspaceId,
      });

      // Wait for the send to complete (it will fail/abort)
      await sendPromise.catch(() => {
        // Expected - message send was interrupted
      });

      // Give UI time to update
      await new Promise((r) => setTimeout(r, 500));

      // Verify: The warning RetryBarrier should NOT be visible
      // RetryBarrier shows "Stream interrupted" text with a Retry button
      // For user-initiated interrupts, we should NOT see "Stream interrupted" (which is from RetryBarrier)
      await waitFor(
        () => {
          const text = app.view.container.textContent ?? "";
          // RetryBarrier specifically shows "Stream interrupted" (with capital S)
          expect(text).not.toContain("Stream interrupted");
        },
        { timeout: 5_000 }
      );

      // Also verify no Retry button is present (RetryBarrier shows a Retry button)
      const buttons = Array.from(app.view.container.querySelectorAll("button"));
      const retryButton = buttons.find((btn) => btn.textContent?.includes("Retry"));
      expect(retryButton).toBeUndefined();
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
