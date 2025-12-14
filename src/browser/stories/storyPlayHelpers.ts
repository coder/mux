import { waitFor } from "@storybook/test";

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
