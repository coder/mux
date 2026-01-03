/**
 * UI integration tests for compaction flows.
 *
 * Goal: validate UI logic <-> backend integration without relying on real LLMs.
 *
 * These tests run with the mock AI router enabled via createAppHarness().
 */

import { waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../ipc/setup";

import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

import { createAppHarness } from "./harness";

interface ServiceContainerPrivates {
  backgroundProcessManager: BackgroundProcessManager;
}

function getBackgroundProcessManager(env: TestEnvironment): BackgroundProcessManager {
  return (env.services as unknown as ServiceContainerPrivates).backgroundProcessManager;
}

async function waitForForegroundToolCallId(
  env: TestEnvironment,
  workspaceId: string,
  toolCallId: string
): Promise<void> {
  const controller = new AbortController();

  try {
    const iterator = await env.orpc.workspace.backgroundBashes.subscribe(
      { workspaceId },
      { signal: controller.signal }
    );

    for await (const state of iterator) {
      if (state.foregroundToolCallIds.includes(toolCallId)) {
        return;
      }
    }

    throw new Error("backgroundBashes.subscribe ended before foreground bash was observed");
  } finally {
    controller.abort();
  }
}

describe("Compaction UI (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("manual /compact with continue message auto-sends after compaction", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const seedMessage = "Seed conversation for compaction";
      const continueText = "Continue after manual compaction";

      await app.chat.send(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      await app.chat.send(`/compact -t 500\n${continueText}`);

      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectTranscriptContains(`Mock response: ${continueText}`);

      // Compaction should replace all previous history.
      await app.chat.expectTranscriptNotContains(seedMessage);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("force compaction triggers during streaming and resumes with Continue", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const seedMessage = "Seed conversation for compaction";
      const triggerMessage = "[force] Trigger force compaction";

      await app.chat.send(seedMessage);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      await app.chat.send(triggerMessage);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);
      await app.chat.expectTranscriptContains("Mock response: Continue", 60_000);

      // Force-compaction should have cleared the triggering message from history.
      await app.chat.expectTranscriptNotContains(triggerMessage, 60_000);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("force compaction sends any foreground bash to background", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash",
        "foreground bash",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before streaming starts.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for compaction";
      const triggerMessage = "[force] Trigger force compaction";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      const triggerResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: triggerMessage,
      });
      expect(triggerResult.success).toBe(true);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);

      await waitFor(
        () => {
          expect(backgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 60_000);
});
