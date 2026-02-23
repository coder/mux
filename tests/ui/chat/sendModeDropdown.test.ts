import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";

import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

import { createAppHarness, type AppHarness } from "../harness";
import { workspaceStore } from "@/browser/stores/WorkspaceStore";

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

  return buttons[0] ?? null;
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
  await app.chat.send(`[mock:wait-start] [force] ${label}`);
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

      const trigger = await waitForSendModeTrigger(app.view.container);
      fireEvent.click(trigger);

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
});
