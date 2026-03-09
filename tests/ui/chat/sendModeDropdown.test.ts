import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";

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
  // Keep stream alive so queued-send mode chooser can be used.
  const longStreamingTail = " keep-streaming".repeat(600);
  await app.chat.send(`[mock:wait-start] ${label}${longStreamingTail}`);
  app.env.services.aiService.releaseMockStreamStartGate(app.workspaceId);
}

async function waitForSendModeMenuTrigger(container: HTMLElement): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const buttons = Array.from(
        container.querySelectorAll('button[aria-label="Send message"]')
      ) as HTMLButtonElement[];
      const trigger = [...buttons]
        .reverse()
        .find((button) => button.getAttribute("aria-haspopup") === "menu" && !button.disabled);
      if (!trigger) {
        throw new Error("Send mode menu trigger not ready");
      }
      return trigger;
    },
    { timeout: 30_000 }
  );
}

async function openSendModeMenu(container: HTMLElement): Promise<void> {
  const trigger = await waitForSendModeMenuTrigger(container);
  fireEvent.contextMenu(trigger, { clientX: 12, clientY: 12 });

  await waitFor(
    () => {
      const row = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Send after turn")
      );
      if (!row) {
        throw new Error("Send mode menu did not open");
      }
    },
    { timeout: 30_000 }
  );
}

describe("Send dispatch modes (mock AI router)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("does not render a send mode caret trigger next to the send button", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-tooltip" });

    try {
      const modeTrigger = app.view.container.querySelector(
        'button[aria-label="Send mode options"]'
      );
      expect(modeTrigger).toBeNull();
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("click sends tool-end by default while context menu + keybind dispatch modes remain", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-pointer" });

    let unregisterTurn: (() => void) | undefined;
    let unregisterStep: (() => void) | undefined;

    try {
      const idleTurnMessage = "turn-end idle context-menu test";
      await app.chat.typeWithoutSending(idleTurnMessage);
      await openSendModeMenu(app.view.container);

      const idleTurnRow = await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (!row) {
            throw new Error("Send after turn row not found for idle context menu");
          }
          return row;
        },
        { timeout: 30_000 }
      );
      fireEvent.click(idleTurnRow);

      await app.chat.expectTranscriptContains(`Mock response: ${idleTurnMessage}`);
      await app.chat.expectStreamComplete();

      await startStreamingTurn(app, "click send while streaming");

      const clickStepMessage = "tool-end click test";
      await app.chat.typeWithoutSending(clickStepMessage);
      const sendButton = await waitForSendModeMenuTrigger(app.view.container);
      fireEvent.click(sendButton);

      await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (row) {
            throw new Error("Left-clicking Send should not open send mode menu");
          }
        },
        { timeout: 5_000 }
      );

      await app.chat.expectTranscriptContains(`Mock response: ${clickStepMessage}`);
      await app.chat.expectStreamComplete();

      await startStreamingTurn(app, "open send mode menu while streaming");

      const pointerTurnMessage = "turn-end pointer test";
      await app.chat.typeWithoutSending(pointerTurnMessage);
      await openSendModeMenu(app.view.container);

      fireEvent.keyDown(document, { key: "Escape" });

      await waitFor(
        () => {
          const rows = Array.from(app.view.container.querySelectorAll("button"));
          const row = rows.find((button) => button.textContent?.includes("Send after turn"));
          if (row) {
            throw new Error("Send mode menu should close on Escape");
          }
        },
        { timeout: 30_000 }
      );

      // Re-open after Escape: if Escape interrupted the stream, this menu cannot open.
      await openSendModeMenu(app.view.container);

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
      fireEvent.click(turnRow);

      await app.chat.expectTranscriptContains(`Mock response: ${pointerTurnMessage}`);
      await app.chat.expectStreamComplete();

      const manager = getBackgroundProcessManager(app.env);

      const turnToolCallId = "bash-foreground-send-after-turn";
      let turnBackgrounded = false;

      const turnRegistration = manager.registerForegroundProcess(
        app.workspaceId,
        turnToolCallId,
        "echo foreground bash for send-after-turn",
        "foreground bash for send-after-turn",
        () => {
          turnBackgrounded = true;
          unregisterTurn?.();
        }
      );

      unregisterTurn = turnRegistration.unregister;

      await waitForForegroundToolCallId(app.env, app.workspaceId, turnToolCallId);

      const turnEndMessage = "turn-end keyboard test";
      await app.chat.typeWithoutSending(turnEndMessage);
      let textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });

      await app.chat.expectTranscriptContains(`Mock response: ${turnEndMessage}`);
      await app.chat.expectStreamComplete();
      expect(turnBackgrounded).toBe(false);

      const stepToolCallId = "bash-foreground-send-after-step";
      let stepBackgrounded = false;

      const stepRegistration = manager.registerForegroundProcess(
        app.workspaceId,
        stepToolCallId,
        "echo foreground bash for send-after-step",
        "foreground bash for send-after-step",
        () => {
          stepBackgrounded = true;
          unregisterStep?.();
        }
      );

      unregisterStep = stepRegistration.unregister;

      await waitForForegroundToolCallId(app.env, app.workspaceId, stepToolCallId);

      const stepEndMessage = "tool-end test";
      await app.chat.typeWithoutSending(stepEndMessage);
      textarea = await getActiveTextarea(app.view.container);
      fireEvent.keyDown(textarea, { key: "Enter" });

      await app.chat.expectTranscriptContains(`Mock response: ${stepEndMessage}`);
      await waitFor(
        () => {
          expect(stepBackgrounded).toBe(true);
        },
        { timeout: 60_000 }
      );
      await app.chat.expectStreamComplete();
    } finally {
      unregisterTurn?.();
      unregisterStep?.();
      await app.dispose();
    }
  }, 60_000);
});
