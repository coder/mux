import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules, type TestEnvironment } from "../../ipc/setup";

import { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";

import { createAppHarness } from "../harness";

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

  test("keyboard send modes still control foreground bash behavior", async () => {
    const app = await createAppHarness({ branchPrefix: "send-mode-keybinds" });

    let unregisterTurn: (() => void) | undefined;
    let unregisterStep: (() => void) | undefined;

    try {
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

      const turnEndMessage = "turn-end test";
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
