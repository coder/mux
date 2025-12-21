import { waitFor } from "@storybook/test";

/**
 * Wait for chat messages to finish loading.
 *
 * Waits for data-loaded="true" on the message window, then one RAF
 * to let any pending coalesced scroll from useAutoScroll complete.
 */
export async function waitForChatMessagesLoaded(canvasElement: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const messageWindow = canvasElement.querySelector('[data-testid="message-window"]');
      if (!messageWindow || messageWindow.getAttribute("data-loaded") !== "true") {
        throw new Error("Messages not loaded yet");
      }
    },
    { timeout: 5000 }
  );

  // One RAF to let any pending coalesced scroll complete
  await new Promise((r) => requestAnimationFrame(r));
}

export async function waitForChatInputAutofocusDone(canvasElement: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const state = canvasElement
        .querySelector('[data-component="ChatInputSection"]')
        ?.getAttribute("data-autofocus-state");
      if (state !== "done") {
        throw new Error("ChatInput auto-focus not finished");
      }
    },
    { timeout: 5000 }
  );
}

export function blurActiveElement(): void {
  (document.activeElement as HTMLElement | null)?.blur?.();
}
