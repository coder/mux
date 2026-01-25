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

import { fireEvent } from "@testing-library/react";
import { createAppHarness } from "./harness";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

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

  test("auto-compacts after context_exceeded and resumes", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    try {
      const triggerMessage = "Trigger context error";
      const userDraft = "My draft message that should be preserved";

      await app.chat.send(triggerMessage);

      // User starts typing while auto-compaction is in progress
      await app.chat.typeWithoutSending(userDraft);

      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);
      await app.chat.expectTranscriptContains(`Continue with: ${triggerMessage}`, 60_000);
      await app.chat.expectTranscriptContains(`Mock response: ${triggerMessage}`, 60_000);

      // Verify user's draft was NOT overwritten by auto-compaction
      await app.chat.expectInputValue(userDraft);
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

  test("/compact command sends any foreground bash to background", async () => {
    const app = await createAppHarness({ branchPrefix: "compaction-ui" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);

      const toolCallId = "bash-foreground-compact";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash for compact",
        "foreground bash for compact",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      // Ensure the UI's subscription has observed the foreground bash before sending /compact.
      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const seedMessage = "Seed conversation for /compact test";

      const seedResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: seedMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      // Send /compact command via the UI (like a user would)
      await app.chat.send("/compact -t 500");

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
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
      });
      expect(seedResult.success).toBe(true);
      await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);

      const triggerResult = await app.env.orpc.workspace.sendMessage({
        workspaceId: app.workspaceId,
        message: triggerMessage,
        options: { model: WORKSPACE_DEFAULTS.model, agentId: WORKSPACE_DEFAULTS.agentId },
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

describe("Compaction notification behavior (mock AI router)", () => {
  const notifications: Array<{ title: string; body?: string }> = [];
  let originalWindowNotification: unknown;

  beforeAll(async () => {
    await preloadTestModules();
    originalWindowNotification = (globalThis as { Notification?: unknown }).Notification;
  });

  beforeEach(() => {
    notifications.length = 0;

    // Mock Notification constructor - must be on globalThis since happy-dom
    // aliases window = globalThis in our test setup
    class MockNotification {
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        notifications.push({ title, body: options?.body });
      }
      close() {}
    }

    const mockWithPermission = Object.assign(MockNotification, {
      permission: "granted",
      requestPermission: () => Promise.resolve("granted" as NotificationPermission),
    });
    (globalThis as { Notification: unknown }).Notification = mockWithPermission;
  });

  afterEach(() => {
    if (originalWindowNotification !== undefined) {
      (globalThis as { Notification?: unknown }).Notification = originalWindowNotification;
    } else {
      delete (globalThis as { Notification?: unknown }).Notification;
    }
  });

  /** Set up harness with notification mocks, send seed message, return cleanup + count */
  async function setupNotificationTest(seedMessage: string) {
    const app = await createAppHarness({ branchPrefix: "compact-notify" });

    // Mock document.hasFocus AFTER harness creates the DOM window
    // Happy-dom's hasFocus returns !!this.activeElement - clear it to return false
    const originalActiveElement = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(globalThis.document),
      "activeElement"
    );
    Object.defineProperty(globalThis.document, "activeElement", {
      get: () => null,
      configurable: true,
    });

    // Set Notification on the happy-dom window
    (window as { Notification: unknown }).Notification = (
      globalThis as { Notification: unknown }
    ).Notification;

    // Enable notifications via UI (click bell button in workspace header)
    const notifyButton = app.view.container.querySelector(
      '[data-testid="notify-on-response-button"]'
    );
    if (!notifyButton) throw new Error("Notify button not found");
    fireEvent.click(notifyButton);

    // Send seed message and wait for notification
    await app.chat.send(seedMessage);
    await app.chat.expectTranscriptContains(`Mock response: ${seedMessage}`);
    await waitFor(() => expect(notifications.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });

    const countAfterSeed = notifications.length;
    expect(countAfterSeed).toBe(1);

    const cleanup = async () => {
      if (originalActiveElement) {
        Object.defineProperty(globalThis.document, "activeElement", originalActiveElement);
      }
      await app.dispose();
    };

    return { app, countAfterSeed, cleanup };
  }

  /** Wait for new notifications after seed, return count and last notification */
  async function waitForNewNotifications(countAfterSeed: number) {
    await waitFor(() => expect(notifications.length).toBeGreaterThanOrEqual(countAfterSeed + 1), {
      timeout: 5_000,
    });
    return {
      newCount: notifications.length - countAfterSeed,
      last: notifications[notifications.length - 1],
    };
  }

  test("compaction with continue message should fire only ONE notification (for continue response)", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for notification test"
    );
    const continueText = "Continue after compaction";

    try {
      // Send /compact with continue - should NOT fire for compaction, only for continue
      await app.chat.send(`/compact -t 500\n${continueText}`);
      await app.chat.expectTranscriptContains("Mock compaction summary:");
      await app.chat.expectTranscriptContains(`Mock response: ${continueText}`);

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toContain(`Mock response: ${continueText}`);
      expect(last.body).not.toBe("Compaction complete");
    } finally {
      await cleanup();
    }
  }, 60_000);

  test("compaction without continue message should fire notification with 'Compaction complete'", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for standalone compaction"
    );

    try {
      await app.chat.send("/compact -t 500");
      await app.chat.expectTranscriptContains("Mock compaction summary:");

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toBe("Compaction complete");
    } finally {
      await cleanup();
    }
  }, 60_000);

  // Note: Force compaction interrupts an active stream. In the real backend, this would send
  // a stream-abort event and the interrupted stream would NOT trigger a notification.
  // However, the mock AI completes streams normally (no mid-stream abort simulation),
  // so the "interrupted" stream's completion still fires a notification.
  test.skip("force compaction with auto-continue should fire only ONE notification", async () => {
    const { app, countAfterSeed, cleanup } = await setupNotificationTest(
      "Seed for force compaction"
    );

    try {
      // Force compaction auto-generates a "Continue" message
      await app.chat.send("[force] Trigger force compaction");
      await app.chat.expectTranscriptContains("Mock compaction summary:", 60_000);
      await app.chat.expectTranscriptContains("Mock response: Continue", 60_000);

      const { newCount, last } = await waitForNewNotifications(countAfterSeed);
      expect(newCount).toBe(1);
      expect(last.body).toBe("Mock response: Continue");
    } finally {
      await cleanup();
    }
  }, 60_000);
});
