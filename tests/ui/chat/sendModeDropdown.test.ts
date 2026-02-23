import "../dom";
import { act, fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";
import { getReviewsKey } from "@/common/constants/storage";
import type { ReviewsState } from "@/common/types/review";
import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

import { createAppHarness, type AppHarness } from "../harness";

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
  let iterator: AsyncIterator<{ foregroundToolCallIds: string[] }> | null = null;

  try {
    const subscribedIterator = await env.orpc.workspace.backgroundBashes.subscribe(
      { workspaceId },
      { signal: controller.signal }
    );

    iterator = subscribedIterator;

    for await (const state of subscribedIterator) {
      if (state.foregroundToolCallIds.includes(toolCallId)) {
        return;
      }
    }

    throw new Error("backgroundBashes.subscribe ended before foreground bash was observed");
  } finally {
    controller.abort();
    void iterator?.return?.();
  }
}

function getSendModeButton(container: HTMLElement): HTMLButtonElement | null {
  const buttons = Array.from(
    container.querySelectorAll('button[aria-label="Send mode options"]')
  ) as HTMLButtonElement[];

  // Multiple ChatInput instances can be mounted; the active workspace input is the last one.
  return buttons.at(-1) ?? null;
}

function getSendModeTrigger(container: HTMLElement): HTMLButtonElement | null {
  const button = getSendModeButton(container);
  if (!button || button.disabled) {
    return null;
  }

  return button;
}

async function waitForSendModeTrigger(container: HTMLElement): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const trigger = getSendModeTrigger(container);
      if (!trigger) {
        throw new Error("Send mode trigger is not visible");
      }
      return trigger;
    },
    { timeout: 30_000 }
  );
}

async function openSendModeMenu(container: HTMLElement): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const trigger = await waitForSendModeTrigger(container);
    act(() => {
      fireEvent.click(trigger);
    });

    try {
      await waitFor(
        () => {
          const expandedTrigger = container.querySelector(
            'button[aria-label="Send mode options"][aria-expanded="true"]'
          );
          if (!expandedTrigger) {
            throw new Error("Send mode menu did not open");
          }
        },
        { timeout: 2_000 }
      );
      return;
    } catch (error) {
      if (error instanceof Error) {
        lastError = error;
      } else {
        lastError = new Error("Send mode menu did not open");
      }
    }
  }

  throw lastError ?? new Error("Send mode menu did not open");
}

async function waitForCanInterrupt(workspaceId: string, expected: boolean): Promise<void> {
  await waitFor(
    () => {
      const state = workspaceStore.getWorkspaceSidebarState(workspaceId);
      if (state.canInterrupt !== expected) {
        throw new Error(`Expected canInterrupt=${expected}, got ${state.canInterrupt}`);
      }
    },
    { timeout: 30_000 }
  );
}

async function getActiveTextarea(container: HTMLElement): Promise<HTMLTextAreaElement> {
  return waitFor(
    () => {
      const textareas = Array.from(
        container.querySelectorAll('textarea[aria-label="Message Claude"]')
      ) as HTMLTextAreaElement[];
      if (textareas.length === 0) {
        throw new Error("Chat textarea not found");
      }

      const enabled = [...textareas].reverse().find((textarea) => !textarea.disabled);
      if (!enabled) {
        throw new Error("Chat textarea is disabled");
      }

      return enabled;
    },
    { timeout: 10_000 }
  );
}

async function startStreamingTurn(app: AppHarness, label: string): Promise<void> {
  // Use a long mock echo payload so canInterrupt stays true long enough for dropdown interactions.
  const longStreamingTail = " keep-streaming".repeat(600);
  await app.chat.send(`[mock:wait-start] ${label}${longStreamingTail}`);
  app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
  await waitForCanInterrupt(app.workspaceId, true);
}

describe("SendModeDropdown (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("dropdown trigger is visible but disabled when not streaming", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-dropdown" });

    try {
      const trigger = getSendModeButton(app.view.container);
      expect(trigger).not.toBeNull();
      expect(trigger?.disabled).toBe(true);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("dropdown trigger visible while streaming", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-dropdown" });

    try {
      await startStreamingTurn(app, "show send mode trigger while streaming");

      const disabledTrigger = await waitFor(
        () => {
          const trigger = getSendModeButton(app.view.container);
          if (!trigger) {
            throw new Error("Send mode trigger is not visible");
          }
          return trigger;
        },
        { timeout: 30_000 }
      );
      expect(disabledTrigger.disabled).toBe(true);

      await app.chat.typeWithoutSending("enable send mode dropdown");
      await waitForSendModeTrigger(app.view.container);

      await app.chat.expectStreamComplete(60_000);

      await waitFor(
        () => {
          const trigger = getSendModeButton(app.view.container);
          expect(trigger).not.toBeNull();
          expect(trigger?.disabled).toBe(true);
        },
        { timeout: 30_000 }
      );
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("dropdown menu shows labels and keybind chips", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-dropdown" });

    try {
      await startStreamingTurn(app, "open send mode dropdown menu");
      await app.chat.typeWithoutSending("open send mode menu");

      await openSendModeMenu(app.view.container);

      const stepRow = await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after step"));
          if (!row) {
            throw new Error("Send after step row not found");
          }
          return row;
        },
        { timeout: 30_000 }
      );

      const turnRow = await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (!row) {
            throw new Error("Send after turn row not found");
          }
          return row;
        },
        { timeout: 30_000 }
      );

      expect(stepRow.querySelector("kbd")).not.toBeNull();
      expect(turnRow.querySelector("kbd")).not.toBeNull();

      const keybindChips = app.view.container.querySelectorAll("kbd");
      expect(keybindChips.length).toBeGreaterThanOrEqual(2);

      await app.chat.expectStreamComplete(60_000);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("send-after-turn does NOT auto-background foreground bash", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-dropdown" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);
      const toolCallId = "bash-foreground-send-after-turn";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash for send-after-turn",
        "foreground bash for send-after-turn",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const turnEndMessage = "turn-end test";
      await app.chat.typeWithoutSending(turnEndMessage);
      const textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await app.chat.expectTranscriptContains(`Mock response: ${turnEndMessage}`);
      await app.chat.expectStreamComplete();

      expect(backgrounded).toBe(false);
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 60_000);

  test("send-after-step still auto-backgrounds foreground bash", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-dropdown" });

    let unregister: (() => void) | undefined;

    try {
      const manager = getBackgroundProcessManager(app.env);
      const toolCallId = "bash-foreground-send-after-step";
      let backgrounded = false;

      const registration = manager.registerForegroundProcess(
        app.workspaceId,
        toolCallId,
        "echo foreground bash for send-after-step",
        "foreground bash for send-after-step",
        () => {
          backgrounded = true;
          unregister?.();
        }
      );

      unregister = registration.unregister;

      await waitForForegroundToolCallId(app.env, app.workspaceId, toolCallId);

      const toolEndMessage = "tool-end test";
      await app.chat.typeWithoutSending(toolEndMessage);
      const textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter" });

      await app.chat.expectTranscriptContains(`Mock response: ${toolEndMessage}`);

      await waitFor(
        () => {
          expect(backgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );

      await app.chat.expectStreamComplete();
    } finally {
      unregister?.();
      await app.dispose();
    }
  }, 60_000);

  test("dropdown enabled with review-only draft during streaming (no typed text)", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-dropdown" });

    try {
      await startStreamingTurn(app, "review-only dropdown enablement");

      // Verify dropdown is disabled with no content
      const disabledTrigger = getSendModeButton(app.view.container);
      expect(disabledTrigger).not.toBeNull();
      expect(disabledTrigger?.disabled).toBe(true);

      // Seed an attached review via persisted state (useReviews listens cross-component)
      act(() => {
        updatePersistedState<ReviewsState>(getReviewsKey(app.workspaceId), {
          workspaceId: app.workspaceId,
          reviews: {
            "review-1": {
              id: "review-1",
              status: "attached",
              createdAt: Date.now(),
              data: {
                filePath: "src/example.ts",
                lineRange: "+1",
                selectedCode: "const x = 1;",
                userNote: "Check this",
              },
            },
          },
          lastUpdated: Date.now(),
        });
      });

      // Dropdown should become enabled — canSend is true via review, canInterrupt is true via stream
      const enabledTrigger = await waitForSendModeTrigger(app.view.container);
      expect(enabledTrigger.disabled).toBe(false);

      await app.chat.expectStreamComplete(60_000);
    } finally {
      await app.dispose();
    }
  }, 60_000);
});
